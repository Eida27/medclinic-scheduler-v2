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
  ClinicManualCaseReason,
  ClinicManualCaseResolutionRequest,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import {
  allocateReplacementDates,
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
});
const reopenSchema = z.object({
  action: z.literal("REOPEN"),
  date: z.iso.date(),
  unavailableDateId: z.string().uuid(),
  expectedUpdatedAt: z.string().trim().min(1).max(64),
});
const requestSchema = z.object({
  requestId: z.string().uuid(),
  changes: z.array(z.discriminatedUnion("action", [blockSchema, reopenSchema])).min(1).max(366),
  emergencyAcknowledged: z.boolean(),
});
const resolutionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ASSIGN_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    laboratoryDate: z.iso.date().optional(),
    physicalExamDate: z.iso.date().optional(),
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    action: z.literal("KEEP_CURRENT_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  }),
]);

type CalendarCycle = {
  key: string;
  studentNumber: string;
  scheduleCycleStart: number;
  appointments: ClinicCycleAppointment[];
};

type PersistedGroup = ReturnType<typeof groupContiguousClosureChanges>[number] & {
  closureGroupId: string;
  dateIds: Array<{ id: string; date: string }>;
};

type AppointmentState = ClinicCycleAppointment & {
  clinicId: string;
  rescheduledFrom: string | null;
};

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

