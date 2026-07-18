import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { generatePairedSchedule } from "@/server/rule-engine/generate-paired-schedule";
import {
  lockEligibleRegularPairs,
  lockEligibleRegularPhysicalExams,
  markDisplacedAppointmentsRescheduled,
  type DisplacementCandidate,
} from "@/server/repositories/priority-displacement.repository";
import { createStudentNotification } from "@/server/services/student-notifications.service";

export async function makeCapacityForPriorityBatch(
  input: {
    scheduleCycleStart: number;
    windowStart: string;
    windowEnd: string;
    neededPairCount: number;
    actorUserId: string;
  },
  client: PoolClient,
) {
  const candidates = await lockEligibleRegularPairs(client, {
    scheduleCycleStart: input.scheduleCycleStart,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    limit: input.neededPairCount,
  });
  await markDisplacedAppointmentsRescheduled(client, candidates, input.actorUserId);
  return candidates;
}

export async function makePhysicalExamCapacityForPriorityBatch(
  input: {
    scheduleCycleStart: number;
    windowEnd: string;
    physicalExamNotBeforeDates: string[];
    actorUserId: string;
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
    });
    if (!candidate) continue;
    await markDisplacedAppointmentsRescheduled(client, [candidate], input.actorUserId);
    candidates.push(candidate);
  }
  return candidates;
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export async function publishDisplacedRegularReplacements(
  input: {
    candidates: DisplacementCandidate[];
    sourceImportGroupId: string;
    actorUserId: string;
    replacementWindowStart: string;
    searchEndDate: string;
  },
  client: PoolClient,
) {
  if (!input.candidates.length) return [];
  const pairCandidates = input.candidates.filter(
    (candidate) => candidate.displacementType === "PAIR",
  );
  const physicalExamOnlyCandidates = input.candidates.filter(
    (candidate) => candidate.displacementType === "PHYSICAL_EXAM_ONLY",
  );
  const capacities = await client.query<{
    clinic_id: string;
    clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    safe_daily_capacity: number;
    max_daily_capacity: number;
  }>(
    `SELECT setting.clinic_id, clinic.code AS clinic_code, setting.schedule_type,
            setting.safe_daily_capacity, setting.max_daily_capacity
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
      GROUP BY clinic.code, appointment.appointment_date`,
    [input.replacementWindowStart, input.searchEndDate],
  );
  const loadFor = (clinicCode: string): Record<string, number> => Object.fromEntries(
    load.rows.filter((row) => row.clinic_code === clinicCode).map((row) => [row.date, row.count]),
  );
  const laboratoryLoad = loadFor("KABALAKA_CLINIC");
  const physicalExamLoad = loadFor("CPU_CLINIC");
  const blocked = await client.query<{ clinic_code: string; date: string }>(
    `SELECT clinic.code AS clinic_code, blocked.date::date::text AS date
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
       CROSS JOIN LATERAL generate_series(
         GREATEST(unavailable.start_date, $1::date),
         LEAST(unavailable.end_date, $2::date),
         INTERVAL '1 day'
       ) AS blocked(date)
      WHERE unavailable.end_date >= $1::date
        AND unavailable.start_date <= $2::date`,
    [input.replacementWindowStart, input.searchEndDate],
  );
  const blockedLaboratoryDates = blocked.rows
    .filter((row) => row.clinic_code === "KABALAKA_CLINIC")
    .map((row) => row.date);
  const blockedPhysicalExamDates = blocked.rows
    .filter((row) => row.clinic_code === "CPU_CLINIC")
    .map((row) => row.date);
  const generated = generatePairedSchedule({
    requests: pairCandidates.map((candidate) => ({
      requestId: `displacement:${candidate.schedulePairId}`,
      studentNumber: candidate.studentNumber,
      category: "REGULAR",
      acceptedAt: candidate.acceptedAt.toISOString(),
      sourceRowOrder: candidate.sourceRowOrder,
      windowStart: input.replacementWindowStart,
    })),
    laboratoryCapacity: {
      safeDailyCapacity: laboratoryCapacity.safe_daily_capacity,
      maxDailyCapacity: laboratoryCapacity.max_daily_capacity,
    },
    physicalExamCapacity: {
      safeDailyCapacity: physicalExamCapacity.safe_daily_capacity,
      maxDailyCapacity: physicalExamCapacity.max_daily_capacity,
    },
    existingLaboratoryLoad: laboratoryLoad,
    existingPhysicalExamLoad: physicalExamLoad,
    blockedLaboratoryDates,
    blockedPhysicalExamDates,
    searchEndDate: input.searchEndDate,
  });
  if (generated.unscheduledRequestIds.length) {
    throw new AppError(
      "REGULAR_REPLACEMENT_CAPACITY_EXHAUSTED",
      "Displaced Regular appointments could not be replaced atomically.",
      409,
    );
  }
  for (const assignment of generated.assignments) {
    laboratoryLoad[assignment.laboratoryDate] = (laboratoryLoad[assignment.laboratoryDate] ?? 0) + 1;
    physicalExamLoad[assignment.physicalExamDate] = (physicalExamLoad[assignment.physicalExamDate] ?? 0) + 1;
  }
  const physicalExamCeiling = Math.max(
    0,
    Math.min(physicalExamCapacity.safe_daily_capacity, physicalExamCapacity.max_daily_capacity),
  );
  const blockedPhysicalExamSet = new Set(blockedPhysicalExamDates);
  const physicalExamOnlyAssignments = [...physicalExamOnlyCandidates]
    .sort((left, right) => (
      left.acceptedAt.getTime() - right.acceptedAt.getTime()
      || left.sourceRowOrder - right.sourceRowOrder
      || left.studentNumber.localeCompare(right.studentNumber)
    ))
    .map((candidate) => {
      const startDate = candidate.laboratoryDate >= input.replacementWindowStart
        ? addDays(candidate.laboratoryDate, 1)
        : input.replacementWindowStart;
      let physicalExamDate: string | null = null;
      for (let date = startDate; date <= input.searchEndDate; date = addDays(date, 1)) {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        if (weekday === 0 || weekday === 6 || blockedPhysicalExamSet.has(date)) continue;
        if ((physicalExamLoad[date] ?? 0) < physicalExamCeiling) {
          physicalExamDate = date;
          physicalExamLoad[date] = (physicalExamLoad[date] ?? 0) + 1;
          break;
        }
      }
      if (!physicalExamDate) {
        throw new AppError(
          "REGULAR_REPLACEMENT_CAPACITY_EXHAUSTED",
          "Displaced Regular appointments could not be replaced atomically.",
          409,
        );
      }
      return { candidate, physicalExamDate };
    });
  const candidateByStudent = new Map(
    input.candidates.map((candidate) => [candidate.studentNumber, candidate]),
  );
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
       clinic_id, student_number, schedule_type, appointment_date, status,
       is_published, notes, rescheduled_from, created_by, updated_by,
       schedule_pair_id, schedule_cycle_start
     )
     SELECT $1, fixture.student_number, $2, fixture.appointment_date, 'PENDING', TRUE,
            'Automatically rescheduled for priority capacity.', fixture.old_id,
            $3, $3, fixture.schedule_pair_id, $4
       FROM UNNEST($5::varchar[], $6::date[], $7::uuid[], $8::uuid[])
         AS fixture(student_number, appointment_date, schedule_pair_id, old_id)
     RETURNING id, student_number, rescheduled_from::text`,
    [
      clinicId,
      scheduleType,
      input.actorUserId,
      pairCandidates[0]?.scheduleCycleStart ?? input.candidates[0].scheduleCycleStart,
      generated.assignments.map((assignment) => assignment.studentNumber),
      dates,
      generated.assignments.map((assignment) => assignment.schedulePairId),
      oldIds,
    ],
  );
  const laboratory = await insertReplacements(
    "LABORATORY",
    laboratoryCapacity.clinic_id,
    generated.assignments.map((assignment) => assignment.laboratoryDate),
    generated.assignments.map(
      (assignment) => candidateByStudent.get(assignment.studentNumber)!.laboratoryAppointmentId,
    ),
  );
  const physical = await insertReplacements(
    "PHYSICAL_EXAM",
    physicalExamCapacity.clinic_id,
    generated.assignments.map((assignment) => assignment.physicalExamDate),
    generated.assignments.map(
      (assignment) => candidateByStudent.get(assignment.studentNumber)!.physicalExamAppointmentId,
    ),
  );
  const physicalExamOnly = await client.query<{
    id: string;
    student_number: string;
    rescheduled_from: string;
  }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date, status,
       is_published, notes, rescheduled_from, created_by, updated_by,
       schedule_pair_id, schedule_cycle_start
     )
     SELECT $1, fixture.student_number, 'PHYSICAL_EXAM', fixture.appointment_date,
            'PENDING', TRUE, 'Automatically rescheduled for priority capacity.',
            fixture.old_id, $2, $2, fixture.schedule_pair_id, fixture.schedule_cycle_start
       FROM UNNEST($3::varchar[], $4::date[], $5::uuid[], $6::uuid[], $7::integer[])
         AS fixture(student_number, appointment_date, schedule_pair_id, old_id, schedule_cycle_start)
     RETURNING id, student_number, rescheduled_from::text`,
    [
      physicalExamCapacity.clinic_id,
      input.actorUserId,
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.studentNumber),
      physicalExamOnlyAssignments.map(({ physicalExamDate }) => physicalExamDate),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.schedulePairId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.physicalExamAppointmentId),
      physicalExamOnlyAssignments.map(({ candidate }) => candidate.scheduleCycleStart),
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
  await client.query(
    `INSERT INTO appointment_reschedule_events (
       student_number, schedule_pair_id, cause, source_import_group_id,
       old_laboratory_appointment_id, new_laboratory_appointment_id,
       old_physical_exam_appointment_id, new_physical_exam_appointment_id,
       actor_user_id
     )
     SELECT fixture.student_number, fixture.schedule_pair_id,
            'PRIORITY_DISPLACEMENT', $1, fixture.old_laboratory_id,
            fixture.new_laboratory_id, fixture.old_physical_id,
            fixture.new_physical_id, $2
       FROM UNNEST(
         $3::varchar[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[]
       ) AS fixture(
         student_number, schedule_pair_id, old_laboratory_id,
         new_laboratory_id, old_physical_id, new_physical_id
       )`,
    [
      input.sourceImportGroupId,
      input.actorUserId,
      generated.assignments.map((assignment) => assignment.studentNumber),
      generated.assignments.map((assignment) => assignment.schedulePairId),
      generated.assignments.map(
        (assignment) => candidateByStudent.get(assignment.studentNumber)!.laboratoryAppointmentId,
      ),
      generated.assignments.map((assignment) => labByStudent.get(assignment.studentNumber)),
      generated.assignments.map(
        (assignment) => candidateByStudent.get(assignment.studentNumber)!.physicalExamAppointmentId,
      ),
      generated.assignments.map((assignment) => peByStudent.get(assignment.studentNumber)),
    ],
  );
  const physicalExamOnlyByStudent = new Map(
    physicalExamOnly.rows.map((row) => [row.student_number, row.id]),
  );
  await client.query(
    `INSERT INTO appointment_reschedule_events (
       student_number, schedule_pair_id, cause, source_import_group_id,
       old_laboratory_appointment_id, new_laboratory_appointment_id,
       old_physical_exam_appointment_id, new_physical_exam_appointment_id,
       actor_user_id
     )
     SELECT fixture.student_number, fixture.schedule_pair_id,
            'PRIORITY_DISPLACEMENT', $1, fixture.laboratory_id,
            fixture.laboratory_id, fixture.old_physical_id,
            fixture.new_physical_id, $2
       FROM UNNEST(
         $3::varchar[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[]
       ) AS fixture(
         student_number, schedule_pair_id, laboratory_id,
         old_physical_id, new_physical_id
       )`,
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
    ],
  );
  for (const assignment of generated.assignments) {
    const previous = candidateByStudent.get(assignment.studentNumber)!;
    await createStudentNotification(client, {
      studentNumber: assignment.studentNumber,
      notificationType: "SCHEDULE_RESCHEDULED",
      title: "Schedule updated",
      message: "Priority scheduling changed your Laboratory and Physical Examination dates. Review the new dates in the student portal.",
      metadata: {
        reason: "PRIORITY_DISPLACEMENT",
        sourceImportId: input.sourceImportGroupId,
        previousLaboratoryDate: previous.laboratoryDate,
        replacementLaboratoryDate: assignment.laboratoryDate,
        previousPhysicalExamDate: previous.physicalExamDate,
        replacementPhysicalExamDate: assignment.physicalExamDate,
      },
    });
  }
  for (const { candidate, physicalExamDate } of physicalExamOnlyAssignments) {
    await createStudentNotification(client, {
      studentNumber: candidate.studentNumber,
      notificationType: "SCHEDULE_RESCHEDULED",
      title: "Schedule updated",
      message: "Priority scheduling changed your Physical Examination date. Your Laboratory date is unchanged.",
      metadata: {
        reason: "PRIORITY_DISPLACEMENT",
        sourceImportId: input.sourceImportGroupId,
        laboratoryDate: candidate.laboratoryDate,
        previousPhysicalExamDate: candidate.physicalExamDate,
        replacementPhysicalExamDate: physicalExamDate,
      },
    });
  }
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'PRIORITY_DISPLACEMENT_APPLIED', 'schedule_import_group', $2,
             jsonb_build_object('displacedStudentCount', $3::int))`,
    [input.actorUserId, input.sourceImportGroupId, input.candidates.length],
  );
  return [
    ...generated.assignments,
    ...physicalExamOnlyAssignments.map(({ candidate, physicalExamDate }) => ({
      requestId: `displacement:${candidate.schedulePairId}:physical-exam`,
      studentNumber: candidate.studentNumber,
      schedulePairId: candidate.schedulePairId,
      laboratoryDate: candidate.laboratoryDate,
      physicalExamDate,
    })),
  ];
}

export const nextDateAfter = (date: string) => addDays(date, 1);
