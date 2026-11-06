import "server-only";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import type { PoolClient } from "pg";
import { lockAcademicYearSchedulingBoundary } from "@/server/repositories/academic-years.repository";
import type { ClinicClosureRecoveryMode, ClinicManualCaseReason } from "@/types/clinic-calendar";
import {
  buildAwaitingResolutionNotification,
  buildClosureRescheduledNotification,
} from "@/server/schedule/schedule-notifications";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import {
  allocateReplacementDates,
  addCalendarDays,
  classifyClinicCycle,
  ClinicCalendarPlanningError,
  groupContiguousClosureChanges,
  type ClinicCycleAppointment,
  type ClinicCycleClassification,
  type ReplacementCapacity,
  type ReplacementCycleBounds,
  type UsedReplacementCapacity,
} from "../clinic-calendar-planner";
import {
  compareClosureRecoveryQueueEntries,
  evaluateClosureRecoveryPolicy,
  type ClinicClosureRecoveryPolicyDecision,
} from "../clinic-closure-recovery-policy";
import {
  resultProtectionAuditMetadata,
  manilaToday,
  copyCapacity,
  reserveCapacity,
  createClosureNotification,
  previousScheduleForAppointments,
} from "./recovery-shared";

type CalendarCycle = {
  key: string;
  studentNumber: string;
  scheduleCycleStart: number;
  appointments: ClinicCycleAppointment[];
};

export type PersistedGroup = ReturnType<typeof groupContiguousClosureChanges>[number] & {
  closureGroupId: string;
  dateIds: Array<{ id: string; date: string }>;
};

export async function loadAffectedCycles(client: PoolClient, dates: string[], lock: boolean) {
  if (!dates.length) return [];
  const result = await client.query<{
    id: string;
    clinic_id: string;
    student_number: string;
    schedule_type: ClinicCycleAppointment["scheduleType"];
    appointment_date: string;
    status: string;
    is_published: boolean;
    is_manually_locked: boolean;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    created_at: Date;
    scheduling_source_row_order: number | null;
    ovpsa_batch_id: string | null;
    ovpsa_revision_id: string | null;
    ovpsa_service_reservation_id: string | null;
  }>(
    `WITH impacted AS (
       SELECT DISTINCT student_number,schedule_cycle_start
         FROM appointments
        WHERE appointment_date=ANY($1::date[])
          AND is_published=TRUE
          AND status NOT IN ('RESCHEDULED','CANCELLED')
     )
     SELECT appointment.id::text,appointment.clinic_id::text,
            appointment.student_number,appointment.schedule_type,
            appointment.appointment_date::text,appointment.status,
            appointment.is_published,appointment.is_manually_locked,
            appointment.schedule_pair_id::text,appointment.schedule_cycle_start
            ,appointment.created_at,appointment.scheduling_source_row_order,
            appointment.ovpsa_batch_id::text,appointment.ovpsa_revision_id::text,
            appointment.ovpsa_service_reservation_id::text
       FROM appointments appointment
       JOIN impacted USING(student_number,schedule_cycle_start)
      WHERE appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.appointment_date,appointment.created_at,
               appointment.scheduling_source_row_order NULLS LAST,
               appointment.student_number,appointment.schedule_type,appointment.id
      ${lock ? "FOR UPDATE OF appointment" : ""}`,
    [dates],
  );
  const protectionStates = await loadAppointmentResultProtectionStates(
    client,
    result.rows.map((row) => row.id),
  );
  const cycleByKey = new Map<string, CalendarCycle>();
  for (const row of result.rows) {
    const key = `${row.student_number}:${row.schedule_cycle_start}`;
    const cycle = cycleByKey.get(key) ?? {
      key,
      studentNumber: row.student_number,
      scheduleCycleStart: row.schedule_cycle_start,
      appointments: [] as ClinicCycleAppointment[],
    };
    cycle.appointments.push({
      id: row.id,
      studentNumber: row.student_number,
      scheduleType: row.schedule_type,
      appointmentDate: row.appointment_date,
      status: row.status,
      isPublished: row.is_published,
      isManuallyLocked: row.is_manually_locked,
      resultProtectionState: protectionStates.get(row.id) ?? { type: "CLEAR" },
      schedulePairId: row.schedule_pair_id,
      scheduleCycleStart: row.schedule_cycle_start,
      createdAt: row.created_at.toISOString(),
      sourceOrder: row.scheduling_source_row_order,
      ovpsaBatchId: row.ovpsa_batch_id,
      ovpsaRevisionId: row.ovpsa_revision_id,
      ovpsaServiceReservationId: row.ovpsa_service_reservation_id,
    });
    cycleByKey.set(key, cycle);
  }
  return [...cycleByKey.values()];
}

