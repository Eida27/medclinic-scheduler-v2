import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  createClosureGroupWithDates,
  listActiveClinicUnavailableDateRecords,
  listActiveUnavailableDatesWithClient,
  listUnifiedBlockedDateSet,
  lockActiveUnavailableDates,
  lockAllActiveUnavailableDates,
  reopenUnavailableDate,
} from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarBlockChange,
  ClinicCalendarChange,
  ClinicCalendarOperationRequest,
  ClinicCalendarOperationResult,
  ClinicCalendarPreviewResult,
  ClinicClosureRecoveryMode,
  ClinicManualCaseReason,
  ClinicManualCaseResolutionRequest,
  OvpsaClosureBatchRecoveryConfirmation,
  OvpsaClosureBatchRecoveryPreview,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAwaitingResolutionNotification,
  buildClosureRescheduledNotification,
  buildManualResolutionCompletedNotification,
  type AuthoritativeScheduleState,
  type PreviousScheduleState,
} from "@/server/schedule/schedule-notifications";
import type { StudentNotificationInput } from "@/server/repositories/student-notifications.repository";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import {
  allocateReplacementDates,
  addCalendarDays,
  classifyClinicCycle,
  ClinicCalendarPlanningError,
  groupContiguousClosureChanges,
  isClinicSchedulingWeekday,
  normalizeClosureReason,
  type ClinicCycleAppointment,
  type ClinicCycleClassification,
  type ReplacementCapacity,
  type UsedReplacementCapacity,
} from "./clinic-calendar-planner";
import {
  isSchedulingDateBlocked,
  loadSchedulingBlockedDates,
} from "@/server/repositories/scheduling-blocked-dates.repository";
import {
  compareClosureRecoveryQueueEntries,
  evaluateClosureRecoveryPolicy,
  type ClinicClosureRecoveryPolicyDecision,
} from "./clinic-closure-recovery-policy";

const categorySchema = z.enum([
  "HOLIDAY",
  "CLOSURE",
  "EMERGENCY_CLOSURE",
  "MAINTENANCE",
  "STAFF_UNAVAILABILITY",
]);
const blockSchema = z.object({
  action: z.literal("BLOCK"),
  date: z.iso.date(),
  category: categorySchema,
  reason: z.string().trim().min(3).max(500),
}).strict();
const reopenSchema = z.object({
  action: z.literal("REOPEN"),
  date: z.iso.date(),
  unavailableDateId: z.string().uuid(),
  expectedUpdatedAt: z.string().trim().min(1).max(64),
}).strict();
const recoveryModeSchema = z.enum(["AUTO_ELIGIBLE", "MANUAL_ALL"]);
const requestShape = {
  requestId: z.string().uuid(),
  changes: z.array(z.discriminatedUnion("action", [blockSchema, reopenSchema])).min(1).max(366),
  emergencyAcknowledged: z.boolean(),
};
const previewRequestSchema = z.object(requestShape).strict();
const requestSchema = z.object({
  ...requestShape,
  recoveryMode: recoveryModeSchema,
}).strict();
const resolutionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ASSIGN_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    laboratoryDate: z.iso.date().optional(),
    physicalExamDate: z.iso.date().optional(),
    preserveLaboratory: z.boolean().optional(),
    preservePhysicalExam: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    action: z.literal("KEEP_CURRENT_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  }),
]);
const ovpsaBatchPreviewSchema = z.object({
  optimisticToken: z.string().uuid(),
  replacementLaboratoryDate: z.iso.date(),
}).strict();
const ovpsaBatchConfirmSchema = ovpsaBatchPreviewSchema.extend({
  caseTokens: z.array(z.object({
    caseId: z.string().uuid(),
    expectedOptimisticToken: z.string().uuid(),
  }).strict()).min(1),
  reason: z.string().trim().min(3).max(500),
}).strict();

type CalendarCycle = {
  key: string;
  studentNumber: string;
  scheduleCycleStart: number;
  appointments: ClinicCycleAppointment[];
};

type ParsedCalendarRequest = Omit<ClinicCalendarOperationRequest, "recoveryMode"> & {
  recoveryMode?: ClinicClosureRecoveryMode;
};

type PersistedGroup = ReturnType<typeof groupContiguousClosureChanges>[number] & {
  closureGroupId: string;
  dateIds: Array<{ id: string; date: string }>;
};

type AppointmentState = ClinicCycleAppointment & {
  clinicId: string;
  rescheduledFrom: string | null;
};

type CurrentAssignmentBlock = {
  code:
    | "DRAFT_RESULT_FILES_EXIST"
    | "PROTECTED_RESULTS_EXIST"
    | "APPOINTMENT_MANUALLY_LOCKED";
  message: string;
};

function currentAssignmentBlock(
  appointments: Array<Pick<ClinicCycleAppointment, "isManuallyLocked" | "resultProtectionState">>,
): CurrentAssignmentBlock | null {
  if (appointments.some((appointment) => appointment.isManuallyLocked)) {
    return {
      code: "APPOINTMENT_MANUALLY_LOCKED",
      message: "Unlock the affected appointment before assigning a replacement.",
    };
  }
  if (appointments.some((appointment) =>
    appointment.resultProtectionState.type === "PROTECTED"
    && appointment.resultProtectionState.reason === "DRAFT_RESULT_FILES_EXIST")) {
    return {
      code: "DRAFT_RESULT_FILES_EXIST",
      message: "Draft result files exist. Remove them from the student result profile before assigning a replacement.",
    };
  }
  if (appointments.some((appointment) => appointment.resultProtectionState.type === "PROTECTED")) {
    return {
      code: "PROTECTED_RESULTS_EXIST",
      message: "Finalized or verified results protect this appointment from replacement.",
    };
  }
  return null;
}

function resultProtectionAuditMetadata(appointments: ClinicCycleAppointment[]) {
  const protectedStates = appointments.flatMap((appointment) =>
    appointment.resultProtectionState.type === "PROTECTED"
      ? [{ appointmentId: appointment.id, state: appointment.resultProtectionState }]
      : []);
  return {
    appointmentIds: appointments.map((appointment) => appointment.id),
    submissionIds: protectedStates.flatMap(({ state }) => state.submissionId ? [state.submissionId] : []),
    activeDraftFileCount: protectedStates.reduce(
      (count, { state }) => count + (state.activeFileCount ?? 0),
      0,
    ),
  };
}

function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
}

function assertCalendarReader(actor: SessionUser) {
  if (actor.role !== "ADMIN" && actor.role !== "CLINIC_STAFF") {
    throw new AppError("FORBIDDEN", "You do not have permission to view the clinic calendar.", 403);
  }
}

function validationError(message: string, details?: unknown) {
  return new AppError("VALIDATION_ERROR", message, 422, undefined, details);
}

function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseRequest(
  raw: unknown,
  options: {
    requireEmergencyAcknowledgement?: boolean;
    requireRecoveryMode?: boolean;
  } = {},
): ParsedCalendarRequest {
  const parsed = (
    options.requireRecoveryMode === false ? previewRequestSchema : requestSchema
  ).safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the clinic calendar request.", parsed.error.flatten());
  const request = parsed.data as ParsedCalendarRequest;
  const today = manilaToday();
  const seen = new Set<string>();
  for (const change of request.changes) {
    if (seen.has(change.date)) throw validationError("Only one change is allowed for each date.");
    seen.add(change.date);
    if (Number(change.date.slice(0, 4)) > 2100) {
      throw validationError("Calendar dates may not be later than 2100.");
    }
    if (change.date < today) throw validationError("Past dates cannot be edited.");
    if (change.action === "BLOCK") {
      if (!isClinicSchedulingWeekday(change.date)) throw validationError("Weekends cannot be blocked.");
      if (change.date === today && change.category !== "EMERGENCY_CLOSURE") {
        throw validationError("Today may be blocked only as an Emergency Closure.");
      }
      if (
        change.date === today
        && options.requireEmergencyAcknowledgement !== false
        && !request.emergencyAcknowledged
      ) {
        throw new AppError(
          "EMERGENCY_ACKNOWLEDGMENT_REQUIRED",
          "A same-day emergency closure requires explicit acknowledgment.",
          422,
        );
      }
      change.reason = normalizeClosureReason(change.reason);
    }
  }
  return request;
}