function parseRequest(raw: unknown): ClinicCalendarOperationRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the clinic calendar request.", parsed.error.flatten());
  const request = parsed.data as ClinicCalendarOperationRequest;
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
      if (change.date === today && !request.emergencyAcknowledged) {
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

function payloadHash(request: ClinicCalendarOperationRequest) {
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
    has_protected_result: boolean;
    has_finalized_submission: boolean;
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
            appointment.schedule_pair_id::text,appointment.schedule_cycle_start,
            EXISTS (
              SELECT 1 FROM student_result_submissions submission
               WHERE submission.appointment_id=appointment.id
                 AND submission.status='FINALIZED'
            ) AS has_finalized_submission,
            (EXISTS (
               SELECT 1 FROM laboratory_results result
                WHERE result.appointment_id=appointment.id
                  AND result.result_status<>'PENDING_UPLOAD'
             ) OR EXISTS (
               SELECT 1 FROM exam_results result
                WHERE result.appointment_id=appointment.id
                  AND result.result_status<>'PENDING_UPLOAD'
             )) AS has_protected_result
       FROM appointments appointment
       JOIN impacted USING(student_number,schedule_cycle_start)
      WHERE appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.student_number,appointment.schedule_cycle_start,
               appointment.schedule_pair_id,appointment.schedule_type,appointment.id
      ${lock ? "FOR UPDATE OF appointment" : ""}`,
    [dates],
  );
  const cycleByKey = new Map<string, CalendarCycle>();
  for (const row of result.rows) {
    const key = `${row.student_number}:${row.schedule_cycle_start}`;
    const cycle = cycleByKey.get(key) ?? {
      key,
      studentNumber: row.student_number,
      scheduleCycleStart: row.schedule_cycle_start,
      appointments: [],
    };
    cycle.appointments.push({
      id: row.id,
      studentNumber: row.student_number,
      scheduleType: row.schedule_type,
      appointmentDate: row.appointment_date,
      status: row.status,
      isPublished: row.is_published,
      isManuallyLocked: row.is_manually_locked,
      hasProtectedResult: row.has_protected_result,
      hasFinalizedSubmission: row.has_finalized_submission,
      schedulePairId: row.schedule_pair_id,
      scheduleCycleStart: row.schedule_cycle_start,
    });
    cycleByKey.set(key, cycle);
  }
  return [...cycleByKey.values()].sort((left, right) =>
    left.studentNumber.localeCompare(right.studentNumber)
    || left.scheduleCycleStart - right.scheduleCycleStart
    || left.key.localeCompare(right.key));
}

function applicableGroups(cycle: CalendarCycle, groups: PersistedGroup[] | ReturnType<typeof groupContiguousClosureChanges>) {
  const appointmentDates = new Set(cycle.appointments.map((appointment) => appointment.appointmentDate));
  return groups.filter((group) => group.dates.some((date) => appointmentDates.has(date)));
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
  },
) {
  const unfinishedIds = input.cycle.appointments
    .filter((appointment) => appointment.status === "PENDING" || appointment.status === "DRAFT")
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
       reason_code,reason_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
    [
      input.cycle.studentNumber,
      input.closureGroupId,
      input.cycle.appointments[0]?.schedulePairId ?? null,
      input.cycle.scheduleCycleStart,
      input.classification.laboratory?.id ?? null,
      input.classification.physicalExam?.id ?? null,
      input.classification.reasonCode,
      input.classification.reasonMessage,
    ],
  );
  return inserted.rows[0].id;
}

async function insertClosureEvent(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    closureGroupId: string;
    strategy: "MOVE_COMPLETE_PAIR" | "MOVE_PHYSICAL_ONLY" | "MANUAL_RESOLUTION_REQUIRED";
    outcome: "REPLACED" | "AWAITING_RESCHEDULE";
    batchId: string;
    actorUserId: string;
    newLaboratoryId?: string | null;
    newPhysicalId?: string | null;
    manualCaseId?: string | null;
    unavailableDateIds: string[];
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
       strategy,outcome,manual_case_id
     ) VALUES ($1,$2,'CLINIC_CLOSURE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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

async function applyAutomaticMove(
  client: PoolClient,
  input: {
    cycle: CalendarCycle;
    classification: Extract<ClinicCycleClassification, { strategy: "MOVE_COMPLETE_PAIR" | "MOVE_PHYSICAL_ONLY" }>;
    dates: { laboratoryDate?: string; physicalExamDate?: string };
    group: PersistedGroup;
    unavailableDateIds: string[];
    batchId: string;
    actorUserId: string;
    clinicIds: { LABORATORY: string; PHYSICAL_EXAM: string };
  },
) {
  const originals = input.classification.strategy === "MOVE_COMPLETE_PAIR"
    ? [input.classification.laboratory, input.classification.physicalExam]
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
    const inserted = await client.query<{ id: string }>(
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
  await insertClosureEvent(client, {
    cycle: input.cycle,
    closureGroupId: input.group.closureGroupId,
    strategy: input.classification.strategy,
    outcome: "REPLACED",
    batchId: input.batchId,
    actorUserId: input.actorUserId,
    newLaboratoryId: replacementByType.LABORATORY,
    newPhysicalId: replacementByType.PHYSICAL_EXAM,
    unavailableDateIds: input.unavailableDateIds,
  });
  return originals.length;
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
  });
  await insertClosureEvent(client, {
    cycle: input.cycle,
    closureGroupId: input.group.closureGroupId,
    strategy: "MANUAL_RESOLUTION_REQUIRED",
    outcome: "AWAITING_RESCHEDULE",
    batchId: input.batchId,
    actorUserId: input.actorUserId,
    manualCaseId,
    unavailableDateIds: input.unavailableDateIds,
  });
  return manualCaseId;
}

async function restoreForReopenedDates(
  client: PoolClient,
  unavailableDateIds: string[],
  actor: SessionUser,
  batchId: string,
) {
  if (!unavailableDateIds.length) return { students: new Set<string>(), appointments: 0, retained: 0 };
  const eventRows = await client.query<{ id: string }>(
    `SELECT event.id::text
       FROM appointment_reschedule_events event
      WHERE EXISTS (
        SELECT 1 FROM appointment_reschedule_event_unavailable_dates link
         WHERE link.event_id=event.id
           AND link.unavailable_date_id=ANY($1::uuid[])
      )
        AND event.restored_at IS NULL
      ORDER BY event.id
      FOR UPDATE OF event`,
    [unavailableDateIds],
  );
  const restoredStudents = new Set<string>();
  let restoredAppointments = 0;
  let retained = 0;
  for (const { id: eventId } of eventRows.rows) {
    const eventResult = await client.query<{
      id: string;
      student_number: string;
      closure_group_id: string;
      schedule_pair_id: string | null;
      schedule_cycle_start: number;
      strategy: "MOVE_COMPLETE_PAIR" | "MOVE_PHYSICAL_ONLY" | "MANUAL_RESOLUTION_REQUIRED";
      old_laboratory_appointment_id: string | null;
      new_laboratory_appointment_id: string | null;
      old_physical_exam_appointment_id: string | null;
      new_physical_exam_appointment_id: string | null;
    }>(
      `SELECT id::text,student_number,closure_group_id::text,schedule_pair_id::text,
              schedule_cycle_start,strategy,old_laboratory_appointment_id::text,
              new_laboratory_appointment_id::text,old_physical_exam_appointment_id::text,
              new_physical_exam_appointment_id::text
         FROM appointment_reschedule_events WHERE id=$1`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event || event.strategy === "MANUAL_RESOLUTION_REQUIRED") continue;
    const stillBlocked = await client.query(
      `SELECT 1
         FROM appointment_reschedule_event_unavailable_dates link
         JOIN clinic_unavailable_dates unavailable ON unavailable.id=link.unavailable_date_id
        WHERE link.event_id=$1 AND unavailable.reopened_at IS NULL LIMIT 1`,
      [eventId],
    );
    if (stillBlocked.rowCount) continue;
    const originalIds = event.strategy === "MOVE_COMPLETE_PAIR"
      ? [event.old_laboratory_appointment_id, event.old_physical_exam_appointment_id]
      : [event.old_physical_exam_appointment_id];
    const replacementIds = event.strategy === "MOVE_COMPLETE_PAIR"
      ? [event.new_laboratory_appointment_id, event.new_physical_exam_appointment_id]
      : [event.new_physical_exam_appointment_id];
    if (originalIds.some((id) => !id) || replacementIds.some((id) => !id)) {
      retained += 1;
      continue;
    }
    const allIds = [...originalIds, ...replacementIds] as string[];
    const appointments = await client.query<{
      id: string;
      appointment_date: string;
      status: string;
      is_published: boolean;
      is_manually_locked: boolean;
      protected: boolean;
    }>(
      `SELECT appointment.id::text,appointment.appointment_date::text,
              appointment.status,appointment.is_published,appointment.is_manually_locked,
              (EXISTS (SELECT 1 FROM student_result_submissions submission
                        WHERE submission.appointment_id=appointment.id AND submission.status='FINALIZED')
               OR EXISTS (SELECT 1 FROM laboratory_results result
                           WHERE result.appointment_id=appointment.id AND result.result_status<>'PENDING_UPLOAD')
               OR EXISTS (SELECT 1 FROM exam_results result
                           WHERE result.appointment_id=appointment.id AND result.result_status<>'PENDING_UPLOAD')) AS protected
         FROM appointments appointment
        WHERE appointment.id=ANY($1::uuid[])
        ORDER BY appointment.id FOR UPDATE`,
      [allIds],
    );
    const byId = new Map(appointments.rows.map((appointment) => [appointment.id, appointment]));
    const originals = (originalIds as string[]).map((id) => byId.get(id));
    const replacements = (replacementIds as string[]).map((id) => byId.get(id));
    const originalDates = originals.flatMap((appointment) => appointment ? [appointment.appointment_date] : []);
    const blockedOriginal = originalDates.length
      ? await client.query(
          "SELECT 1 FROM clinic_unavailable_dates WHERE reopened_at IS NULL AND blocked_date=ANY($1::date[]) LIMIT 1",
          [originalDates],
        )
      : { rowCount: 0 };
    const unsafe = originals.some((appointment) => !appointment || appointment.status !== "RESCHEDULED")
      || replacements.some((appointment) =>
        !appointment
        || appointment.status !== "PENDING"
        || !appointment.is_published
        || appointment.is_manually_locked
        || appointment.protected)
      || Boolean(blockedOriginal.rowCount);
    if (unsafe) {
      const existingCase = await client.query(
        "SELECT 1 FROM clinic_closure_manual_cases WHERE id=(SELECT manual_case_id FROM appointment_reschedule_events WHERE id=$1)",
        [eventId],
      );
      if (!existingCase.rowCount) {
        const insertedCase = await client.query<{ id: string }>(
          `INSERT INTO clinic_closure_manual_cases (
             student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
             affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
             reason_code,reason_message
           ) VALUES ($1,$2,$3,$4,$5,$6,'UNSAFE_RESTORATION',
                     'The current replacement cannot be safely restored automatically.')
           RETURNING id::text`,
          [
            event.student_number,
            event.closure_group_id,
            event.schedule_pair_id,
            event.schedule_cycle_start,
            event.old_laboratory_appointment_id,
            event.old_physical_exam_appointment_id,
          ],
        );
        await client.query(
          `UPDATE appointment_reschedule_events
              SET manual_case_id=$2,restoration_decision='MANUAL_REVIEW_REQUIRED',
                  restoration_details=jsonb_build_object('batchId',$3::text)
            WHERE id=$1`,
          [eventId, insertedCase.rows[0].id, batchId],
        );
      }
      retained += 1;
      continue;
    }
    await client.query(
      `UPDATE appointments SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [replacementIds, actor.userId],
    );
    await client.query(
      `UPDATE appointments SET status='PENDING',is_published=TRUE,updated_by=$2,updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [originalIds, actor.userId],
    );
    await client.query(
      `UPDATE appointment_reschedule_events
          SET restored_at=NOW(),restored_by=$2,restoration_batch_id=$3::uuid,
              outcome='RESTORED',restoration_decision='AUTO_RESTORED',
              restoration_details=jsonb_build_object('batchId',$3::text)
        WHERE id=$1`,
      [eventId, actor.userId, batchId],
    );
    restoredStudents.add(event.student_number);
    restoredAppointments += originalIds.length;
  }
  return { students: restoredStudents, appointments: restoredAppointments, retained };
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
  const request = parseRequest(raw);
  return transaction(async (client) => {
    const active = await listActiveUnavailableDatesWithClient(client);
    await validateCalendarState(active, request.changes);
    const blockChanges = request.changes.filter((change): change is ClinicCalendarBlockChange => change.action === "BLOCK");
    const groups = groupContiguousClosureChanges(blockChanges);
    const cycles = await loadAffectedCycles(client, blockChanges.map((change) => change.date), false);
    let completePairMoveCount = 0;
    let physicalOnlyMoveCount = 0;
    let preservedCompletionCount = 0;
    let expectedManualCaseCount = 0;
    for (const cycle of cycles) {
      const classification = classifyClinicCycle(cycle.appointments);
      if (classification.strategy === "MOVE_COMPLETE_PAIR") completePairMoveCount += 1;
      else if (classification.strategy === "MOVE_PHYSICAL_ONLY") physicalOnlyMoveCount += 1;
      else if (classification.strategy === "PRESERVE_COMPLETION") preservedCompletionCount += 1;
      else expectedManualCaseCount += 1;
    }
    const reopenedIds = request.changes
      .filter((change) => change.action === "REOPEN")
      .map((change) => change.unavailableDateId);
    const restorationEvents = reopenedIds.length
      ? await client.query<{ count: number }>(
          `SELECT COUNT(DISTINCT event.id)::int AS count
             FROM appointment_reschedule_events event
             JOIN appointment_reschedule_event_unavailable_dates link ON link.event_id=event.id
            WHERE link.unavailable_date_id=ANY($1::uuid[]) AND event.restored_at IS NULL`,
          [reopenedIds],
        )
      : { rows: [{ count: 0 }] };
    return {
      requestId: request.requestId,
      closureGroups: groups,
      datesBeingReopened: request.changes.filter((change) => change.action === "REOPEN").map((change) => change.date),
      affectedStudentCount: new Set(cycles.map((cycle) => cycle.studentNumber)).size,
      completePairMoveCount,
      physicalOnlyMoveCount,
      preservedCompletionCount,
      expectedManualCaseCount,
      expectedRestorationCount: restorationEvents.rows[0].count,
      retainedReplacementCount: 0,
    };
  });
}

export async function saveClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarOperationResult> {
  assertAdmin(actor);
  const request = parseRequest(raw);
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
        const inserted = await createClosureGroupWithDates(client, group, actor.userId, batchId);
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

      const cycles = await loadAffectedCycles(client, blockChanges.map((change) => change.date), true);
      const blockedDates = await listUnifiedBlockedDateSet(client);
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
      let preservedCompletionCount = 0;
      let manualCaseCount = 0;
      for (const [index, cycle] of cycles.entries()) {
        const cycleGroups = applicableGroups(cycle, persistedGroups) as PersistedGroup[];
        if (!cycleGroups.length) continue;
        const group = [...cycleGroups].sort((left, right) => right.endDate.localeCompare(left.endDate))[0];
        const unavailableDateIds = [...new Set(cycleGroups.flatMap((item) => item.dateIds.map((date) => date.id)))];
        const classification = classifyClinicCycle(cycle.appointments);
        if (classification.strategy === "PRESERVE_COMPLETION") {
          preservedCompletionCount += 1;
          continue;
        }
        const savepoint = `clinic_student_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          if (classification.strategy === "MANUAL_RESOLUTION_REQUIRED") {
            await createManualFallback(client, {
              cycle,
              reasonCode: classification.reasonCode,
              reasonMessage: classification.reasonMessage,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
            });
            manualCaseCount += 1;
          } else {
            let dates: { laboratoryDate?: string; physicalExamDate?: string };
            try {
              dates = allocateReplacementDates({
                strategy: classification.strategy,
                afterDate: group.endDate,
                blockedDates,
                usedCapacity,
                capacity,
              });
            } catch (error) {
              if (!(error instanceof ClinicCalendarPlanningError)) throw error;
              await createManualFallback(client, {
                cycle,
                reasonCode: error.reasonCode,
                reasonMessage: error.message,
                group,
                unavailableDateIds,
                batchId,
                actorUserId: actor.userId,
              });
              manualCaseCount += 1;
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            const moved = await applyAutomaticMove(client, {
              cycle,
              classification,
              dates,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
              clinicIds,
            });
            reserveCapacity(usedCapacity, dates);
            movedStudentCount += 1;
            movedAppointmentCount += moved;
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          if (!(error instanceof ClinicCalendarPlanningError)) throw error;
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await createManualFallback(client, {
            cycle,
            reasonCode: error.reasonCode,
            reasonMessage: error.message,
            group,
            unavailableDateIds,
            batchId,
            actorUserId: actor.userId,
          });
          manualCaseCount += 1;
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      }

      const restoration = await restoreForReopenedDates(
        client,
        reopenChanges.map((change) => change.unavailableDateId),
        actor,
        batchId,
      );
      const result: ClinicCalendarOperationResult = {
        requestId: request.requestId,
        batchId,
        activeUnavailableDates: await listActiveUnavailableDatesWithClient(client),
        blockedDateCount: blockChanges.length,
        reopenedDateCount: reopenChanges.length,
        movedStudentCount,
        movedAppointmentCount,
        preservedCompletionCount,
        manualCaseCount,
        restoredStudentCount: restoration.students.size,
        restoredAppointmentCount: restoration.appointments,
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
                   'movedAppointmentCount',$7::int,'preservedCompletionCount',$8::int,
                   'manualCaseCount',$9::int,'restoredStudentCount',$10::int,
                   'restoredAppointmentCount',$11::int,'emergencyAcknowledged',$12::boolean
                 ))`,
        [
          actor.userId,
          request.requestId,
          batchId,
          result.blockedDateCount,
          result.reopenedDateCount,
          result.movedStudentCount,
          result.movedAppointmentCount,
          result.preservedCompletionCount,
          result.manualCaseCount,
          result.restoredStudentCount,
          result.restoredAppointmentCount,
          request.emergencyAcknowledged,
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
  raw: { page?: number; pageSize?: number; search?: string; reasonCode?: string; status?: string },
  actor: SessionUser,
) {
  assertAdmin(actor);
  const page = Math.max(1, Number(raw.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(raw.pageSize) || 20));
  const search = raw.search?.trim() || null;
  const reasonCode = raw.reasonCode?.trim() || null;
  const status = raw.status?.trim() || "OPEN";
  const result = await transaction(async (client) => client.query<{
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
    total: number;
  }>(
    `SELECT manual_case.id::text,manual_case.student_number,
            CONCAT_WS(' ',student.first_name,student.middle_name,student.last_name,student.suffix) AS student_name,
            manual_case.closure_group_id::text,closure.start_date::text AS group_start_date,
            closure.end_date::text AS group_end_date,manual_case.reason_code,
            manual_case.reason_message,manual_case.status,
            manual_case.optimistic_token::text,manual_case.created_at,
            COUNT(*) OVER()::int AS total
       FROM clinic_closure_manual_cases manual_case
       JOIN students student ON student.student_number=manual_case.student_number
       JOIN clinic_closure_groups closure ON closure.id=manual_case.closure_group_id
      WHERE ($1::text IS NULL OR manual_case.student_number ILIKE '%'||$1||'%'
             OR student.first_name ILIKE '%'||$1||'%' OR student.last_name ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR manual_case.reason_code=$2)
        AND ($3::text IS NULL OR manual_case.status=$3)
      ORDER BY manual_case.created_at,manual_case.id
      LIMIT $4 OFFSET $5`,
    [search, reasonCode, status || null, pageSize, (page - 1) * pageSize],
  ));
  return {
    page,
    pageSize,
    total: result.rows[0]?.total ?? 0,
    items: result.rows.map((row) => ({
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
    })),
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
    has_protected_result: boolean;
    has_finalized_submission: boolean;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    rescheduled_from: string | null;
  }>(
    `SELECT appointment.id::text,appointment.clinic_id::text,appointment.student_number,
            appointment.schedule_type,appointment.appointment_date::text,appointment.status,
            appointment.is_published,appointment.is_manually_locked,
            appointment.schedule_pair_id::text,appointment.schedule_cycle_start,
            appointment.rescheduled_from::text,
            EXISTS (SELECT 1 FROM student_result_submissions submission
                     WHERE submission.appointment_id=appointment.id AND submission.status='FINALIZED') AS has_finalized_submission,
            (EXISTS (SELECT 1 FROM laboratory_results result
                     WHERE result.appointment_id=appointment.id AND result.result_status<>'PENDING_UPLOAD')
             OR EXISTS (SELECT 1 FROM exam_results result
                        WHERE result.appointment_id=appointment.id AND result.result_status<>'PENDING_UPLOAD')) AS has_protected_result
       FROM appointments appointment WHERE appointment.id=ANY($1::uuid[]) ORDER BY appointment.id FOR UPDATE`,
    [ids],
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
    hasProtectedResult: row.has_protected_result,
    hasFinalizedSubmission: row.has_finalized_submission,
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    rescheduledFrom: row.rescheduled_from,
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
  const blocked = await client.query(
    "SELECT 1 FROM clinic_unavailable_dates WHERE blocked_date=$1 AND reopened_at IS NULL",
    [date],
  );
  if (blocked.rowCount) throw new AppError("CLINIC_CALENDAR_CONFLICT", `${date} is blocked.`, 409);
  const capacity = await client.query<{ max_daily_capacity: number; used: number }>(
    `SELECT setting.max_daily_capacity,
            (SELECT COUNT(*)::int FROM appointments appointment
              WHERE appointment.schedule_type=$1 AND appointment.appointment_date=$2
                AND appointment.is_published=TRUE AND appointment.status IN ('DRAFT','PENDING')) AS used
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
    const affectedIds = [
      manualCase.affected_laboratory_appointment_id,
      manualCase.affected_physical_exam_appointment_id,
    ].filter((id): id is string => Boolean(id));
    const affected = await loadAppointmentStates(client, affectedIds);
    const insertedByType: Partial<Record<AppointmentState["scheduleType"], string>> = {};
    if (request.action === "ASSIGN_REPLACEMENT") {
      const unfinished = affected.filter((appointment) => appointment.status === "AWAITING_RESCHEDULE");
      if (!unfinished.length) throw new AppError("MANUAL_CASE_NO_AWAITING_APPOINTMENT", "No appointment is awaiting a replacement.", 409);
      const dateByType = {
        LABORATORY: request.laboratoryDate,
        PHYSICAL_EXAM: request.physicalExamDate,
      };
      if (unfinished.some((appointment) => !dateByType[appointment.scheduleType])) {
        throw validationError("A replacement date is required for every unfinished service.");
      }
      if (
        request.laboratoryDate
        && request.physicalExamDate
        && request.physicalExamDate <= request.laboratoryDate
      ) {
        throw validationError("Physical Examination must follow Laboratory.");
      }
      for (const appointment of unfinished) {
        const date = dateByType[appointment.scheduleType]!;
        await assertManualDateAvailable(client, appointment.scheduleType, date);
      }
      await client.query(
        `UPDATE appointments
            SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=NOW()
          WHERE id=ANY($1::uuid[])`,
        [unfinished.map((appointment) => appointment.id), actor.userId],
      );
      for (const appointment of unfinished) {
        const date = dateByType[appointment.scheduleType]!;
        const inserted = await client.query<{ id: string }>(
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
      if (!replacements.length || replacements.some((appointment) =>
        appointment.status !== "PENDING"
        || !appointment.isPublished
        || appointment.isManuallyLocked
        || appointment.hasProtectedResult
        || appointment.hasFinalizedSubmission)) {
        throw new AppError("CURRENT_REPLACEMENT_NOT_SAFE", "There is no safe current replacement to keep.", 409);
      }
    }
    const details = {
      action: request.action,
      reason: request.reason,
      laboratoryDate: request.action === "ASSIGN_REPLACEMENT" ? request.laboratoryDate ?? null : null,
      physicalExamDate: request.action === "ASSIGN_REPLACEMENT" ? request.physicalExamDate ?? null : null,
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
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'CLINIC_CLOSURE_MANUAL_CASE_RESOLVED','clinic_closure_manual_case',$2::text,
               jsonb_build_object('studentNumber',$3::text,'resolutionAction',$4::text,'reason',$5::text))`,
      [actor.userId, caseId, manualCase.student_number, request.action, request.reason],
    );
    return { caseId, status: "RESOLVED" as const, resolutionAction: request.action };
  });
}