export function applicableGroups(cycle: CalendarCycle, groups: PersistedGroup[] | ReturnType<typeof groupContiguousClosureChanges>) {
  const appointmentDates = new Set(cycle.appointments.map((appointment) => appointment.appointmentDate));
  return groups.filter((group) => group.dates.some((date) => appointmentDates.has(date)));
}

type ClosureGroupLike = ReturnType<typeof groupContiguousClosureChanges>[number] & {
  closureGroupId?: string;
};

type CycleRecoveryDecision = ClinicClosureRecoveryPolicyDecision & {
  group: ClosureGroupLike;
  affectedAppointment: ClinicCycleAppointment;
  affectedAppointmentIds: Set<string>;
  policyMetadata: Record<string, unknown>;
};

const manualReasonPriority: Record<ClinicManualCaseReason, number> = {
  EMERGENCY_CLOSURE: 0,
  OVPSA_LABORATORY_PROTECTED: 1,
  NOTICE_PERIOD_PROTECTED: 2,
  APPOINTMENT_MANUALLY_LOCKED: 3,
  DRAFT_RESULT_FILES_EXIST: 4,
  LABORATORY_PROGRESS_RECORDED: 4,
  PROTECTED_RESULTS_EXIST: 5,
  PHYSICAL_COMPLETED_BEFORE_LABORATORY: 6,
  PAIR_MISSING_OR_INCONSISTENT: 7,
  UNSAFE_RESTORATION: 8,
  ADMIN_CHOSE_MANUAL_RECOVERY: 9,
  NO_REPLACEMENT_CAPACITY: 10,
  CONCURRENT_APPOINTMENT_CHANGE: 11,
  NO_VALID_REPLACEMENT_WITHIN_CYCLE: 12,
};

function affectedAppointmentIds(
  cycle: CalendarCycle,
  groups: ClosureGroupLike[],
) {
  const dates = new Set(groups.flatMap((group) => group.dates));
  return new Set(
    cycle.appointments
      .filter((appointment) => dates.has(appointment.appointmentDate))
      .map((appointment) => appointment.id),
  );
}