function payloadHash(request: ParsedCalendarRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

async function validateCalendarState(
  activeDates: Awaited<ReturnType<typeof lockAllActiveUnavailableDates>>,
  changes: ClinicCalendarChange[],
) {
  const activeByDate = new Map(activeDates.map((date) => [date.blockedDate, date]));
  const activeById = new Map(activeDates.map((date) => [date.id, date]));
  for (const change of changes) {
    if (change.action === "BLOCK" && activeByDate.has(change.date)) {
      throw new AppError("CLINIC_CALENDAR_CONFLICT", `${change.date} is already blocked.`, 409);
    }
    if (change.action === "REOPEN") {
      const active = activeById.get(change.unavailableDateId);
      if (!active || active.blockedDate !== change.date || active.updatedAt !== change.expectedUpdatedAt) {
        throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload before reopening this date.", 409);
      }
    }
  }
}

async function loadAffectedCycles(client: PoolClient, dates: string[], lock: boolean) {
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

function applicableGroups(cycle: CalendarCycle, groups: PersistedGroup[] | ReturnType<typeof groupContiguousClosureChanges>) {
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
  PROTECTED_RESULTS_EXIST: 5,
  PHYSICAL_COMPLETED_BEFORE_LABORATORY: 6,
  PAIR_MISSING_OR_INCONSISTENT: 7,
  UNSAFE_RESTORATION: 8,
  ADMIN_CHOSE_MANUAL_RECOVERY: 9,
  NO_REPLACEMENT_CAPACITY: 10,
  CONCURRENT_APPOINTMENT_CHANGE: 11,
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

function evaluateCycleRecovery(input: {
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

function sortRecoveryCycles(cycles: CalendarCycle[], groups: ClosureGroupLike[]) {
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

function reasonGroups(reasonCounts: Map<ClinicManualCaseReason, number>) {
  return [...reasonCounts.entries()]
    .sort((left, right) =>
      manualReasonPriority[left[0]] - manualReasonPriority[right[0]]
      || left[0].localeCompare(right[0]))
    .map(([reasonCode, count]) => ({ reasonCode, count }));
}

function addReasonCount(
  counts: Map<ClinicManualCaseReason, number>,
  reasonCode: ClinicManualCaseReason,
) {
  counts.set(reasonCode, (counts.get(reasonCode) ?? 0) + 1);
}

async function loadCapacity(client: PoolClient) {
  const capacityRows = await client.query<{ schedule_type: keyof ReplacementCapacity; max_daily_capacity: number }>(
    `SELECT setting.schedule_type,setting.max_daily_capacity
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE clinic.code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
  );
  const capacity = Object.fromEntries(
    capacityRows.rows.map((row) => [row.schedule_type, row.max_daily_capacity]),
  ) as ReplacementCapacity;
  if (!capacity.LABORATORY || !capacity.PHYSICAL_EXAM) {
    throw new AppError("CLINIC_CAPACITY_NOT_CONFIGURED", "Clinic capacity is not configured.", 500);
  }
  const usedRows = await client.query<{
    schedule_type: keyof ReplacementCapacity;
    appointment_date: string;
    used: number;
  }>(
    `SELECT schedule_type,appointment_date::text,COUNT(*)::int AS used
       FROM appointments
      WHERE is_published=TRUE AND status IN ('DRAFT','PENDING')
        AND NOT (schedule_type='LABORATORY' AND ovpsa_batch_id IS NOT NULL)
      GROUP BY schedule_type,appointment_date`,
  );
  const usedCapacity: UsedReplacementCapacity = {
    LABORATORY: new Map(),
    PHYSICAL_EXAM: new Map(),
  };
  for (const row of usedRows.rows) usedCapacity[row.schedule_type].set(row.appointment_date, row.used);
  return { capacity, usedCapacity };
}

function reserveCapacity(
  used: UsedReplacementCapacity,
  dates: { laboratoryDate?: string; physicalExamDate?: string },
) {
  if (dates.laboratoryDate) {
    used.LABORATORY.set(dates.laboratoryDate, (used.LABORATORY.get(dates.laboratoryDate) ?? 0) + 1);
  }
  if (dates.physicalExamDate) {
    used.PHYSICAL_EXAM.set(dates.physicalExamDate, (used.PHYSICAL_EXAM.get(dates.physicalExamDate) ?? 0) + 1);
  }
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

async function markOvpsaLaboratoryClosure(
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

function allocateCycleRecovery(input: {
  cycle: CalendarCycle;
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
  if (
    classification.strategy === "MOVE_COMPLETE_PAIR"
    && input.affectedAppointmentIds.has(classification.laboratory.id)
    && !input.affectedAppointmentIds.has(classification.physicalExam.id)
  ) {
    const laboratoryCandidate = allocateReplacementDates({
      strategy: "MOVE_LABORATORY_ONLY",
      afterDate: input.afterDate,
      blockedDates: input.blockedDates,
      blockedDatesByService: input.blockedDatesByService,
      usedCapacity: input.usedCapacity,
      capacity: input.capacity,
    });
    classification = classifyClinicCycle(input.cycle.appointments, {
      affectedAppointmentIds: input.affectedAppointmentIds,
      proposedLaboratoryDate: laboratoryCandidate.laboratoryDate,
    });
    if (classification.strategy === "MOVE_LABORATORY_ONLY") {
      return { classification, dates: laboratoryCandidate };
    }
  }
  if (
    classification.strategy === "MANUAL_RESOLUTION_REQUIRED"
    || classification.strategy === "PRESERVE_COMPLETION"
  ) {
    return { classification, dates: {} };
  }
  return {
    classification,
    dates: allocateReplacementDates({
      strategy: classification.strategy,
      afterDate: input.afterDate,
      blockedDates: input.blockedDates,
      blockedDatesByService: input.blockedDatesByService,
      usedCapacity: input.usedCapacity,
      capacity: input.capacity,
    }),
  };
}

function movedAppointmentCount(classification: ClinicCycleClassification) {
  if (classification.strategy === "MOVE_COMPLETE_PAIR") return 2;
  if (
    classification.strategy === "MOVE_LABORATORY_ONLY"
    || classification.strategy === "MOVE_PHYSICAL_ONLY"
  ) return 1;
  return 0;
}

async function createClosureNotification(
  client: PoolClient,
  input: {
    studentNumber: string;
    build: (state: AuthoritativeScheduleState) => StudentNotificationInput;
    actorUserId: string;
    auditEntityId: string;
    auditEntityType?: "appointment_reschedule_event" | "clinic_closure_manual_case" | "ovpsa_first_year_batch";
  },
) {
  const result = await queueAuthoritativeScheduleNotification(
    client,
    input.studentNumber,
    input.build,
  );
  for (const warning of result.warnings) {
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'CLINIC_CLOSURE_NOTIFICATION_WARNING',$5,$2,
                jsonb_build_object('studentNumber',$3::text,'channel',$4::text))`,
      [
        input.actorUserId,
        input.auditEntityId,
        input.studentNumber,
        warning.channel,
        input.auditEntityType ?? "appointment_reschedule_event",
      ],
    );
  }
  return result.warnings.length;
}

function previousScheduleForAppointments(appointments: Array<{
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  ovpsaBatchId?: string | null;
}>): PreviousScheduleState {
  const laboratory = appointments.find((appointment) => appointment.scheduleType === "LABORATORY");
  const physicalExam = appointments.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM");
  return {
    laboratory: laboratory ? {
      date: laboratory.appointmentDate,
      location: laboratory.ovpsaBatchId ? "Iloilo Mission Hospital" : "KABALAKA Clinic",
    } : undefined,
    physicalExam: physicalExam ? {
      date: physicalExam.appointmentDate,
      location: "CPU Clinic",
    } : undefined,
  };
}

async function applyAutomaticMove(
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
             clinic_id,student_number,schedule_type,appointment_date,status,is_published,
             notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start
           ) VALUES ($1,$2,$3,$4,'PENDING',TRUE,$5,$6,$7,$7,$8,$9)
           RETURNING id::text`,
          [
            input.clinicIds[original.scheduleType],
            input.cycle.studentNumber,
            original.scheduleType,
            appointmentDate,
            `Automatically rescheduled after closure group ${input.group.closureGroupId}.`,
            original.id,
            input.actorUserId,
            original.schedulePairId,
            original.scheduleCycleStart,
          ],
        );
    replacementByType[original.scheduleType] = inserted.rows[0].id;
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

async function createManualFallback(
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

export async function listClinicUnavailableDates(actor: SessionUser) {
  assertCalendarReader(actor);
  return listActiveClinicUnavailableDateRecords();
}

export async function previewClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarPreviewResult> {
  assertAdmin(actor);
  const request = parseRequest(raw, {
    requireEmergencyAcknowledgement: false,
    requireRecoveryMode: false,
  });
  return transaction(async (client) => {
    const active = await listActiveUnavailableDatesWithClient(client);
    await validateCalendarState(active, request.changes);
    const blockChanges = request.changes.filter((change): change is ClinicCalendarBlockChange => change.action === "BLOCK");
    const groups = groupContiguousClosureChanges(blockChanges);
    const cycles = sortRecoveryCycles(
      await loadAffectedCycles(client, blockChanges.map((change) => change.date), false),
      groups,
    );
    const blockedDates = await listUnifiedBlockedDateSet(client);
    for (const change of blockChanges) blockedDates.add(change.date);
    const serviceBlockedDates = await loadSchedulingBlockedDates(client, {
      startDate: manilaToday(),
      endDate: addCalendarDays(manilaToday(), 366 * 5),
    });
    const { capacity, usedCapacity } = await loadCapacity(client);
    let automaticRecoveryEligibleCount = 0;
    let manualResolutionRequiredCount = 0;
    let completePairMoveEstimate = 0;
    let laboratoryOnlyMoveEstimate = 0;
    let physicalOnlyMoveEstimate = 0;
    let preservedAppointmentCount = 0;
    let expectedCapacityFallbackCount = 0;
    const reasonCounts = new Map<ClinicManualCaseReason, number>();
    for (const cycle of cycles) {
      const cycleGroups = applicableGroups(cycle, groups);
      if (!cycleGroups.length) continue;
      const policy = evaluateCycleRecovery({
        cycle,
        groups: cycleGroups,
        recoveryMode: "AUTO_ELIGIBLE",
        policyEffectiveDate: manilaToday(),
      });
      if (policy.decision === "MANUAL_RESOLUTION_REQUIRED") {
        manualResolutionRequiredCount += 1;
        addReasonCount(reasonCounts, policy.reasonCode!);
        preservedAppointmentCount += cycle.appointments.filter((appointment) =>
          !policy.affectedAppointmentIds.has(appointment.id)
          || appointment.status === "COMPLETED").length;
        continue;
      }
      try {
        const planned = allocateCycleRecovery({
          cycle,
          affectedAppointmentIds: policy.affectedAppointmentIds,
          afterDate: cycleGroups.reduce(
            (latest, group) => group.endDate > latest ? group.endDate : latest,
            cycleGroups[0].endDate,
          ),
          blockedDates,
          blockedDatesByService: {
            LABORATORY: new Set(serviceBlockedDates.laboratoryDates),
            PHYSICAL_EXAM: new Set(serviceBlockedDates.physicalExamDates),
          },
          usedCapacity,
          capacity,
        });
        if (planned.classification.strategy === "PRESERVE_COMPLETION") {
          preservedAppointmentCount += cycle.appointments.length;
          automaticRecoveryEligibleCount += 1;
          continue;
        }
        if (planned.classification.strategy === "MANUAL_RESOLUTION_REQUIRED") {
          manualResolutionRequiredCount += 1;
          addReasonCount(reasonCounts, planned.classification.reasonCode);
          continue;
        }
        automaticRecoveryEligibleCount += 1;
        if (planned.classification.strategy === "MOVE_COMPLETE_PAIR") completePairMoveEstimate += 1;
        if (planned.classification.strategy === "MOVE_LABORATORY_ONLY") laboratoryOnlyMoveEstimate += 1;
        if (planned.classification.strategy === "MOVE_PHYSICAL_ONLY") physicalOnlyMoveEstimate += 1;
        preservedAppointmentCount += cycle.appointments.length
          - movedAppointmentCount(planned.classification);
        reserveCapacity(usedCapacity, planned.dates);
      } catch (error) {
        if (!(error instanceof ClinicCalendarPlanningError)) throw error;
        expectedCapacityFallbackCount += 1;
        manualResolutionRequiredCount += 1;
        addReasonCount(reasonCounts, error.reasonCode);
        preservedAppointmentCount += cycle.appointments.filter((appointment) =>
          !policy.affectedAppointmentIds.has(appointment.id)
          || appointment.status === "COMPLETED").length;
      }
    }
    return {
      requestId: request.requestId,
      closureGroups: groups,
      datesBeingReopened: request.changes.filter((change) => change.action === "REOPEN").map((change) => change.date),
      affectedStudentCount: new Set(cycles.map((cycle) => cycle.studentNumber)).size,
      automaticRecoveryEligibleCount,
      manualResolutionRequiredCount,
      completePairMoveEstimate,
      laboratoryOnlyMoveEstimate,
      physicalOnlyMoveEstimate,
      preservedAppointmentCount,
      expectedCapacityFallbackCount,
      manualReasonGroups: reasonGroups(reasonCounts),
    };
  });
}

export async function saveClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarOperationResult> {
  assertAdmin(actor);
  const request = parseRequest(raw, { requireRecoveryMode: true });
  if (!request.recoveryMode) throw validationError("Choose a closure recovery mode.");
  const recoveryMode = request.recoveryMode;
  const hash = payloadHash(request);
  try {
    return await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      const prior = await client.query<{ payload_hash: string; result: ClinicCalendarOperationResult }>(
        "SELECT payload_hash,result FROM clinic_calendar_requests WHERE request_id=$1 FOR UPDATE",
        [request.requestId],
      );
      if (prior.rowCount) {
        if (prior.rows[0].payload_hash !== hash) {
          throw new AppError(
            "CLINIC_CALENDAR_REQUEST_CONFLICT",
            "This request ID was already used with a different payload.",
            409,
          );
        }
        return prior.rows[0].result;
      }

      const active = await lockAllActiveUnavailableDates(client);
      await validateCalendarState(active, request.changes);
      const batchId = randomUUID();
      const blockChanges = request.changes.filter((change): change is ClinicCalendarBlockChange => change.action === "BLOCK");
      const groups = groupContiguousClosureChanges(blockChanges);
      const persistedGroups: PersistedGroup[] = [];
      for (const group of groups) {
        const inserted = await createClosureGroupWithDates(
          client,
          group,
          actor.userId,
          batchId,
          recoveryMode,
          manilaToday(),
        );
        persistedGroups.push({
          ...group,
          closureGroupId: inserted.closureGroupId,
          dateIds: inserted.dates,
        });
      }

      const reopenChanges = request.changes.filter((change) => change.action === "REOPEN");
      const lockedReopenings = await lockActiveUnavailableDates(
        client,
        reopenChanges.map((change) => change.unavailableDateId),
      );
      if (lockedReopenings.length !== reopenChanges.length) {
        throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload and try again.", 409);
      }
      for (const change of reopenChanges) {
        const reopened = await reopenUnavailableDate(client, {
          id: change.unavailableDateId,
          expectedUpdatedAt: change.expectedUpdatedAt,
          actorUserId: actor.userId,
          batchId,
        });
        if (!reopened) throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload and try again.", 409);
      }

      const cycles = sortRecoveryCycles(
        await loadAffectedCycles(client, blockChanges.map((change) => change.date), true),
        persistedGroups,
      );
      const blockedDates = await listUnifiedBlockedDateSet(client);
      const serviceBlockedDates = await loadSchedulingBlockedDates(client, {
        startDate: manilaToday(),
        endDate: addCalendarDays(manilaToday(), 366 * 5),
      });
      const { capacity, usedCapacity } = await loadCapacity(client);
      const clinicRows = await client.query<{ id: string; code: keyof ReplacementCapacity }>(
        `SELECT id::text,CASE code
           WHEN 'KABALAKA_CLINIC' THEN 'LABORATORY'
           WHEN 'CPU_CLINIC' THEN 'PHYSICAL_EXAM'
         END AS code
           FROM clinics WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
      );
      const clinicIds = Object.fromEntries(clinicRows.rows.map((row) => [row.code, row.id])) as {
        LABORATORY: string;
        PHYSICAL_EXAM: string;
      };
      let movedStudentCount = 0;
      let movedAppointmentCount = 0;
      let preservedAppointmentCount = 0;
      let manualCaseCount = 0;
      let capacityFallbackCount = 0;
      let notificationWarningCount = 0;
      const manualReasonCounts = new Map<ClinicManualCaseReason, number>();
      const ovpsaPhysicalReservationsToRelease = new Set<string>();
      for (const [index, cycle] of cycles.entries()) {
        const cycleGroups = applicableGroups(cycle, persistedGroups) as PersistedGroup[];
        if (!cycleGroups.length) continue;
        const policy = evaluateCycleRecovery({
          cycle,
          groups: cycleGroups,
          recoveryMode,
          policyEffectiveDate: manilaToday(),
        });
        const group = policy.group as PersistedGroup;
        const affectsOvpsaLaboratory = cycle.appointments.some((appointment) =>
          appointment.scheduleType === "LABORATORY"
          && appointment.ovpsaBatchId
          && policy.affectedAppointmentIds.has(appointment.id));
        if (!affectsOvpsaLaboratory) {
          for (const appointment of cycle.appointments) {
            if (
              appointment.scheduleType === "PHYSICAL_EXAM"
              && appointment.ovpsaServiceReservationId
              && policy.affectedAppointmentIds.has(appointment.id)
            ) {
              ovpsaPhysicalReservationsToRelease.add(appointment.ovpsaServiceReservationId);
            }
          }
        }
        const unavailableDateIds = [...new Set(cycleGroups.flatMap((item) => item.dateIds.map((date) => date.id)))];
        const policyMetadata = { ...policy.policyMetadata, recoveryQueuePosition: index + 1 };
        const savepoint = `clinic_student_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          if (policy.decision === "MANUAL_RESOLUTION_REQUIRED") {
            if (policy.reasonCode === "OVPSA_LABORATORY_PROTECTED") {
              await markOvpsaLaboratoryClosure(client, {
                cycle,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                closureGroupId: group.closureGroupId,
                actorUserId: actor.userId,
              });
            }
            const manual = await createManualFallback(client, {
              cycle,
              reasonCode: policy.reasonCode!,
              reasonMessage: policy.reasonMessage!,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
              affectedAppointmentIds: policy.affectedAppointmentIds,
              policyMetadata,
            });
            manualCaseCount += 1;
            notificationWarningCount += manual.notificationWarningCount;
            addReasonCount(manualReasonCounts, policy.reasonCode!);
            preservedAppointmentCount += cycle.appointments.filter((appointment) =>
              !policy.affectedAppointmentIds.has(appointment.id)
              || appointment.status === "COMPLETED").length;
          } else {
            let planned: ReturnType<typeof allocateCycleRecovery>;
            try {
              planned = allocateCycleRecovery({
                cycle,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                afterDate: cycleGroups.reduce(
                  (latest, item) => item.endDate > latest ? item.endDate : latest,
                  cycleGroups[0].endDate,
                ),
                blockedDates,
                blockedDatesByService: {
                  LABORATORY: new Set(serviceBlockedDates.laboratoryDates),
                  PHYSICAL_EXAM: new Set(serviceBlockedDates.physicalExamDates),
                },
                usedCapacity,
                capacity,
              });
            } catch (error) {
              if (!(error instanceof ClinicCalendarPlanningError)) throw error;
              const manual = await createManualFallback(client, {
                cycle,
                reasonCode: error.reasonCode,
                reasonMessage: error.message,
                group,
                unavailableDateIds,
                batchId,
                actorUserId: actor.userId,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                policyMetadata: { ...policyMetadata, fallbackReasonCode: error.reasonCode },
              });
              manualCaseCount += 1;
              capacityFallbackCount += error.reasonCode === "NO_REPLACEMENT_CAPACITY" ? 1 : 0;
              notificationWarningCount += manual.notificationWarningCount;
              addReasonCount(manualReasonCounts, error.reasonCode);
              preservedAppointmentCount += cycle.appointments.filter((appointment) =>
                !policy.affectedAppointmentIds.has(appointment.id)
                || appointment.status === "COMPLETED").length;
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            if (planned.classification.strategy === "PRESERVE_COMPLETION") {
              preservedAppointmentCount += cycle.appointments.length;
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            if (planned.classification.strategy === "MANUAL_RESOLUTION_REQUIRED") {
              const manual = await createManualFallback(client, {
                cycle,
                reasonCode: planned.classification.reasonCode,
                reasonMessage: planned.classification.reasonMessage,
                group,
                unavailableDateIds,
                batchId,
                actorUserId: actor.userId,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                policyMetadata,
              });
              manualCaseCount += 1;
              notificationWarningCount += manual.notificationWarningCount;
              addReasonCount(manualReasonCounts, planned.classification.reasonCode);
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            const moved = await applyAutomaticMove(client, {
              cycle,
              classification: planned.classification,
              dates: planned.dates,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
              clinicIds,
              policyMetadata,
            });
            reserveCapacity(usedCapacity, planned.dates);
            movedStudentCount += 1;
            movedAppointmentCount += moved.movedAppointmentCount;
            notificationWarningCount += moved.notificationWarningCount;
            preservedAppointmentCount += cycle.appointments.length
              - moved.movedAppointmentCount;
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          if (!(error instanceof ClinicCalendarPlanningError)) throw error;
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          const manual = await createManualFallback(client, {
            cycle,
            reasonCode: error.reasonCode,
            reasonMessage: error.message,
            group,
            unavailableDateIds,
            batchId,
            actorUserId: actor.userId,
            affectedAppointmentIds: policy.affectedAppointmentIds,
            policyMetadata: { ...policyMetadata, fallbackReasonCode: error.reasonCode },
          });
          manualCaseCount += 1;
          capacityFallbackCount += error.reasonCode === "NO_REPLACEMENT_CAPACITY" ? 1 : 0;
          notificationWarningCount += manual.notificationWarningCount;
          addReasonCount(manualReasonCounts, error.reasonCode);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      }

      if (ovpsaPhysicalReservationsToRelease.size) {
        await client.query(
          `UPDATE ovpsa_first_year_service_reservations
              SET status='RELEASED',released_at=clock_timestamp(),released_by=$2,
                  release_reason='Clinic closure recovery moved the assigned Physical Examination.'
            WHERE id=ANY($1::uuid[]) AND status IN ('ACTIVE','INVALIDATED')`,
          [[...ovpsaPhysicalReservationsToRelease], actor.userId],
        );
      }

      const result: ClinicCalendarOperationResult = {
        requestId: request.requestId,
        batchId,
        activeUnavailableDates: await listActiveUnavailableDatesWithClient(client),
        blockedDateCount: blockChanges.length,
        reopenedDateCount: reopenChanges.length,
        autoRecoveredStudentCount: movedStudentCount,
        movedStudentCount,
        movedAppointmentCount,
        preservedAppointmentCount,
        manualCaseCount,
        capacityFallbackCount,
        manualReasonGroups: reasonGroups(manualReasonCounts),
        notificationWarningCount,
      };
      await client.query(
        `INSERT INTO clinic_calendar_requests (
           request_id,payload_hash,batch_id,result,created_by
         ) VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [request.requestId, hash, batchId, JSON.stringify(result), actor.userId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         VALUES ($1,'UNIFIED_CLINIC_CALENDAR_UPDATED','clinic_calendar_request',$2::text,
                 jsonb_build_object(
                   'requestId',$2::text,'batchId',$3::text,'blockedDateCount',$4::int,
                   'reopenedDateCount',$5::int,'movedStudentCount',$6::int,
                   'movedAppointmentCount',$7::int,'preservedAppointmentCount',$8::int,
                   'manualCaseCount',$9::int,'capacityFallbackCount',$10::int,
                   'notificationWarningCount',$11::int,'emergencyAcknowledged',$12::boolean,
                   'recoveryMode',$13::text,'manualReasonGroups',$14::jsonb
                 ))`,
        [
          actor.userId,
          request.requestId,
          batchId,
          result.blockedDateCount,
          result.reopenedDateCount,
          result.movedStudentCount,
          result.movedAppointmentCount,
          result.preservedAppointmentCount,
          result.manualCaseCount,
          result.capacityFallbackCount,
          result.notificationWarningCount,
          request.emergencyAcknowledged,
          recoveryMode,
          JSON.stringify(result.manualReasonGroups),
        ],
      );
      return result;
    });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "constraint" in error
      && error.constraint === "clinic_unavailable_dates_one_active_day_idx"
    ) {
      throw new AppError("CLINIC_CALENDAR_CONFLICT", "A selected date was blocked concurrently.", 409);
    }
    throw error;
  }
}

export async function listClinicClosureManualCases(
  raw: {
    page?: number;
    pageSize?: number;
    search?: string;
    reasonCode?: string;
    status?: string;
    closureGroupId?: string;
    date?: string;
    service?: string;
  },
  actor: SessionUser,
) {
  assertAdmin(actor);
  const page = Math.max(1, Number(raw.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(raw.pageSize) || 20));
  const search = raw.search?.trim() || null;
  const reasonCode = raw.reasonCode?.trim() || null;
  const status = raw.status?.trim() || "OPEN";
  const closureGroupId = raw.closureGroupId?.trim() || null;
  const date = raw.date?.trim() || null;
  const service = raw.service?.trim() || null;
  const loaded = await transaction(async (client) => {
    const result = await client.query<{
    id: string;
    student_number: string;
    student_name: string;
    closure_group_id: string;
    group_start_date: string;
    group_end_date: string;
    reason_code: ClinicManualCaseReason;
    reason_message: string;
    status: string;
    optimistic_token: string;
    created_at: Date;
    resolved_at: Date | null;
    resolution_action: string | null;
    resolution_details: unknown;
    policy_metadata: Record<string, unknown>;
    category: string;
    closure_reason: string;
    laboratory_id: string | null;
    laboratory_date: string | null;
    laboratory_status: string | null;
    laboratory_is_manually_locked: boolean | null;
    physical_exam_id: string | null;
    physical_exam_date: string | null;
    physical_exam_status: string | null;
    physical_exam_is_manually_locked: boolean | null;
    ovpsa_batch_optimistic_token: string | null;
    replacement_laboratory_id: string | null;
    replacement_laboratory_is_manually_locked: boolean | null;
    replacement_physical_exam_id: string | null;
    replacement_physical_exam_is_manually_locked: boolean | null;
    total: number;
  }>(
    `SELECT manual_case.id::text,manual_case.student_number,
            ${studentDisplayNameSql("student")} AS student_name,
            manual_case.closure_group_id::text,closure.start_date::text AS group_start_date,
            closure.end_date::text AS group_end_date,manual_case.reason_code,
            manual_case.reason_message,manual_case.status,
            manual_case.optimistic_token::text,manual_case.created_at,manual_case.resolved_at,
            manual_case.resolution_action,manual_case.resolution_details,
            manual_case.policy_metadata,
            closure.category,closure.reason AS closure_reason,
            laboratory.id::text AS laboratory_id,laboratory.appointment_date::text AS laboratory_date,
            laboratory.status AS laboratory_status,
            laboratory.is_manually_locked AS laboratory_is_manually_locked,
            physical.id::text AS physical_exam_id,physical.appointment_date::text AS physical_exam_date,
            physical.status AS physical_exam_status,
            physical.is_manually_locked AS physical_exam_is_manually_locked,
            replacement_laboratory.id::text AS replacement_laboratory_id,
            replacement_laboratory.is_manually_locked AS replacement_laboratory_is_manually_locked,
            replacement_physical.id::text AS replacement_physical_exam_id,
            replacement_physical.is_manually_locked AS replacement_physical_exam_is_manually_locked,
            ovpsa_batch.optimistic_token::text AS ovpsa_batch_optimistic_token,
            COUNT(*) OVER()::int AS total
       FROM clinic_closure_manual_cases manual_case
       JOIN students student ON student.student_number=manual_case.student_number
       JOIN clinic_closure_groups closure ON closure.id=manual_case.closure_group_id
       LEFT JOIN appointments laboratory ON laboratory.id=manual_case.affected_laboratory_appointment_id
       LEFT JOIN appointments physical ON physical.id=manual_case.affected_physical_exam_appointment_id
       LEFT JOIN appointment_reschedule_events event ON event.manual_case_id=manual_case.id
       LEFT JOIN appointments replacement_laboratory
         ON replacement_laboratory.id=event.new_laboratory_appointment_id
       LEFT JOIN appointments replacement_physical
         ON replacement_physical.id=event.new_physical_exam_appointment_id
       LEFT JOIN ovpsa_first_year_batches ovpsa_batch
         ON ovpsa_batch.id::text=manual_case.policy_metadata->>'ovpsaBatchId'
      WHERE ($1::text IS NULL OR manual_case.student_number ILIKE '%'||$1||'%'
             OR student.first_name ILIKE '%'||$1||'%' OR student.last_name ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR manual_case.reason_code=$2)
        AND ($3::text IS NULL OR manual_case.status=$3)
        AND ($4::uuid IS NULL OR manual_case.closure_group_id=$4)
        AND ($5::date IS NULL OR $5 BETWEEN closure.start_date AND closure.end_date
             OR laboratory.appointment_date=$5 OR physical.appointment_date=$5)
        AND ($6::text IS NULL
             OR ($6='LABORATORY' AND laboratory.id IS NOT NULL)
             OR ($6='PHYSICAL_EXAM' AND physical.id IS NOT NULL))
      ORDER BY manual_case.created_at,manual_case.id
      LIMIT $7 OFFSET $8`,
    [search, reasonCode, status || null, closureGroupId, date, service, pageSize, (page - 1) * pageSize],
    );
    const appointmentIds = result.rows.flatMap((row) =>
      [
        row.laboratory_id,
        row.physical_exam_id,
        row.replacement_laboratory_id,
        row.replacement_physical_exam_id,
      ].filter((id): id is string => Boolean(id)));
    const protectionStates = await loadAppointmentResultProtectionStates(client, appointmentIds);
    return { result, protectionStates };
  });
  const { result, protectionStates } = loaded;
  return {
    page,
    pageSize,
    total: result.rows[0]?.total ?? 0,
    items: result.rows.map((row) => {
      const affectedIds = new Set(
        Array.isArray(row.policy_metadata.affectedAppointmentIds)
          ? row.policy_metadata.affectedAppointmentIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      return ({
      id: row.id,
      studentNumber: row.student_number,
      studentName: row.student_name,
      closureGroupId: row.closure_group_id,
      groupStartDate: row.group_start_date,
      groupEndDate: row.group_end_date,
      reasonCode: row.reason_code,
      reasonMessage: row.reason_message,
      status: row.status,
      optimisticToken: row.optimistic_token,
      createdAt: row.created_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      resolutionAction: row.resolution_action,
      resolutionDetails: row.resolution_details,
      policyMetadata: row.policy_metadata,
      ovpsaBatchId: typeof row.policy_metadata.ovpsaBatchId === "string"
        ? row.policy_metadata.ovpsaBatchId
        : null,
      ovpsaBatchOptimisticToken: row.ovpsa_batch_optimistic_token,
      category: row.category,
      closureReason: row.closure_reason,
      laboratory: row.laboratory_id ? {
        id: row.laboratory_id,
        date: row.laboratory_date,
        status: row.laboratory_status,
        affected: affectedIds.has(row.laboratory_id),
      } : null,
      physicalExam: row.physical_exam_id ? {
        id: row.physical_exam_id,
        date: row.physical_exam_date,
        status: row.physical_exam_status,
        affected: affectedIds.has(row.physical_exam_id),
      } : null,
      currentAssignmentBlock: currentAssignmentBlock([
        ...(row.laboratory_id ? [{
          isManuallyLocked: Boolean(row.laboratory_is_manually_locked),
          resultProtectionState: protectionStates.get(row.laboratory_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.physical_exam_id ? [{
          isManuallyLocked: Boolean(row.physical_exam_is_manually_locked),
          resultProtectionState: protectionStates.get(row.physical_exam_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.replacement_laboratory_id ? [{
          isManuallyLocked: Boolean(row.replacement_laboratory_is_manually_locked),
          resultProtectionState: protectionStates.get(row.replacement_laboratory_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.replacement_physical_exam_id ? [{
          isManuallyLocked: Boolean(row.replacement_physical_exam_is_manually_locked),
          resultProtectionState: protectionStates.get(row.replacement_physical_exam_id) ?? { type: "CLEAR" as const },
        }] : []),
      ]),
    }); }),
  };
}

async function loadAppointmentStates(client: PoolClient, ids: string[]) {
  if (!ids.length) return [];
  const result = await client.query<{
    id: string;
    clinic_id: string;
    student_number: string;
    schedule_type: AppointmentState["scheduleType"];
    appointment_date: string;
    status: string;
    is_published: boolean;
    is_manually_locked: boolean;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    rescheduled_from: string | null;
    ovpsa_batch_id: string | null;
    ovpsa_revision_id: string | null;
    ovpsa_service_reservation_id: string | null;
  }>(
    `SELECT appointment.id::text,appointment.clinic_id::text,appointment.student_number,
            appointment.schedule_type,appointment.appointment_date::text,appointment.status,
            appointment.is_published,appointment.is_manually_locked,
            appointment.schedule_pair_id::text,appointment.schedule_cycle_start,
            appointment.rescheduled_from::text,appointment.ovpsa_batch_id::text,
            appointment.ovpsa_revision_id::text,appointment.ovpsa_service_reservation_id::text
       FROM appointments appointment WHERE appointment.id=ANY($1::uuid[]) ORDER BY appointment.id FOR UPDATE`,
    [ids],
  );
  const protectionStates = await loadAppointmentResultProtectionStates(
    client,
    result.rows.map((row) => row.id),
  );
  return result.rows.map((row): AppointmentState => ({
    id: row.id,
    clinicId: row.clinic_id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    isPublished: row.is_published,
    isManuallyLocked: row.is_manually_locked,
    resultProtectionState: protectionStates.get(row.id) ?? { type: "CLEAR" },
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    rescheduledFrom: row.rescheduled_from,
    ovpsaBatchId: row.ovpsa_batch_id,
    ovpsaRevisionId: row.ovpsa_revision_id,
    ovpsaServiceReservationId: row.ovpsa_service_reservation_id,
  }));
}

async function assertManualDateAvailable(
  client: PoolClient,
  scheduleType: AppointmentState["scheduleType"],
  date: string,
) {
  if (date < manilaToday() || !isClinicSchedulingWeekday(date)) {
    throw validationError("Manual replacement dates must be current or future weekdays.");
  }
  if (await isSchedulingDateBlocked(client, { scheduleType, date })) {
    throw new AppError("CLINIC_CALENDAR_CONFLICT", `${date} is blocked or reserved.`, 409);
  }
  const capacity = await client.query<{ max_daily_capacity: number; used: number }>(
    `SELECT setting.max_daily_capacity,
            (SELECT COUNT(*)::int FROM appointments appointment
              WHERE appointment.schedule_type=$1 AND appointment.appointment_date=$2
                AND appointment.is_published=TRUE AND appointment.status IN ('DRAFT','PENDING')
                AND NOT (
                  appointment.schedule_type='LABORATORY'
                  AND appointment.ovpsa_batch_id IS NOT NULL
                )) AS used
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE setting.schedule_type=$1
        AND clinic.code=CASE $1 WHEN 'LABORATORY' THEN 'KABALAKA_CLINIC' ELSE 'CPU_CLINIC' END`,
    [scheduleType, date],
  );
  if (!capacity.rowCount || capacity.rows[0].used >= capacity.rows[0].max_daily_capacity) {
    throw new AppError("CLINIC_CAPACITY_CONFLICT", `${date} has no remaining capacity.`, 409);
  }
}

export async function resolveClinicClosureManualCase(
  caseId: string,
  raw: unknown,
  actor: SessionUser,
) {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(caseId).success) throw validationError("The manual case ID is invalid.");
  const parsed = resolutionSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the manual resolution.", parsed.error.flatten());
  const request = parsed.data as ClinicManualCaseResolutionRequest;
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const caseResult = await client.query<{
      id: string;
      student_number: string;
      closure_group_id: string;
      schedule_pair_id: string | null;
      schedule_cycle_start: number;
      affected_laboratory_appointment_id: string | null;
      affected_physical_exam_appointment_id: string | null;
      status: string;
      optimistic_token: string;
      reason_code: string;
    }>(
      `SELECT id::text,student_number,closure_group_id::text,schedule_pair_id::text,
              schedule_cycle_start,affected_laboratory_appointment_id::text,
              affected_physical_exam_appointment_id::text,status,optimistic_token::text,reason_code
         FROM clinic_closure_manual_cases WHERE id=$1 FOR UPDATE`,
      [caseId],
    );
    const manualCase = caseResult.rows[0];
    if (!manualCase) throw new AppError("MANUAL_CASE_NOT_FOUND", "Manual case not found.", 404);
    if (manualCase.status !== "OPEN") throw new AppError("MANUAL_CASE_ALREADY_RESOLVED", "This manual case is already resolved.", 409);
    if (manualCase.optimistic_token !== request.expectedOptimisticToken) {
      throw new AppError("MANUAL_CASE_STALE", "The manual case changed. Reload and try again.", 409);
    }
    if (manualCase.reason_code === "OVPSA_LABORATORY_PROTECTED") {
      throw new AppError(
        "OVPSA_BATCH_RECOVERY_REQUIRED",
        "Resolve this Laboratory closure through the coordinated OVPSA batch recovery.",
        409,
      );
    }
    const affectedIds = [
      manualCase.affected_laboratory_appointment_id,
      manualCase.affected_physical_exam_appointment_id,
    ].filter((id): id is string => Boolean(id));
    const affected = await loadAppointmentStates(client, affectedIds);
    const event = await client.query<{
      new_laboratory_appointment_id: string | null;
      new_physical_exam_appointment_id: string | null;
    }>(
      `SELECT new_laboratory_appointment_id::text,new_physical_exam_appointment_id::text
         FROM appointment_reschedule_events WHERE manual_case_id=$1 FOR UPDATE`,
      [caseId],
    );
    const replacementIds = event.rows.flatMap((row) => [
      row.new_laboratory_appointment_id,
      row.new_physical_exam_appointment_id,
    ].filter((id): id is string => Boolean(id)));
    const replacements = await loadAppointmentStates(client, replacementIds);
    const recheckedAppointments = [...affected, ...replacements];
    let auditedAppointments: AppointmentState[] = recheckedAppointments;
    const insertedByType: Partial<Record<AppointmentState["scheduleType"], string>> = {};
    if (request.action === "ASSIGN_REPLACEMENT") {
      const assignmentBlock = currentAssignmentBlock(recheckedAppointments);
      if (assignmentBlock) {
        throw new AppError(assignmentBlock.code, assignmentBlock.message, 409);
      }
      const dateByType = {
        LABORATORY: request.laboratoryDate,
        PHYSICAL_EXAM: request.physicalExamDate,
      };
      const preserveByType = {
        LABORATORY: request.preserveLaboratory,
        PHYSICAL_EXAM: request.preservePhysicalExam,
      };
      const awaiting = affected.filter((appointment) => appointment.status === "AWAITING_RESCHEDULE");
      if (!awaiting.length) throw new AppError("MANUAL_CASE_NO_AWAITING_APPOINTMENT", "No appointment is awaiting a replacement.", 409);
      if (awaiting.some((appointment) => !dateByType[appointment.scheduleType])) {
        throw validationError("A replacement date is required for every unfinished service.");
      }
      for (const appointment of affected) {
        const date = dateByType[appointment.scheduleType];
        const preserve = preserveByType[appointment.scheduleType];
        if (date && preserve) {
          throw validationError(`Choose either a replacement or preservation for ${appointment.scheduleType}.`);
        }
        if (appointment.status !== "AWAITING_RESCHEDULE" && !date && preserve !== true) {
          throw validationError(`Explicitly preserve or replace the related ${appointment.scheduleType} appointment.`);
        }
        if (date && !["DRAFT", "PENDING", "AWAITING_RESCHEDULE"].includes(appointment.status)) {
          throw validationError(`The ${appointment.scheduleType} appointment cannot be replaced in its current state.`);
        }
      }
      const finalDateByType = {
        LABORATORY: request.laboratoryDate
          ?? affected.find((appointment) => appointment.scheduleType === "LABORATORY")?.appointmentDate,
        PHYSICAL_EXAM: request.physicalExamDate
          ?? affected.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.appointmentDate,
      };
      if (
        finalDateByType.LABORATORY
        && finalDateByType.PHYSICAL_EXAM
        && finalDateByType.PHYSICAL_EXAM <= finalDateByType.LABORATORY
      ) {
        throw validationError("Physical Examination must follow Laboratory.");
      }
      const moving = affected.filter((appointment) => Boolean(dateByType[appointment.scheduleType]));
      for (const appointment of moving) {
        const date = dateByType[appointment.scheduleType]!;
        await assertManualDateAvailable(client, appointment.scheduleType, date);
      }
      await client.query(
        `UPDATE appointments
            SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=NOW()
          WHERE id=ANY($1::uuid[])`,
        [moving.map((appointment) => appointment.id), actor.userId],
      );
      for (const appointment of moving) {
        const date = dateByType[appointment.scheduleType]!;
        let recoveryReservationId: string | null = null;
        if (appointment.ovpsaBatchId && appointment.ovpsaRevisionId) {
          const reservation = await client.query<{ id: string }>(
            `INSERT INTO ovpsa_first_year_service_reservations (
               batch_id,revision_id,schedule_type,reservation_date,status,
               reservation_kind,created_by
             ) VALUES ($1,$2,$3,$4,'ACTIVE','CLOSURE_RECOVERY',$5)
             RETURNING id::text`,
            [
              appointment.ovpsaBatchId,
              appointment.ovpsaRevisionId,
              appointment.scheduleType,
              date,
              actor.userId,
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
              [appointment.id, date, `Manual clinic closure resolution ${caseId}.`, actor.userId, recoveryReservationId],
            )
          : await client.query<{ id: string }>(
              `INSERT INTO appointments (
                 clinic_id,student_number,schedule_type,appointment_date,status,is_published,
                 notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start
               ) VALUES ($1,$2,$3,$4,'PENDING',TRUE,$5,$6,$7,$7,$8,$9) RETURNING id::text`,
              [
                appointment.clinicId,
                appointment.studentNumber,
                appointment.scheduleType,
                date,
                `Manual clinic closure resolution ${caseId}.`,
                appointment.id,
                actor.userId,
                appointment.schedulePairId,
                appointment.scheduleCycleStart,
              ],
            );
        insertedByType[appointment.scheduleType] = inserted.rows[0].id;
      }
    } else {
      auditedAppointments = replacements;
      const assignmentBlock = currentAssignmentBlock(replacements);
      if (!replacements.length || replacements.some((appointment) =>
        appointment.status !== "PENDING"
        || !appointment.isPublished) || assignmentBlock) {
        throw new AppError("CURRENT_REPLACEMENT_NOT_SAFE", "There is no safe current replacement to keep.", 409);
      }
    }
    const details = {
      action: request.action,
      reason: request.reason,
      laboratoryDate: request.action === "ASSIGN_REPLACEMENT" ? request.laboratoryDate ?? null : null,
      physicalExamDate: request.action === "ASSIGN_REPLACEMENT" ? request.physicalExamDate ?? null : null,
      preserveLaboratory: request.action === "ASSIGN_REPLACEMENT" ? request.preserveLaboratory ?? false : false,
      preservePhysicalExam: request.action === "ASSIGN_REPLACEMENT" ? request.preservePhysicalExam ?? false : false,
      laboratoryAppointmentId: insertedByType.LABORATORY ?? null,
      physicalExamAppointmentId: insertedByType.PHYSICAL_EXAM ?? null,
    };
    await client.query(
      `UPDATE clinic_closure_manual_cases
          SET status='RESOLVED',resolved_at=NOW(),resolved_by=$2,
              resolution_action=$3,resolution_details=$4::jsonb,
              optimistic_token=gen_random_uuid(),updated_at=NOW()
        WHERE id=$1`,
      [caseId, actor.userId, request.action, JSON.stringify(details)],
    );
    await client.query(
      `UPDATE appointment_reschedule_events
          SET outcome='MANUALLY_RESOLVED',
              new_laboratory_appointment_id=COALESCE($2,new_laboratory_appointment_id),
              new_physical_exam_appointment_id=COALESCE($3,new_physical_exam_appointment_id),
              restoration_decision=CASE WHEN $4='KEEP_CURRENT_REPLACEMENT' THEN 'KEEP_CURRENT_REPLACEMENT' ELSE restoration_decision END,
              restoration_details=COALESCE(restoration_details,'{}'::jsonb)||$5::jsonb
        WHERE manual_case_id=$1`,
      [
        caseId,
        insertedByType.LABORATORY ?? null,
        insertedByType.PHYSICAL_EXAM ?? null,
        request.action,
        JSON.stringify({ manualResolutionReason: request.reason }),
      ],
    );
    const protectionMetadata = resultProtectionAuditMetadata(auditedAppointments);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'CLINIC_CLOSURE_MANUAL_CASE_RESOLVED','clinic_closure_manual_case',$2::text,
               jsonb_build_object(
                 'studentNumber',$3::text,'resolutionAction',$4::text,'reasonCode',$5::text,
                 'appointmentIds',$6::jsonb,'submissionIds',$7::jsonb,
                 'activeDraftFileCount',$8::int
               ))`,
      [
        actor.userId,
        caseId,
        manualCase.student_number,
        request.action,
        manualCase.reason_code,
        JSON.stringify(protectionMetadata.appointmentIds),
        JSON.stringify(protectionMetadata.submissionIds),
        protectionMetadata.activeDraftFileCount,
      ],
    );
    const notificationWarningCount = await createClosureNotification(client, {
      studentNumber: manualCase.student_number,
      build: (state) => buildManualResolutionCompletedNotification({
        state,
        eventId: caseId,
        eventKeyDiscriminator: "resolved",
        reason: request.reason,
        previous: previousScheduleForAppointments(affected),
      }),
      actorUserId: actor.userId,
      auditEntityId: caseId,
      auditEntityType: "clinic_closure_manual_case",
    });
    return {
      caseId,
      status: "RESOLVED" as const,
      resolutionAction: request.action,
      notificationWarningCount,
    };
  });
}

type OvpsaRecoveryBatchRow = {
  batch_id: string;
  status: string;
  optimistic_token: string;
  schedule_cycle_start: number;
  revision_id: string;
  revision_number: number;
  revision_status: string;
};

type OvpsaRecoveryCaseRow = {
  case_id: string;
  optimistic_token: string;
  student_number: string;
  laboratory_id: string;
  laboratory_status: string;
  laboratory_date: string;
  laboratory_clinic_id: string;
  physical_id: string;
  physical_status: string;
  physical_date: string;
  physical_clinic_id: string;
  schedule_pair_id: string;
  physical_created_at: Date;
  source_order: number | null;
};

async function planOvpsaClosureBatchRecovery(
  client: PoolClient,
  input: {
    batchId: string;
    optimisticToken: string;
    replacementLaboratoryDate: string;
    lock: boolean;
  },
) {
  if (!isClinicSchedulingWeekday(input.replacementLaboratoryDate)) {
    throw validationError("The replacement Mission Hospital Laboratory date must be a weekday.");
  }
  if (input.replacementLaboratoryDate < manilaToday()) {
    throw validationError("The replacement Mission Hospital Laboratory date cannot be in the past.");
  }
  const batchResult = await client.query<OvpsaRecoveryBatchRow>(
    `SELECT batch.id::text AS batch_id,batch.status,batch.optimistic_token::text,
            batch.schedule_cycle_start,revision.id::text AS revision_id,
            revision.revision_number,revision.status AS revision_status
       FROM ovpsa_first_year_batches batch
       JOIN ovpsa_first_year_batch_revisions revision
         ON revision.id=batch.current_revision_id
      WHERE batch.id=$1
      ${input.lock ? "FOR UPDATE OF batch,revision" : ""}`,
    [input.batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new AppError("OVPSA_BATCH_NOT_FOUND", "First Year batch not found.", 404);
  if (batch.optimistic_token !== input.optimisticToken) {
    throw new AppError("OVPSA_BATCH_STALE", "The OVPSA batch changed. Reload and try again.", 409);
  }
  if (batch.status !== "RESCHEDULE_REQUIRED" || batch.revision_status !== "PUBLISHED") {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_NOT_REQUIRED",
      "This batch is not awaiting coordinated closure recovery.",
      409,
    );
  }
  if (await isSchedulingDateBlocked(client, {
    scheduleType: "LABORATORY",
    date: input.replacementLaboratoryDate,
    excludeOvpsaBatchId: input.batchId,
  })) {
    throw new AppError(
      "CLINIC_CALENDAR_CONFLICT",
      `${input.replacementLaboratoryDate} is blocked or reserved.`,
      409,
    );
  }
  const cases = await client.query<OvpsaRecoveryCaseRow>(
    `SELECT manual_case.id::text AS case_id,manual_case.optimistic_token::text,
            manual_case.student_number,laboratory.id::text AS laboratory_id,
            laboratory.status AS laboratory_status,laboratory.appointment_date::text AS laboratory_date,
            laboratory.clinic_id::text AS laboratory_clinic_id,
            physical.id::text AS physical_id,physical.status AS physical_status,
            physical.appointment_date::text AS physical_date,
            physical.clinic_id::text AS physical_clinic_id,
            laboratory.schedule_pair_id::text,physical.created_at AS physical_created_at,
            physical.scheduling_source_row_order AS source_order
       FROM clinic_closure_manual_cases manual_case
       JOIN appointments laboratory
         ON laboratory.id=manual_case.affected_laboratory_appointment_id
       JOIN appointments physical
         ON physical.id=manual_case.affected_physical_exam_appointment_id
      WHERE manual_case.status='OPEN'
        AND manual_case.reason_code='OVPSA_LABORATORY_PROTECTED'
        AND manual_case.policy_metadata->>'ovpsaBatchId'=$1::text
      ORDER BY physical.appointment_date,physical.created_at,
               physical.scheduling_source_row_order NULLS LAST,
               manual_case.student_number,manual_case.id
      ${input.lock ? "FOR UPDATE OF manual_case,laboratory,physical" : ""}`,
    [input.batchId],
  );
  if (!cases.rowCount) {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_CASES_NOT_FOUND",
      "No open OVPSA Laboratory recovery cases were found for this batch.",
      409,
    );
  }
  const invalidLaboratory = cases.rows.find((row) => row.laboratory_status !== "AWAITING_RESCHEDULE");
  if (invalidLaboratory) {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_STALE",
      "An affected Laboratory appointment changed. Reload and review the batch again.",
      409,
    );
  }
  const protectionStates = await loadAppointmentResultProtectionStates(
    client,
    cases.rows.flatMap((row) => [row.laboratory_id, row.physical_id]),
  );
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: input.replacementLaboratoryDate,
    endDate: addCalendarDays(input.replacementLaboratoryDate, 366 * 5),
    excludeOvpsaBatchId: input.batchId,
  });
  const blockedDates = await listUnifiedBlockedDateSet(client);
  const { capacity, usedCapacity } = await loadCapacity(client);
  const minimumPhysicalExamDate = addCalendarDays(input.replacementLaboratoryDate, 7);
  const allocations: OvpsaClosureBatchRecoveryPreview["allocations"] = [];
  for (const row of cases.rows) {
    const physicalProtected = protectionStates.get(row.physical_id)?.type === "PROTECTED";
    const canPreserve = ["PENDING", "COMPLETED"].includes(row.physical_status)
      && row.physical_date >= minimumPhysicalExamDate
      && !blockedDates.has(row.physical_date)
      && !blocked.physicalExamDates.includes(row.physical_date);
    if (canPreserve) {
      allocations.push({
        studentNumber: row.student_number,
        currentPhysicalExamDate: row.physical_date,
        proposedPhysicalExamDate: row.physical_date,
        physicalExamAction: "PRESERVE",
      });
      continue;
    }
    if (
      row.physical_status === "COMPLETED"
      || !["PENDING", "AWAITING_RESCHEDULE"].includes(row.physical_status)
      || physicalProtected
    ) {
      throw new AppError(
        "OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
        `The Physical Examination for ${row.student_number} cannot be moved safely.`,
        409,
      );
    }
    const dates = allocateReplacementDates({
      strategy: "MOVE_PHYSICAL_ONLY",
      afterDate: addCalendarDays(input.replacementLaboratoryDate, 6),
      blockedDates,
      blockedDatesByService: {
        PHYSICAL_EXAM: new Set(blocked.physicalExamDates),
      },
      usedCapacity,
      capacity,
    });
    reserveCapacity(usedCapacity, dates);
    allocations.push({
      studentNumber: row.student_number,
      currentPhysicalExamDate: row.physical_date,
      proposedPhysicalExamDate: dates.physicalExamDate!,
      physicalExamAction: "MOVE",
    });
  }
  const preview: OvpsaClosureBatchRecoveryPreview = {
    batchId: input.batchId,
    optimisticToken: batch.optimistic_token,
    replacementLaboratoryDate: input.replacementLaboratoryDate,
    linkedCaseCount: cases.rows.length,
    preservedPhysicalExamCount: allocations.filter((row) => row.physicalExamAction === "PRESERVE").length,
    movedPhysicalExamCount: allocations.filter((row) => row.physicalExamAction === "MOVE").length,
    allocations,
  };
  return { batch, cases: cases.rows, protectionStates, preview };
}

