import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { generatePairedSchedule } from "@/server/rule-engine/generate-paired-schedule";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import {
  lockEligibleRegularPairs,
  lockEligibleRegularPhysicalExams,
  markDisplacedAppointmentsAwaitingResolution,
  markDisplacedAppointmentsRescheduled,
  type DisplacementCandidate,
} from "@/server/repositories/priority-displacement.repository";
import { loadSchedulingBlockedDates } from "@/server/repositories/scheduling-blocked-dates.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAwaitingResolutionNotification,
  buildPriorityDisplacementNotification,
} from "@/server/schedule/schedule-notifications";
import { resolveAutomaticReplacementBounds } from "@/server/scheduling/automatic-replacement-bounds";

export function priorityDisplacementScopes(candidates: DisplacementCandidate[]) {
  return candidates.flatMap((candidate) => (
    candidate.displacementType === "PAIR"
      ? [
          { studentNumber: candidate.studentNumber, scheduleType: "LABORATORY" },
          { studentNumber: candidate.studentNumber, scheduleType: "PHYSICAL_EXAM" },
        ]
      : [{ studentNumber: candidate.studentNumber, scheduleType: "PHYSICAL_EXAM" }]
  ));
}

export async function planCapacityForPriorityBatch(
  input: {
    scheduleCycleStart: number;
    windowStart: string;
    windowEnd: string;
    neededPairCount: number;
  },
  client: PoolClient,
) {
  return lockEligibleRegularPairs(client, {
    scheduleCycleStart: input.scheduleCycleStart,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    limit: input.neededPairCount,
  });
}