export function evaluateCycleRecovery(input: {
  cycle: CalendarCycle;
  groups: ClosureGroupLike[];
  recoveryMode: ClinicClosureRecoveryMode;
  policyEffectiveDate: string;
}): CycleRecoveryDecision {
  const affectedIds = affectedAppointmentIds(input.cycle, input.groups);
  const safetyClassification = classifyClinicCycle(input.cycle.appointments, {
    affectedAppointmentIds: affectedIds,
  });
  const safetyReason = safetyClassification.strategy === "MANUAL_RESOLUTION_REQUIRED"
    ? {
        reasonCode: safetyClassification.reasonCode,
        reasonMessage: safetyClassification.reasonMessage,
      }
    : null;
  const candidates = input.groups.flatMap((group) =>
    input.cycle.appointments
      .filter((appointment) =>
        affectedIds.has(appointment.id)
        && group.dates.includes(appointment.appointmentDate))
      .map((appointment) => {
        const policy = evaluateClosureRecoveryPolicy({
          category: group.category,
          policyEffectiveDate: input.policyEffectiveDate,
          affectedAppointmentDate: appointment.appointmentDate,
          affectedService: appointment.scheduleType,
          recoveryMode: input.recoveryMode,
          isOvpsaControlledLaboratory: Boolean(
            appointment.scheduleType === "LABORATORY" && appointment.ovpsaBatchId,
          ),
          safetyReason,
        });
        return { policy, group, appointment };
      }));
  const decisive = candidates.sort((left, right) => {
    const leftPriority = left.policy.reasonCode
      ? manualReasonPriority[left.policy.reasonCode]
      : Number.MAX_SAFE_INTEGER;
    const rightPriority = right.policy.reasonCode
      ? manualReasonPriority[right.policy.reasonCode]
      : Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority
      || left.appointment.appointmentDate.localeCompare(right.appointment.appointmentDate)
      || left.group.startDate.localeCompare(right.group.startDate)
      || left.group.category.localeCompare(right.group.category)
      || left.group.reason.localeCompare(right.group.reason);
  })[0];
  if (!decisive) throw new Error("Affected clinic cycle has no matching closure group.");
  const completedWorkIsPreserved = input.cycle.appointments
    .filter((appointment) => affectedIds.has(appointment.id))
    .every((appointment) => appointment.status === "COMPLETED");
  return {
    ...decisive.policy,
    ...(completedWorkIsPreserved ? {
      decision: "AUTO_RECOVERY_ELIGIBLE" as const,
      reasonCode: null,
      reasonMessage: null,
    } : {}),
    group: decisive.group,
    affectedAppointment: decisive.appointment,
    affectedAppointmentIds: affectedIds,
    policyMetadata: {
      policyEffectiveDate: input.policyEffectiveDate,
      originalAffectedAppointmentDate: decisive.appointment.appointmentDate,
      noticeDays: decisive.policy.noticeDays,
      closureCategory: decisive.group.category,
      recoveryMode: input.recoveryMode,
      affectedService: decisive.appointment.scheduleType,
      ovpsaControlled: Boolean(decisive.appointment.ovpsaBatchId),
      ovpsaBatchId: decisive.appointment.ovpsaBatchId ?? null,
      ovpsaRevisionId: decisive.appointment.ovpsaRevisionId ?? null,
      affectedAppointmentIds: [...affectedIds].sort(),
    },
  };
}

export function sortRecoveryCycles(cycles: CalendarCycle[], groups: ClosureGroupLike[]) {
  return [...cycles].sort((left, right) => {
    const entry = (cycle: CalendarCycle) => {
      const affected = cycle.appointments
        .filter((appointment) => groups.some((group) => group.dates.includes(appointment.appointmentDate)))
        .sort((a, b) => a.appointmentDate.localeCompare(b.appointmentDate))[0];
      return {
        affectedAppointmentDate: affected?.appointmentDate ?? "9999-12-31",
        originalCreatedAt: affected?.createdAt ?? "9999-12-31T23:59:59.999Z",
        originalOrder: affected?.sourceOrder ?? Number.MAX_SAFE_INTEGER,
        studentNumber: cycle.studentNumber,
      };
    };
    return compareClosureRecoveryQueueEntries(entry(left), entry(right));
  });
}

export function reasonGroups(reasonCounts: Map<ClinicManualCaseReason, number>) {
  return [...reasonCounts.entries()]
    .sort((left, right) =>
      manualReasonPriority[left[0]] - manualReasonPriority[right[0]]
      || left[0].localeCompare(right[0]))
    .map(([reasonCode, count]) => ({ reasonCode, count }));
}

export function addReasonCount(
  counts: Map<ClinicManualCaseReason, number>,
  reasonCode: ClinicManualCaseReason,
) {
  counts.set(reasonCode, (counts.get(reasonCode) ?? 0) + 1);
}