export async function previewOvpsaClinicClosureBatchRecovery(
  batchId: string,
  raw: unknown,
  actor: SessionUser,
): Promise<OvpsaClosureBatchRecoveryPreview> {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(batchId).success) throw validationError("The OVPSA batch ID is invalid.");
  const parsed = ovpsaBatchPreviewSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the OVPSA batch recovery preview.", parsed.error.flatten());
  return transaction(async (client) => (
    await planOvpsaClosureBatchRecovery(client, {
      batchId,
      ...parsed.data,
      lock: false,
    })
  ).preview);
}

export async function confirmOvpsaClinicClosureBatchRecovery(
  batchId: string,
  raw: unknown,
  actor: SessionUser,
): Promise<OvpsaClosureBatchRecoveryConfirmation> {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(batchId).success) throw validationError("The OVPSA batch ID is invalid.");
  const parsed = ovpsaBatchConfirmSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the OVPSA batch recovery confirmation.", parsed.error.flatten());
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const planned = await planOvpsaClosureBatchRecovery(client, {
      batchId,
      optimisticToken: parsed.data.optimisticToken,
      replacementLaboratoryDate: parsed.data.replacementLaboratoryDate,
      lock: true,
    });
    const expectedTokens = new Map(
      parsed.data.caseTokens.map((item) => [item.caseId, item.expectedOptimisticToken]),
    );
    if (
      expectedTokens.size !== planned.cases.length
      || planned.cases.some((item) => expectedTokens.get(item.case_id) !== item.optimistic_token)
    ) {
      throw new AppError(
        "OVPSA_BATCH_RECOVERY_CASES_STALE",
        "The linked Manual Resolution cases changed. Reload and review the batch again.",
        409,
      );
    }
    const reason = parsed.data.reason.trim();
    await client.query(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='RELEASED',released_at=clock_timestamp(),released_by=$3,
              release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2
          AND status IN ('ACTIVE','INVALIDATED')`,
      [batchId, planned.batch.revision_id, actor.userId, reason],
    );
    const earliestPhysicalExamDate = [...planned.preview.allocations]
      .sort((left, right) => left.proposedPhysicalExamDate.localeCompare(right.proposedPhysicalExamDate))[0]
      .proposedPhysicalExamDate;
    const defaultPhysicalExamDate = addCalendarDays(parsed.data.replacementLaboratoryDate, 7);
    const revision = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         batch_id,revision_number,status,laboratory_date,physical_exam_date,
         physical_exam_exception_reason,validation_snapshot,validated_by,validated_at,
         published_by,published_at,created_by
       ) VALUES ($1,$2,'VALIDATED',$3,$4,$5,$6::jsonb,$7,clock_timestamp(),
                 NULL,NULL,$7)
       RETURNING id::text`,
      [
        batchId,
        planned.batch.revision_number + 1,
        parsed.data.replacementLaboratoryDate,
        earliestPhysicalExamDate,
        earliestPhysicalExamDate === defaultPhysicalExamDate ? null : reason,
        JSON.stringify(planned.preview),
        actor.userId,
      ],
    );
    const revisionId = revision.rows[0].id;
    const laboratoryReservation = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_service_reservations (
         batch_id,revision_id,schedule_type,reservation_date,status,
         reservation_kind,created_by
       ) VALUES ($1,$2,'LABORATORY',$3,'ACTIVE','EXCLUSIVE',$4)
       RETURNING id::text`,
      [batchId, revisionId, parsed.data.replacementLaboratoryDate, actor.userId],
    );
    const preservedDates = [...new Set(
      planned.preview.allocations
        .filter((item) => item.physicalExamAction === "PRESERVE")
        .map((item) => item.proposedPhysicalExamDate),
    )];
    const preservedReservations = preservedDates.length
      ? await client.query<{ id: string; reservation_date: string }>(
          `INSERT INTO ovpsa_first_year_service_reservations (
             batch_id,revision_id,schedule_type,reservation_date,status,
             reservation_kind,created_by
           ) SELECT $1,$2,'PHYSICAL_EXAM',date,'ACTIVE','EXCLUSIVE',$4
               FROM UNNEST($3::date[]) AS reservation(date)
           RETURNING id::text,reservation_date::text`,
          [batchId, revisionId, preservedDates, actor.userId],
        )
      : { rows: [] as Array<{ id: string; reservation_date: string }> };
    const preservedReservationByDate = new Map(
      preservedReservations.rows.map((item) => [item.reservation_date, item.id]),
    );
    const movedAllocations = planned.preview.allocations.filter(
      (item) => item.physicalExamAction === "MOVE",
    );
    const movedReservationRows: Array<{ id: string; student_number: string }> = [];
    for (const allocation of movedAllocations) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,
           reservation_kind,created_by
         ) VALUES ($1,$2,'PHYSICAL_EXAM',$3,'ACTIVE','CLOSURE_RECOVERY',$4)
         RETURNING id::text`,
        [batchId, revisionId, allocation.proposedPhysicalExamDate, actor.userId],
      );
      movedReservationRows.push({
        id: inserted.rows[0].id,
        student_number: allocation.studentNumber,
      });
    }
    const movedReservationByStudent = new Map(
      movedReservationRows.map((item) => [item.student_number, item.id]),
    );
    const allocationByStudent = new Map(
      planned.preview.allocations.map((item) => [item.studentNumber, item]),
    );
    const membershipAssignments = planned.cases.map((item) => {
      const allocation = allocationByStudent.get(item.student_number)!;
      return {
        student_number: item.student_number,
        reservation_id: allocation.physicalExamAction === "PRESERVE"
          ? preservedReservationByDate.get(allocation.proposedPhysicalExamDate)
          : movedReservationByStudent.get(item.student_number),
      };
    });
    if (membershipAssignments.some((item) => !item.reservation_id)) {
      throw new Error("OVPSA closure recovery reservation assignment is incomplete.");
    }
    await client.query(
      `INSERT INTO ovpsa_first_year_membership_snapshots (
         revision_id,batch_id,student_number,academic_snapshot_id,student_name,
         college_id,college_name,program_id,program_code,program_name,year_level,
         source_row_number,allocation_position,assigned_pe_reservation_id
       ) SELECT $1,membership.batch_id,membership.student_number,
                membership.academic_snapshot_id,membership.student_name,
                membership.college_id,membership.college_name,membership.program_id,
                membership.program_code,membership.program_name,membership.year_level,
                membership.source_row_number,membership.allocation_position,
                CASE WHEN membership.source_row_number IS NULL THEN NULL
                     ELSE COALESCE(row.reservation_id,membership.assigned_pe_reservation_id)
                END
           FROM ovpsa_first_year_membership_snapshots membership
           LEFT JOIN jsonb_to_recordset($3::jsonb)
             AS row(student_number text,reservation_id uuid)
             ON row.student_number=membership.student_number
          WHERE membership.revision_id=$2`,
      [revisionId, planned.batch.revision_id, JSON.stringify(membershipAssignments)],
    );
    await client.query(
      `UPDATE appointments
          SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=clock_timestamp()
        WHERE id=ANY($1::uuid[])`,
      [planned.cases.map((item) => item.laboratory_id), actor.userId],
    );
    const newLaboratories = await client.query<{ id: string; student_number: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
         ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
         scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
         scheduling_window_start,scheduling_window_end
       ) SELECT laboratory.clinic_id,laboratory.student_number,'LABORATORY',$2,'PENDING',TRUE,
                $3,laboratory.id,$4,$4,laboratory.schedule_pair_id,laboratory.schedule_cycle_start,
                $5,$6,$7,laboratory.scheduling_category,laboratory.scheduling_accepted_at,
                laboratory.scheduling_source_row_order,laboratory.scheduling_window_start,
                laboratory.scheduling_window_end
           FROM appointments laboratory
          WHERE laboratory.id=ANY($1::uuid[])
       RETURNING id::text,student_number`,
      [
        planned.cases.map((item) => item.laboratory_id),
        parsed.data.replacementLaboratoryDate,
        reason,
        actor.userId,
        batchId,
        revisionId,
        laboratoryReservation.rows[0].id,
      ],
    );
    const newLaboratoryByStudent = new Map(
      newLaboratories.rows.map((item) => [item.student_number, item.id]),
    );
    const movedCaseRows = planned.cases.filter(
      (item) => allocationByStudent.get(item.student_number)?.physicalExamAction === "MOVE",
    );
    if (movedCaseRows.length) {
      await client.query(
        `UPDATE appointments
            SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [movedCaseRows.map((item) => item.physical_id), actor.userId],
      );
    }
    const movedAppointmentInput = movedCaseRows.map((item) => ({
      appointment_id: item.physical_id,
      student_number: item.student_number,
      date: allocationByStudent.get(item.student_number)!.proposedPhysicalExamDate,
      reservation_id: movedReservationByStudent.get(item.student_number),
    }));
    const newPhysicals = movedAppointmentInput.length
      ? await client.query<{ id: string; student_number: string }>(
          `INSERT INTO appointments (
             clinic_id,student_number,schedule_type,appointment_date,status,is_published,
             notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
             ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
             scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
             scheduling_window_start,scheduling_window_end
           ) SELECT physical.clinic_id,physical.student_number,'PHYSICAL_EXAM',row.date,
                    'PENDING',TRUE,$2,physical.id,$3,$3,physical.schedule_pair_id,
                    physical.schedule_cycle_start,$4,$5,row.reservation_id,
                    physical.scheduling_category,physical.scheduling_accepted_at,
                    physical.scheduling_source_row_order,physical.scheduling_window_start,
                    physical.scheduling_window_end
               FROM jsonb_to_recordset($1::jsonb)
                 AS row(appointment_id uuid,student_number text,date date,reservation_id uuid)
               JOIN appointments physical ON physical.id=row.appointment_id
           RETURNING id::text,student_number`,
          [JSON.stringify(movedAppointmentInput), reason, actor.userId, batchId, revisionId],
        )
      : { rows: [] as Array<{ id: string; student_number: string }> };
    const newPhysicalByStudent = new Map(
      newPhysicals.rows.map((item) => [item.student_number, item.id]),
    );
    for (const item of planned.cases) {
      const allocation = allocationByStudent.get(item.student_number)!;
      if (allocation.physicalExamAction === "PRESERVE") {
        await client.query(
          `UPDATE appointments
              SET ovpsa_revision_id=$2,ovpsa_service_reservation_id=$3,
                  updated_by=$4,updated_at=clock_timestamp()
            WHERE id=$1`,
          [
            item.physical_id,
            revisionId,
            preservedReservationByDate.get(allocation.proposedPhysicalExamDate),
            actor.userId,
          ],
        );
      }
      const newLaboratoryId = newLaboratoryByStudent.get(item.student_number)!;
      const newPhysicalId = allocation.physicalExamAction === "PRESERVE"
        ? item.physical_id
        : newPhysicalByStudent.get(item.student_number)!;
      await client.query(
        `UPDATE clinic_closure_manual_cases
            SET status='RESOLVED',resolved_at=clock_timestamp(),resolved_by=$2,
                resolution_action='ASSIGN_REPLACEMENT',
                resolution_details=jsonb_build_object(
                  'batchRecovery',TRUE,'revisionId',$3::text,
                  'laboratoryDate',$4::text,'physicalExamDate',$5::text,
                  'physicalExamAction',$6::text,'reason',$7::text
                ),optimistic_token=gen_random_uuid(),updated_at=clock_timestamp()
          WHERE id=$1 AND status='OPEN'`,
        [
          item.case_id,
          actor.userId,
          revisionId,
          parsed.data.replacementLaboratoryDate,
          allocation.proposedPhysicalExamDate,
          allocation.physicalExamAction,
          reason,
        ],
      );
      await client.query(
        `UPDATE appointment_reschedule_events
            SET outcome='MANUALLY_RESOLVED',new_laboratory_appointment_id=$2,
                new_physical_exam_appointment_id=$3,ovpsa_target_revision_id=$4,
                policy_metadata=policy_metadata||jsonb_build_object(
                  'batchRecovery',TRUE,'physicalExamAction',$5::text
                )
          WHERE manual_case_id=$1`,
        [item.case_id, newLaboratoryId, newPhysicalId, revisionId, allocation.physicalExamAction],
      );
    }
    await client.query(
      `UPDATE ovpsa_first_year_active_memberships
          SET released_at=clock_timestamp(),released_by=$3,release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2 AND released_at IS NULL`,
      [batchId, planned.batch.revision_id, actor.userId, reason],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_active_memberships (
         batch_id,revision_id,student_number,schedule_cycle_start
       ) SELECT $1,$2,student_number,$3
           FROM ovpsa_first_year_membership_snapshots WHERE revision_id=$2`,
      [batchId, revisionId, planned.batch.schedule_cycle_start],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='SUPERSEDED',superseded_by_revision_id=$2,
              superseded_at=clock_timestamp()
        WHERE id=$1 AND status='PUBLISHED'`,
      [planned.batch.revision_id, revisionId],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='PUBLISHED',published_by=$2,published_at=clock_timestamp()
        WHERE id=$1 AND status='VALIDATED'`,
      [revisionId, actor.userId],
    );
    const nextToken = randomUUID();
    await client.query(
      `UPDATE ovpsa_first_year_batches
          SET status='PUBLISHED',current_revision_id=$2,optimistic_token=$3,
              updated_by=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND status='RESCHEDULE_REQUIRED'`,
      [batchId, revisionId, nextToken, actor.userId],
    );
    let notificationWarningCount = 0;
    for (const item of planned.cases) {
      notificationWarningCount += await createClosureNotification(client, {
        studentNumber: item.student_number,
        build: (state) => buildManualResolutionCompletedNotification({
          state,
          eventId: item.case_id,
          eventKeyDiscriminator: "resolved",
          reason,
          previous: {
            laboratory: {
              date: item.laboratory_date,
              location: "Iloilo Mission Hospital",
            },
            physicalExam: {
              date: item.physical_date,
              location: "CPU Clinic",
            },
          },
        }),
        actorUserId: actor.userId,
        auditEntityId: batchId,
        auditEntityType: "ovpsa_first_year_batch",
      });
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'OVPSA_CLINIC_CLOSURE_BATCH_RECOVERED','ovpsa_first_year_batch',$2,
               jsonb_build_object(
                 'previousRevisionId',$3::text,'revisionId',$4::text,
                 'linkedCaseCount',$5::int,'preservedPhysicalExamCount',$6::int,
                 'movedPhysicalExamCount',$7::int,'notificationWarningCount',$8::int,
                 'reason',$9::text
               ))`,
      [
        actor.userId,
        batchId,
        planned.batch.revision_id,
        revisionId,
        planned.preview.linkedCaseCount,
        planned.preview.preservedPhysicalExamCount,
        planned.preview.movedPhysicalExamCount,
        notificationWarningCount,
        reason,
      ],
    );
    return {
      ...planned.preview,
      optimisticToken: nextToken,
      revisionId,
      revisionNumber: planned.batch.revision_number + 1,
      notificationWarningCount,
    };
  });
}