export async function planPhysicalExamCapacityForPriorityBatch(
  input: {
    scheduleCycleStart: number;
    windowEnd: string;
    physicalExamNotBeforeDates: string[];
    excludedPhysicalExamIds?: string[];
  },
  client: PoolClient,
) {
  const candidates: DisplacementCandidate[] = [];
  const latestLaboratoryConstraintsFirst = [...input.physicalExamNotBeforeDates]
    .sort((left, right) => right.localeCompare(left));
  for (const windowStart of latestLaboratoryConstraintsFirst) {
    const [candidate] = await lockEligibleRegularPhysicalExams(client, {
      scheduleCycleStart: input.scheduleCycleStart,
      windowStart,
      windowEnd: input.windowEnd,
      limit: 1,
      excludedPhysicalExamIds: [
        ...(input.excludedPhysicalExamIds ?? []),
        ...candidates.map((candidate) => candidate.physicalExamAppointmentId),
      ],
    });
    if (!candidate) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export async function publishDisplacedRegularReplacementsWithLockedScopes(
  input: {
    candidates: DisplacementCandidate[];
    sourceImportGroupId: string;
    actorUserId: string;
  },
  client: PoolClient,
) {
  if (!input.candidates.length) return [];
  const today = await client.query<{ manila_today: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS manila_today",
  );
  const boundedCandidates = input.candidates.map((candidate) => ({
    candidate,
    bounds: resolveAutomaticReplacementBounds({
      replacementType: candidate.displacementType,
      originalWindowStart: candidate.schedulingWindowStart,
      manilaToday: today.rows[0].manila_today,
      cycleClosingDate: candidate.scheduleCycleClosingDate,
      laboratoryDate: candidate.displacementType === "PHYSICAL_EXAM_ONLY"
        ? candidate.laboratoryDate
        : undefined,
    }),
  }));
  const replacementWindowStart = boundedCandidates
    .map(({ bounds }) => bounds.lowerBound)
    .sort()[0];
  const searchEndDate = boundedCandidates
    .map(({ bounds }) => bounds.upperBound)
    .sort()
    .at(-1)!;
  const capacities = await client.query<{
    clinic_id: string;
    clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    max_daily_capacity: number;
  }>(
    `SELECT setting.clinic_id, clinic.code AS clinic_code, setting.schedule_type,
            setting.max_daily_capacity
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE (clinic.code='KABALAKA_CLINIC' AND setting.schedule_type='LABORATORY')
         OR (clinic.code='CPU_CLINIC' AND setting.schedule_type='PHYSICAL_EXAM')`,
  );
  const byType = new Map(capacities.rows.map((row) => [row.schedule_type, row]));
  const laboratoryCapacity = byType.get("LABORATORY");
  const physicalExamCapacity = byType.get("PHYSICAL_EXAM");
  if (!laboratoryCapacity || !physicalExamCapacity) {
    throw new AppError("SCHEDULE_CAPACITY_NOT_CONFIGURED", "Clinic capacity is not configured.", 409);
  }
  const load = await client.query<{
    clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
    date: string;
    count: number;
  }>(
    `SELECT clinic.code AS clinic_code, appointment.appointment_date::text AS date,
            COUNT(*)::int AS count
       FROM appointments appointment
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
      WHERE appointment.appointment_date BETWEEN $1 AND $2
        AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
        AND NOT (appointment.id = ANY($3::uuid[]))
        AND NOT (
          appointment.schedule_type='LABORATORY'
          AND appointment.ovpsa_batch_id IS NOT NULL
        )
      GROUP BY clinic.code, appointment.appointment_date`,
    [
      replacementWindowStart,
      searchEndDate,
      input.candidates.flatMap((candidate) => candidate.displacementType === "PAIR"
        ? [candidate.laboratoryAppointmentId, candidate.physicalExamAppointmentId]
        : [candidate.physicalExamAppointmentId]),
    ],
  );
  const loadFor = (clinicCode: string): Record<string, number> => Object.fromEntries(
    load.rows.filter((row) => row.clinic_code === clinicCode).map((row) => [row.date, row.count]),
  );
  const laboratoryLoad = loadFor("KABALAKA_CLINIC");
  const physicalExamLoad = loadFor("CPU_CLINIC");
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: replacementWindowStart,
    endDate: searchEndDate,
  });
  const blockedLaboratoryDates = blocked.laboratoryDates;
  const blockedPhysicalExamDates = blocked.physicalExamDates;
  const orderCandidates = (entries: typeof boundedCandidates) => [...entries].sort((left, right) => (
    left.candidate.acceptedAt.getTime() - right.candidate.acceptedAt.getTime()
    || left.candidate.sourceRowOrder - right.candidate.sourceRowOrder
    || left.candidate.studentNumber.localeCompare(right.candidate.studentNumber)
  ));
  const pairAssignments: Array<{
    requestId: string;
    studentNumber: string;
    schedulePairId: string;
    laboratoryDate: string;
    physicalExamDate: string;
  }> = [];
  const fallbackCandidates: DisplacementCandidate[] = [];
  for (const { candidate, bounds } of orderCandidates(
    boundedCandidates.filter(({ candidate }) => candidate.displacementType === "PAIR"),
  )) {
    if (bounds.lowerBound > bounds.upperBound) {
      fallbackCandidates.push(candidate);
      continue;
    }
    const generated = generatePairedSchedule({
      requests: [{
        requestId: `displacement:${candidate.schedulePairId}`,
        studentNumber: candidate.studentNumber,
        category: candidate.schedulingCategory,
        acceptedAt: candidate.acceptedAt.toISOString(),
        sourceRowOrder: candidate.sourceRowOrder,
        windowStart: bounds.lowerBound,
      }],
      laboratoryCapacity: { maxDailyCapacity: laboratoryCapacity.max_daily_capacity },
      physicalExamCapacity: { maxDailyCapacity: physicalExamCapacity.max_daily_capacity },
      existingLaboratoryLoad: laboratoryLoad,
      existingPhysicalExamLoad: physicalExamLoad,
      blockedLaboratoryDates,
      blockedPhysicalExamDates,
      searchEndDate: bounds.upperBound,
    });
    const assignment = generated.assignments[0];
    if (!assignment) {
      fallbackCandidates.push(candidate);
      continue;
    }
    pairAssignments.push({ ...assignment, schedulePairId: candidate.schedulePairId });
    laboratoryLoad[assignment.laboratoryDate] = (laboratoryLoad[assignment.laboratoryDate] ?? 0) + 1;
    physicalExamLoad[assignment.physicalExamDate] = (physicalExamLoad[assignment.physicalExamDate] ?? 0) + 1;
  }
  const physicalExamCeiling = Math.max(0, physicalExamCapacity.max_daily_capacity);
  const blockedPhysicalExamSet = new Set(blockedPhysicalExamDates);
  const physicalExamOnlyAssignments: Array<{
    candidate: DisplacementCandidate;
    physicalExamDate: string;
  }> = [];
  for (const { candidate, bounds } of orderCandidates(
    boundedCandidates.filter(({ candidate }) => candidate.displacementType === "PHYSICAL_EXAM_ONLY"),
  )) {
    const startDate = bounds.lowerBound;
    let physicalExamDate: string | null = null;
    for (let date = startDate; date <= bounds.upperBound; date = addDays(date, 1)) {
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (weekday === 0 || weekday === 6 || blockedPhysicalExamSet.has(date)) continue;
      if ((physicalExamLoad[date] ?? 0) < physicalExamCeiling) {
        physicalExamDate = date;
        physicalExamLoad[date] = (physicalExamLoad[date] ?? 0) + 1;
        break;
      }
    }
    if (!physicalExamDate) {
      fallbackCandidates.push(candidate);
      continue;
    }
    physicalExamOnlyAssignments.push({ candidate, physicalExamDate });
  }
  const successfulCandidateNumbers = new Set([
    ...pairAssignments.map((assignment) => assignment.studentNumber),
    ...physicalExamOnlyAssignments.map(({ candidate }) => candidate.studentNumber),
  ]);
  const successfulCandidates = input.candidates.filter(
    (candidate) => successfulCandidateNumbers.has(candidate.studentNumber),
  );
  await markDisplacedAppointmentsRescheduled(client, successfulCandidates, input.actorUserId);
  await markDisplacedAppointmentsAwaitingResolution(client, fallbackCandidates, input.actorUserId);
  const candidateByStudent = new Map(
    input.candidates.map((candidate) => [candidate.studentNumber, candidate]),
  );
  const policyMetadata = (candidate: DisplacementCandidate) => ({
    studentNumber: candidate.studentNumber,
    sourceImportGroupId: input.sourceImportGroupId,
    displacementType: candidate.displacementType,
    originAppointmentIds: [
      candidate.laboratoryAppointmentId,
      candidate.physicalExamAppointmentId,
    ],
    displacedAppointmentIds: candidate.displacementType === "PAIR"
      ? [candidate.laboratoryAppointmentId, candidate.physicalExamAppointmentId]
      : [candidate.physicalExamAppointmentId],
    schedulePairId: candidate.schedulePairId,
    scheduleCycleStart: candidate.scheduleCycleStart,
    scheduleCycleClosingDate: candidate.scheduleCycleClosingDate,
    schedulingCategory: candidate.schedulingCategory,
    schedulingAcceptedAt: candidate.acceptedAt.toISOString(),
    schedulingSourceRowOrder: candidate.sourceRowOrder,
    schedulingWindowStart: candidate.schedulingWindowStart,
    schedulingWindowEnd: candidate.schedulingWindowEnd,
  });
  const insertReplacements = async (
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM",
    clinicId: string,
    dates: string[],
    oldIds: string[],
  ) => client.query<{
    id: string;
    student_number: string;
    rescheduled_from: string;
  }>(
    `INSERT INTO appointments (
       clinic_id, batch_id, student_number, schedule_type, appointment_date, status,
       is_published, notes, rescheduled_from, created_by, updated_by,
       schedule_pair_id, schedule_cycle_start,scheduling_category,
       scheduling_accepted_at,scheduling_source_row_order,
       scheduling_window_start,scheduling_window_end
     )
     SELECT $1, original.batch_id, fixture.student_number,
            $2, fixture.appointment_date, 'PENDING', TRUE,
            'Automatically rescheduled for priority capacity.', fixture.old_id,
            $3, $3, fixture.schedule_pair_id, fixture.schedule_cycle_start,
            fixture.scheduling_category,fixture.accepted_at,fixture.source_row_order,
            fixture.window_start,fixture.window_end
       FROM UNNEST(
         $4::varchar[], $5::date[], $6::uuid[], $7::uuid[], $8::integer[],
         $9::varchar[], $10::timestamptz[], $11::integer[], $12::date[], $13::date[]
       ) AS fixture(
         student_number,appointment_date,schedule_pair_id,old_id,schedule_cycle_start,
         scheduling_category,accepted_at,source_row_order,window_start,window_end
       )
       JOIN appointments original ON original.id=fixture.old_id
     RETURNING id, student_number, rescheduled_from::text`,
    [
      clinicId,
      scheduleType,
      input.actorUserId,
      pairAssignments.map((assignment) => assignment.studentNumber),
      dates,
      pairAssignments.map((assignment) => assignment.schedulePairId),
      oldIds,
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.scheduleCycleStart),
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.schedulingCategory),
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.acceptedAt),
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.sourceRowOrder),
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.schedulingWindowStart),
      pairAssignments.map((assignment) => candidateByStudent.get(assignment.studentNumber)!.schedulingWindowEnd),
    ],
  );
  const laboratory = await insertReplacements(
    "LABORATORY",
    laboratoryCapacity.clinic_id,
    pairAssignments.map((assignment) => assignment.laboratoryDate),
    pairAssignments.map(
      (assignment) => candidateByStudent.get(assignment.studentNumber)!.laboratoryAppointmentId,
    ),
  );
  const physical = await insertReplacements(
    "PHYSICAL_EXAM",
    physicalExamCapacity.clinic_id,
    pairAssignments.map((assignment) => assignment.physicalExamDate),
    pairAssignments.map(
      (assignment) => candidateByStudent.get(assignment.studentNumber)!.physicalExamAppointmentId,
    ),
  );
  const physicalExamOnly = await client.query<{
    id: string;
    student_number: string;
    rescheduled_from: string;
  }>(
    `INSERT INTO appointments (
       clinic_id, batch_id, student_number, schedule_type, appointment_date, status,
       is_published, notes, rescheduled_from, created_by, updated_by,
       schedule_pair_id, schedule_cycle_start,scheduling_category,
       scheduling_accepted_at,scheduling_source_row_order,
       scheduling_window_start,scheduling_window_end
     )
     SELECT $1, original.batch_id, fixture.student_number,
            'PHYSICAL_EXAM', fixture.appointment_date,
            'PENDING', TRUE, 'Automatically rescheduled for priority capacity.',
            fixture.old_id, $2, $2, fixture.schedule_pair_id, fixture.schedule_cycle_start,
            fixture.scheduling_category,fixture.accepted_at,fixture.source_row_order,
            fixture.window_start,fixture.window_end
       FROM UNNEST(
         $3::varchar[], $4::date[], $5::uuid[], $6::uuid[], $7::integer[],
         $8::varchar[], $9::timestamptz[], $10::integer[], $11::date[], $12::date[]
       ) AS fixture(
         student_number,appointment_date,schedule_pair_id,old_id,schedule_cycle_start,
         scheduling_category,accepted_at,source_row_order,window_start,window_end
       )
       JOIN appointments original ON original.id=fixture.old_id
     RETURNING id, student_number, rescheduled_from::text`,
    [
      physicalExamCapacity.clinic_id,
      input.actorUserId,
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.studentNumber),
      physicalExamOnlyAssignments.map(({ physicalExamDate }) => physicalExamDate),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulePairId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.physicalExamAppointmentId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.scheduleCycleStart),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulingCategory),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.acceptedAt),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.sourceRowOrder),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulingWindowStart),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulingWindowEnd),
    ],
  );
  const newAppointmentIds = [...laboratory.rows, ...physical.rows, ...physicalExamOnly.rows]
    .map((row) => row.id);
  await client.query(
    `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
     SELECT id, NULL, 'PENDING', 'Published automatic priority displacement replacement.', $2
       FROM UNNEST($1::uuid[]) AS fixture(id)`,
    [newAppointmentIds, input.actorUserId],
  );
  const labByStudent = new Map(laboratory.rows.map((row) => [row.student_number, row.id]));
  const peByStudent = new Map(physical.rows.map((row) => [row.student_number, row.id]));
  const pairEvents = await client.query<{ id: string; student_number: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number, schedule_pair_id, cause, source_import_group_id,
       old_laboratory_appointment_id, new_laboratory_appointment_id,
       old_physical_exam_appointment_id, new_physical_exam_appointment_id,
       actor_user_id,schedule_cycle_start,strategy,outcome,policy_metadata
     )
     SELECT fixture.student_number, fixture.schedule_pair_id,
            'PRIORITY_DISPLACEMENT', $1, fixture.old_laboratory_id,
            fixture.new_laboratory_id, fixture.old_physical_id,
            fixture.new_physical_id, $2, fixture.schedule_cycle_start,
            'MOVE_COMPLETE_PAIR','REPLACED',fixture.policy_metadata
       FROM UNNEST(
         $3::varchar[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[],
         $9::integer[], $10::jsonb[]
       ) AS fixture(
         student_number, schedule_pair_id, old_laboratory_id,
         new_laboratory_id, old_physical_id, new_physical_id,
         schedule_cycle_start,policy_metadata
       )
     RETURNING id::text,student_number`,
    [
      input.sourceImportGroupId,
      input.actorUserId,
      pairAssignments.map((assignment) => assignment.studentNumber),
      pairAssignments.map((assignment) => assignment.schedulePairId),
      pairAssignments.map(
        (assignment) => candidateByStudent.get(assignment.studentNumber)!.laboratoryAppointmentId,
      ),
      pairAssignments.map((assignment) => labByStudent.get(assignment.studentNumber)),
      pairAssignments.map(
        (assignment) => candidateByStudent.get(assignment.studentNumber)!.physicalExamAppointmentId,
      ),
      pairAssignments.map((assignment) => peByStudent.get(assignment.studentNumber)),
      pairAssignments.map(
        (assignment) => candidateByStudent.get(assignment.studentNumber)!.scheduleCycleStart,
      ),
      pairAssignments.map(
        (assignment) => JSON.stringify(policyMetadata(candidateByStudent.get(assignment.studentNumber)!)),
      ),
    ],
  );
  const physicalExamOnlyByStudent = new Map(
    physicalExamOnly.rows.map((row) => [row.student_number, row.id]),
  );
  const physicalEvents = await client.query<{ id: string; student_number: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number, schedule_pair_id, cause, source_import_group_id,
       old_laboratory_appointment_id, new_laboratory_appointment_id,
       old_physical_exam_appointment_id, new_physical_exam_appointment_id,
       actor_user_id,schedule_cycle_start,strategy,outcome,policy_metadata
     )
     SELECT fixture.student_number, fixture.schedule_pair_id,
            'PRIORITY_DISPLACEMENT', $1, fixture.laboratory_id,
            fixture.laboratory_id, fixture.old_physical_id,
            fixture.new_physical_id, $2, fixture.schedule_cycle_start,
            'MOVE_PHYSICAL_ONLY','REPLACED',fixture.policy_metadata
       FROM UNNEST(
         $3::varchar[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[],
         $8::integer[], $9::jsonb[]
       ) AS fixture(
         student_number, schedule_pair_id, laboratory_id,
         old_physical_id, new_physical_id,schedule_cycle_start,policy_metadata
       )
     RETURNING id::text,student_number`,
    [
      input.sourceImportGroupId,
      input.actorUserId,
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.studentNumber),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulePairId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.laboratoryAppointmentId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.physicalExamAppointmentId),
      physicalExamOnlyAssignments.map(({ candidate }) => (
        physicalExamOnlyByStudent.get(candidate.studentNumber)
      )),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.scheduleCycleStart),
      physicalExamOnlyAssignments.map(({ candidate }) => JSON.stringify(policyMetadata(candidate))),
    ],
  );
  const eventByStudent = new Map(
    [...pairEvents.rows, ...physicalEvents.rows].map((event) => [
      event.student_number,
      event.id,
    ]),
  );
  for (const assignment of pairAssignments) {
    const previous = candidateByStudent.get(assignment.studentNumber)!;
    await queueAuthoritativeScheduleNotification(
      client,
      assignment.studentNumber,
      (state) => buildPriorityDisplacementNotification({
        state,
        eventId: eventByStudent.get(assignment.studentNumber)!,
        reason: "Priority scheduling displacement",
        previous: {
          laboratory: { date: previous.laboratoryDate, location: "KABALAKA Clinic" },
          physicalExam: { date: previous.physicalExamDate, location: "CPU Clinic" },
        },
      }),
    );
  }
  for (const { candidate } of physicalExamOnlyAssignments) {
    await queueAuthoritativeScheduleNotification(
      client,
      candidate.studentNumber,
      (state) => buildPriorityDisplacementNotification({
        state,
        eventId: eventByStudent.get(candidate.studentNumber)!,
        reason: "Priority scheduling displacement",
        previous: {
          laboratory: { date: candidate.laboratoryDate, location: "KABALAKA Clinic" },
          physicalExam: { date: candidate.physicalExamDate, location: "CPU Clinic" },
        },
      }),
    );
  }
  for (const candidate of fallbackCandidates) {
    const metadata = policyMetadata(candidate);
    const manualCase = await client.query<{ id: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,case_source,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
         reason_code,reason_message,policy_metadata
       ) VALUES ($1,'AUTOMATIC_DISPLACEMENT',NULL,$2,$3,$4,$5,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',$6,$7::jsonb)
       RETURNING id::text`,
      [
        candidate.studentNumber,
        candidate.schedulePairId,
        candidate.scheduleCycleStart,
        candidate.laboratoryAppointmentId,
        candidate.physicalExamAppointmentId,
        "No valid automatic replacement is available within the current scheduling cycle.",
        JSON.stringify({
          ...metadata,
          affectedAppointmentIds: metadata.displacedAppointmentIds,
        }),
      ],
    );
    await client.query(
      `INSERT INTO appointment_reschedule_events (
         student_number,schedule_pair_id,cause,source_import_group_id,
         old_laboratory_appointment_id,old_physical_exam_appointment_id,
         actor_user_id,schedule_cycle_start,strategy,outcome,manual_case_id,
         policy_reason_code,policy_metadata
       ) VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,$5,$6,$7,
                 'MANUAL_RESOLUTION_REQUIRED','AWAITING_RESCHEDULE',$8,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',$9::jsonb)`,
      [
        candidate.studentNumber,
        candidate.schedulePairId,
        input.sourceImportGroupId,
        candidate.laboratoryAppointmentId,
        candidate.physicalExamAppointmentId,
        input.actorUserId,
        candidate.scheduleCycleStart,
        manualCase.rows[0].id,
        JSON.stringify(metadata),
      ],
    );
    await queueAuthoritativeScheduleNotification(
      client,
      candidate.studentNumber,
      (state) => buildAwaitingResolutionNotification({
        state,
        eventId: manualCase.rows[0].id,
        sourceType: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE",
        reason: "No valid automatic replacement is available within the current scheduling cycle.",
        previous: {
          laboratory: { date: candidate.laboratoryDate, location: "KABALAKA Clinic" },
          physicalExam: { date: candidate.physicalExamDate, location: "CPU Clinic" },
        },
      }),
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'PRIORITY_DISPLACEMENT_MANUAL_RESOLUTION_REQUIRED',
               'clinic_closure_manual_case',$2,$3::jsonb)`,
      [input.actorUserId, manualCase.rows[0].id, JSON.stringify(metadata)],
    );
  }
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'PRIORITY_DISPLACEMENT_APPLIED', 'schedule_import_group', $2,
             jsonb_build_object(
               'displacedStudentCount',$3::int,
               'automaticReplacementCount',$4::int,
               'manualResolutionCount',$5::int
             ))`,
    [
      input.actorUserId,
      input.sourceImportGroupId,
      input.candidates.length,
      successfulCandidates.length,
      fallbackCandidates.length,
    ],
  );
  return [
    ...pairAssignments,
    ...physicalExamOnlyAssignments.map(({ candidate, physicalExamDate }) => ({
      requestId: `displacement:${candidate.schedulePairId}:physical-exam`,
      studentNumber: candidate.studentNumber,
      schedulePairId: candidate.schedulePairId,
      laboratoryDate: candidate.laboratoryDate,
      physicalExamDate,
    })),
  ];
}

export async function publishDisplacedRegularReplacements(
  input: {
    candidates: DisplacementCandidate[];
    sourceImportGroupId: string;
    actorUserId: string;
  },
  client: PoolClient,
) {
  await lockEffectiveAppointmentScopes(client, priorityDisplacementScopes(input.candidates));
  return publishDisplacedRegularReplacementsWithLockedScopes(input, client);
}

export const nextDateAfter = (date: string) => addDays(date, 1);