async function insertStatusLogs(
  client: PoolClient,
  appointmentIds: string[],
  oldStatus: string | null,
  newStatus: string,
  notes: string,
  actorUserId: string,
) {
  if (!appointmentIds.length) return;
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id,old_status,new_status,notes,changed_by
     ) SELECT id,$2,$3,$4,$5 FROM UNNEST($1::uuid[]) AS appointment(id)`,
    [appointmentIds, oldStatus, newStatus, notes, actorUserId],
  );
}

async function createManualCase(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    classification: Extract<ClinicCycleClassification, { strategy: "MANUAL_RESOLUTION_REQUIRED" }>;
    closureGroupId: string;
    actorUserId: string;
    affectedAppointmentIds: ReadonlySet<string>;
    policyMetadata: Record<string, unknown>;
  },
) {
  const unfinishedIds = input.cycle.appointments
    .filter((appointment) =>
      input.affectedAppointmentIds.has(appointment.id)
      && (appointment.status === "PENDING" || appointment.status === "DRAFT"))
    .map((appointment) => appointment.id);
  if (unfinishedIds.length) {
    await client.query(
      `UPDATE appointments
          SET status='AWAITING_RESCHEDULE',is_published=TRUE,updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [unfinishedIds],
    );
    await insertStatusLogs(
      client,
      unfinishedIds,
      null,
      "AWAITING_RESCHEDULE",
      "Clinic closure requires administrator resolution.",
      input.actorUserId,
    );
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO clinic_closure_manual_cases (
       student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
       affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
       reason_code,reason_message,policy_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id::text`,
    [
      input.cycle.studentNumber,
      input.closureGroupId,
      input.cycle.appointments[0]?.schedulePairId ?? null,
      input.cycle.scheduleCycleStart,
      input.classification.laboratory?.id ?? null,
      input.classification.physicalExam?.id ?? null,
      input.classification.reasonCode,
      input.classification.reasonMessage,
      JSON.stringify(input.policyMetadata),
    ],
  );
  const protectionMetadata = resultProtectionAuditMetadata(input.cycle.appointments);
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES ($1,'CLINIC_CLOSURE_MANUAL_CASE_CREATED','clinic_closure_manual_case',$2::text,
             jsonb_build_object(
               'studentNumber',$3::text,
               'closureGroupId',$4::text,
               'reasonCode',$5::text,
               'appointmentIds',$6::jsonb,
               'submissionIds',$7::jsonb,
               'activeDraftFileCount',$8::int
             ))`,
    [
      input.actorUserId,
      inserted.rows[0].id,
      input.cycle.studentNumber,
      input.closureGroupId,
      input.classification.reasonCode,
      JSON.stringify(protectionMetadata.appointmentIds),
      JSON.stringify(protectionMetadata.submissionIds),
      protectionMetadata.activeDraftFileCount,
    ],
  );
  return inserted.rows[0].id;
}

async function insertClosureEvent(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    closureGroupId: string;
    strategy: "MOVE_COMPLETE_PAIR" | "MOVE_LABORATORY_ONLY" | "MOVE_PHYSICAL_ONLY" | "MANUAL_RESOLUTION_REQUIRED";
    outcome: "REPLACED" | "AWAITING_RESCHEDULE";
    batchId: string;
    actorUserId: string;
    newLaboratoryId?: string | null;
    newPhysicalId?: string | null;
    manualCaseId?: string | null;
    unavailableDateIds: string[];
    policyReasonCode?: ClinicManualCaseReason | null;
    policyMetadata: Record<string, unknown>;
  },
) {
  const laboratory = input.cycle.appointments.find((appointment) => appointment.scheduleType === "LABORATORY");
  const physical = input.cycle.appointments.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM");
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number,schedule_pair_id,cause,
       old_laboratory_appointment_id,new_laboratory_appointment_id,
       old_physical_exam_appointment_id,new_physical_exam_appointment_id,
       actor_user_id,block_batch_id,closure_group_id,schedule_cycle_start,
       strategy,outcome,manual_case_id,policy_reason_code,policy_metadata
     ) VALUES ($1,$2,'CLINIC_CLOSURE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     RETURNING id::text`,
    [
      input.cycle.studentNumber,
      laboratory?.schedulePairId ?? physical?.schedulePairId ?? null,
      laboratory?.id ?? null,
      input.newLaboratoryId ?? null,
      physical?.id ?? null,
      input.newPhysicalId ?? null,
      input.actorUserId,
      input.batchId,
      input.closureGroupId,
      input.cycle.scheduleCycleStart,
      input.strategy,
      input.outcome,
      input.manualCaseId ?? null,
      input.policyReasonCode ?? null,
      JSON.stringify(input.policyMetadata),
    ],
  );
  if (input.unavailableDateIds.length) {
    await client.query(
      `INSERT INTO appointment_reschedule_event_unavailable_dates (event_id,unavailable_date_id)
       SELECT $1,id FROM UNNEST($2::uuid[]) AS unavailable(id)`,
      [inserted.rows[0].id, input.unavailableDateIds],
    );
  }
  return inserted.rows[0].id;
}

export async function markOvpsaLaboratoryClosure(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    affectedAppointmentIds: ReadonlySet<string>;
    closureGroupId: string;
    actorUserId: string;
  },
) {
  const laboratory = input.cycle.appointments.find((appointment) =>
    appointment.scheduleType === "LABORATORY"
    && input.affectedAppointmentIds.has(appointment.id)
    && appointment.ovpsaBatchId
    && appointment.ovpsaServiceReservationId);
  if (!laboratory?.ovpsaBatchId || !laboratory.ovpsaServiceReservationId) return;
  await client.query(
    `UPDATE ovpsa_first_year_service_reservations
        SET status='INVALIDATED',invalidated_by_closure_group_id=$2,
            invalidated_at=clock_timestamp()
      WHERE id=$1 AND status='ACTIVE' AND reservation_kind='EXCLUSIVE'`,
    [laboratory.ovpsaServiceReservationId, input.closureGroupId],
  );
  await client.query(
    `UPDATE ovpsa_first_year_batches
        SET status='RESCHEDULE_REQUIRED',optimistic_token=gen_random_uuid(),
            updated_by=$2,updated_at=clock_timestamp()
      WHERE id=$1 AND status='PUBLISHED'`,
    [laboratory.ovpsaBatchId, input.actorUserId],
  );
}

export async function loadRecoveryBounds(client: PoolClient, cycles: CalendarCycle[]) {
  const bounds = new Map<number, ReplacementCycleBounds | null>();
  for (const year of [...new Set(cycles.map((cycle) => cycle.scheduleCycleStart))].sort()) {
    const boundary = await lockAcademicYearSchedulingBoundary(client, year);
    bounds.set(year, boundary ? {
      cycleStartDate: `${year}-08-01`, cycleClosingDate: boundary.closingDate, manilaToday: manilaToday(),
    } : null);
  }
  return bounds;
}

function releaseCapacity(used: UsedReplacementCapacity, originals: ClinicCycleAppointment[]) {
  for (const original of originals) {
    if (!["DRAFT", "PENDING"].includes(original.status)
      || (original.scheduleType === "LABORATORY" && original.ovpsaBatchId)) continue;
    const service = used[original.scheduleType];
    service.set(original.appointmentDate, Math.max(0, (service.get(original.appointmentDate) ?? 0) - 1));
  }
}

export function allocateCycleRecovery(input: {
  cycle: CalendarCycle;
  bounds: ReplacementCycleBounds | null;
  affectedAppointmentIds: ReadonlySet<string>;
  afterDate: string;
  blockedDates: Set<string>;
  blockedDatesByService: Partial<Record<keyof ReplacementCapacity, Set<string>>>;
  usedCapacity: UsedReplacementCapacity;
  capacity: ReplacementCapacity;
}) {
  let classification = classifyClinicCycle(input.cycle.appointments, {
    affectedAppointmentIds: input.affectedAppointmentIds,
  });
  // Explore Laboratory-only first without freeing the PE that may be preserved.
  if (classification.strategy === "MOVE_COMPLETE_PAIR"
    && input.affectedAppointmentIds.has(classification.laboratory.id)
    && !input.affectedAppointmentIds.has(classification.physicalExam.id)) {
    const usedCapacity = copyCapacity(input.usedCapacity);
    releaseCapacity(usedCapacity, [classification.laboratory]);
    const dates = allocateReplacementDates({ ...input, usedCapacity, strategy: "MOVE_LABORATORY_ONLY" });
    classification = classifyClinicCycle(input.cycle.appointments, {
      affectedAppointmentIds: input.affectedAppointmentIds,
      proposedLaboratoryDate: dates.laboratoryDate,
    });
    if (classification.strategy === "MOVE_LABORATORY_ONLY") {
      reserveCapacity(usedCapacity, dates);
      return { classification, dates, usedCapacity };
    }
  }
  if (classification.strategy === "MANUAL_RESOLUTION_REQUIRED"
    || classification.strategy === "PRESERVE_COMPLETION") {
    return { classification, dates: {}, usedCapacity: input.usedCapacity };
  }
  const usedCapacity = copyCapacity(input.usedCapacity);
  releaseCapacity(usedCapacity, classification.strategy === "MOVE_COMPLETE_PAIR"
    ? [classification.laboratory, classification.physicalExam] : [classification.physicalExam]);
  const afterDate = classification.strategy === "MOVE_PHYSICAL_ONLY"
    ? [input.afterDate, addCalendarDays(classification.laboratory.appointmentDate,
      classification.laboratory.ovpsaBatchId ? 6 : 0)].sort().at(-1)!
    : input.afterDate;
  const dates = allocateReplacementDates({ ...input, afterDate, usedCapacity, strategy: classification.strategy });
  reserveCapacity(usedCapacity, dates);
  return { classification, dates, usedCapacity };
}

export function movedAppointmentCount(classification: ClinicCycleClassification) {
  if (classification.strategy === "MOVE_COMPLETE_PAIR") return 2;
  if (
    classification.strategy === "MOVE_LABORATORY_ONLY"
    || classification.strategy === "MOVE_PHYSICAL_ONLY"
  ) return 1;
  return 0;
}

export async function applyAutomaticMove(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    classification: Extract<ClinicCycleClassification, {
      strategy: "MOVE_COMPLETE_PAIR" | "MOVE_LABORATORY_ONLY" | "MOVE_PHYSICAL_ONLY";
    }>;
    dates: { laboratoryDate?: string; physicalExamDate?: string };
    group: PersistedGroup;
    unavailableDateIds: string[];
    batchId: string;
    actorUserId: string;
    clinicIds: { LABORATORY: string; PHYSICAL_EXAM: string };
    policyMetadata: Record<string, unknown>;
  },
) {
  const originals = input.classification.strategy === "MOVE_COMPLETE_PAIR"
    ? [input.classification.laboratory, input.classification.physicalExam]
    : input.classification.strategy === "MOVE_LABORATORY_ONLY"
      ? [input.classification.laboratory]
      : [input.classification.physicalExam];
  const update = await client.query(
    `UPDATE appointments
        SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=NOW()
      WHERE id=ANY($1::uuid[])
        AND status IN ('DRAFT','PENDING')
        AND is_published=TRUE`,
    [originals.map((appointment) => appointment.id), input.actorUserId],
  );
  if (update.rowCount !== originals.length) {
    throw new ClinicCalendarPlanningError(
      "CONCURRENT_APPOINTMENT_CHANGE",
      "An appointment changed while the closure was being applied.",
    );
  }
  await insertStatusLogs(
    client,
    originals.map((appointment) => appointment.id),
    null,
    "RESCHEDULED",
    `Unified clinic closure ${input.group.closureGroupId}.`,
    input.actorUserId,
  );

  const replacementByType: Partial<Record<ClinicCycleAppointment["scheduleType"], string>> = {};
  for (const original of originals) {
    const appointmentDate = original.scheduleType === "LABORATORY"
      ? input.dates.laboratoryDate
      : input.dates.physicalExamDate;
    if (!appointmentDate) throw new Error(`Missing ${original.scheduleType} replacement date`);
    let recoveryReservationId: string | null = null;
    if (original.ovpsaBatchId && original.ovpsaRevisionId) {
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,
           reservation_kind,created_by
         ) VALUES ($1,$2,$3,$4,'ACTIVE','CLOSURE_RECOVERY',$5)
         RETURNING id::text`,
        [
          original.ovpsaBatchId,
          original.ovpsaRevisionId,
          original.scheduleType,
          appointmentDate,
          input.actorUserId,
        ],
      );
      recoveryReservationId = reservation.rows[0].id;
    }
    const inserted = recoveryReservationId
      ? await client.query<{ id: string }>(
          `INSERT INTO appointments (
             clinic_id,student_number,schedule_type,appointment_date,status,is_published,
             notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
             ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
             scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
             scheduling_window_start,scheduling_window_end
           ) SELECT clinic_id,student_number,schedule_type,$2,'PENDING',TRUE,$3,id,$4,$4,
                    schedule_pair_id,schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,$5,
                    scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
                    scheduling_window_start,scheduling_window_end
               FROM appointments WHERE id=$1
           RETURNING id::text`,
          [
            original.id,
            appointmentDate,
            `Automatically recovered after closure group ${input.group.closureGroupId}.`,
            input.actorUserId,
            recoveryReservationId,
          ],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO appointments (
             batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
             notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
             scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
             scheduling_window_start,scheduling_window_end
           ) SELECT batch_id,$2,student_number,schedule_type,$3,'PENDING',TRUE,$4,id,$5,$5,
                    schedule_pair_id,schedule_cycle_start,scheduling_category,
                    scheduling_accepted_at,scheduling_source_row_order,
                    scheduling_window_start,scheduling_window_end
               FROM appointments WHERE id=$1
           RETURNING id::text`,
          [
            original.id,
            input.clinicIds[original.scheduleType],
            appointmentDate,
            `Automatically rescheduled after closure group ${input.group.closureGroupId}.`,
            input.actorUserId,
          ],
        );
    replacementByType[original.scheduleType] = inserted.rows[0].id;
    await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
    await insertStatusLogs(
      client,
      [inserted.rows[0].id],
      null,
      "PENDING",
      "Published unified closure replacement.",
      input.actorUserId,
    );
  }
  const eventId = await insertClosureEvent(client, {
    cycle: input.cycle,
    closureGroupId: input.group.closureGroupId,
    strategy: input.classification.strategy,
    outcome: "REPLACED",
    batchId: input.batchId,
    actorUserId: input.actorUserId,
    newLaboratoryId: replacementByType.LABORATORY,
    newPhysicalId: replacementByType.PHYSICAL_EXAM,
    unavailableDateIds: input.unavailableDateIds,
    policyMetadata: input.policyMetadata,
  });
  const notificationWarningCount = await createClosureNotification(client, {
    studentNumber: input.cycle.studentNumber,
    build: (state) => buildClosureRescheduledNotification({
      state,
      eventId,
      reason: input.group.reason,
      previous: previousScheduleForAppointments(originals),
    }),
    actorUserId: input.actorUserId,
    auditEntityId: eventId,
  });
  return { movedAppointmentCount: originals.length, notificationWarningCount };
}

export async function createManualFallback(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    reasonCode: ClinicManualCaseReason;
    reasonMessage: string;
    group: PersistedGroup;
    unavailableDateIds: string[];
    batchId: string;
    actorUserId: string;
    affectedAppointmentIds: ReadonlySet<string>;
    policyMetadata: Record<string, unknown>;
  },
) {
  const laboratory = input.cycle.appointments.find((appointment) => appointment.scheduleType === "LABORATORY") ?? null;
  const physicalExam = input.cycle.appointments.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM") ?? null;
  const classification = {
    strategy: "MANUAL_RESOLUTION_REQUIRED" as const,
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    laboratory,
    physicalExam,
  };
  const manualCaseId = await createManualCase(client, {
    cycle: input.cycle,
    classification,
    closureGroupId: input.group.closureGroupId,
    actorUserId: input.actorUserId,
    affectedAppointmentIds: input.affectedAppointmentIds,
    policyMetadata: input.policyMetadata,
  });
  const eventId = await insertClosureEvent(client, {
    cycle: input.cycle,
    closureGroupId: input.group.closureGroupId,
    strategy: "MANUAL_RESOLUTION_REQUIRED",
    outcome: "AWAITING_RESCHEDULE",
    batchId: input.batchId,
    actorUserId: input.actorUserId,
    manualCaseId,
    unavailableDateIds: input.unavailableDateIds,
    policyReasonCode: input.reasonCode,
    policyMetadata: input.policyMetadata,
  });
  const notificationWarningCount = await createClosureNotification(client, {
    studentNumber: input.cycle.studentNumber,
    build: (state) => buildAwaitingResolutionNotification({
      state,
      eventId: manualCaseId,
      eventKeyDiscriminator: "awaiting",
      reason: `${input.reasonCode}: ${input.reasonMessage}`,
      previous: previousScheduleForAppointments(input.cycle.appointments),
    }),
    actorUserId: input.actorUserId,
    auditEntityId: eventId,
  });
  return { manualCaseId, notificationWarningCount };
}
