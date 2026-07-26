import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { query, transaction } from "@/server/db/pool";
import { listClinicUnavailableDateRecords } from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarBatchIssue,
  ClinicCalendarBatchResult,
  ClinicCalendarBlockChange,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import {
  addCalendarDays,
  applyClinicBlockPlan,
  createPlanningContext,
  planClinicBlock,
  sortClinicCalendarChanges,
} from "./clinic-calendar-planner";

const categorySchema = z.enum([
  "HOLIDAY",
  "CLOSURE",
  "MAINTENANCE",
  "STAFF_UNAVAILABILITY",
]);

const blockChangeSchema = z.object({
  action: z.literal("BLOCK"),
  clinicId: z.string().uuid(),
  date: z.iso.date(),
  category: categorySchema,
  reason: z.string().trim().min(3).max(500),
});

const changeSchema = z.discriminatedUnion("action", [blockChangeSchema]);

const batchSchema = z.object({
  changes: z.array(changeSchema).min(1).max(366),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.changes.forEach((change, index) => {
    const key = `${change.clinicId}:${change.date}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["changes", index],
        message: "Only one change is allowed for each clinic date.",
      });
    }
    seen.add(key);
    if (Number(change.date.slice(0, 4)) > 2100) {
      context.addIssue({
        code: "custom",
        path: ["changes", index, "date"],
        message: "Calendar dates may not be later than 2100.",
      });
    }
  });
});

const legacyInputSchema = z.object({
  clinicId: z.string().uuid(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  category: categorySchema,
  reason: z.string().trim().min(3).max(500),
}).superRefine((value, context) => {
  if (value.endDate < value.startDate) {
    context.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "End date must not precede start date.",
    });
  }
});

function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
}

function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function datesBetween(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) dates.push(date);
  return dates;
}

function batchRejected(issues: ClinicCalendarBatchIssue[], status = 409) {
  return new AppError(
    "CLINIC_CALENDAR_BATCH_REJECTED",
    "No calendar changes were saved.",
    status,
    undefined,
    { issues },
  );
}

function rawChangeAt(raw: unknown, path: PropertyKey[]) {
  if (typeof raw !== "object" || raw === null || !("changes" in raw)) return undefined;
  const changes = (raw as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return undefined;
  const index = path.find((part): part is number => typeof part === "number");
  return typeof index === "number" && typeof changes[index] === "object" && changes[index] !== null
    ? changes[index] as Record<string, unknown>
    : undefined;
}

function parseBatch(raw: unknown) {
  const parsed = batchSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((zodIssue): ClinicCalendarBatchIssue => {
    const change = rawChangeAt(raw, zodIssue.path);
    return {
      clinicId: typeof change?.clinicId === "string" ? change.clinicId : "",
      date: typeof change?.date === "string" ? change.date : "",
      action: change?.action === "UNBLOCK" ? "UNBLOCK" : "BLOCK",
      code: "INVALID_CHANGE",
      message: zodIssue.message,
    };
  });
  throw batchRejected(issues.length ? issues : [{
    clinicId: "",
    date: "",
    action: "BLOCK",
    code: "INVALID_CHANGE",
    message: "The calendar batch is invalid.",
  }], 422);
}

async function lockActiveRecords(client: PoolClient): Promise<ClinicUnavailableDateDto[]> {
  const result = await client.query<{
    id: string;
    clinic_id: string;
    clinic_code: string;
    clinic_name: string;
    start_date: string;
    end_date: string;
    category: ClinicUnavailableDateDto["category"];
    reason: string;
    created_by_name: string;
    created_at: Date;
    updated_at: string;
  }>(
    `SELECT unavailable.id::text, unavailable.clinic_id::text,
            clinic.code AS clinic_code, clinic.name AS clinic_name,
            unavailable.start_date::text, unavailable.end_date::text,
            unavailable.category, unavailable.reason,
            creator.full_name AS created_by_name, unavailable.created_at,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
       JOIN users creator ON creator.id=unavailable.created_by
      WHERE unavailable.unblocked_at IS NULL
      ORDER BY unavailable.start_date, unavailable.clinic_id, unavailable.id
      FOR UPDATE OF unavailable`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    clinicId: row.clinic_id,
    clinicCode: row.clinic_code,
    clinicName: row.clinic_name,
    startDate: row.start_date,
    endDate: row.end_date,
    category: row.category,
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at,
  }));
}

async function listActiveRecordsWithClient(client: PoolClient): Promise<ClinicUnavailableDateDto[]> {
  const result = await client.query<{
    id: string;
    clinic_id: string;
    clinic_code: string;
    clinic_name: string;
    start_date: string;
    end_date: string;
    category: ClinicUnavailableDateDto["category"];
    reason: string;
    created_by_name: string;
    created_at: Date;
    updated_at: string;
  }>(
    `SELECT unavailable.id::text, unavailable.clinic_id::text,
            clinic.code AS clinic_code, clinic.name AS clinic_name,
            unavailable.start_date::text, unavailable.end_date::text,
            unavailable.category, unavailable.reason,
            creator.full_name AS created_by_name, unavailable.created_at,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
       JOIN users creator ON creator.id=unavailable.created_by
      WHERE unavailable.unblocked_at IS NULL
      ORDER BY unavailable.start_date DESC, unavailable.created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    clinicId: row.clinic_id,
    clinicCode: row.clinic_code,
    clinicName: row.clinic_name,
    startDate: row.start_date,
    endDate: row.end_date,
    category: row.category,
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at,
  }));
}

function issueForChange(
  change: ClinicCalendarBlockChange,
  code: ClinicCalendarBatchIssue["code"],
  message: string,
): ClinicCalendarBatchIssue {
  return {
    clinicId: change.clinicId,
    date: change.date,
    action: change.action,
    code,
    message,
  };
}

function isCalendarActiveDateUniqueViolation(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505"
    && "constraint" in error
    && error.constraint === "clinic_unavailable_dates_one_active_day_idx";
}

export async function listClinicUnavailableDates(actor: SessionUser) {
  assertAdmin(actor);
  return listClinicUnavailableDateRecords();
}

export async function saveClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarBatchResult> {
  assertAdmin(actor);
  const input = parseBatch(raw);
  const temporalIssues = input.changes.flatMap((change): ClinicCalendarBatchIssue[] => {
    if (change.date <= manilaToday()) {
      return [issueForChange(
        change,
        "INVALID_CHANGE",
        "Clinic calendar changes must be after today in Manila.",
      )];
    }
    if (!isWeekday(change.date)) {
      return [issueForChange(
        change,
        "INVALID_CHANGE",
        "Clinic calendar changes are allowed on weekdays only.",
      )];
    }
    return [];
  });
  if (temporalIssues.length) throw batchRejected(temporalIssues, 422);

  const changes = sortClinicCalendarChanges(input.changes);
  const batchId = randomUUID();
  try {
    return await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      const activeRecords = await lockActiveRecords(client);
      const supportedClinics = await client.query<{ id: string }>(
        `SELECT id::text FROM clinics
          WHERE id=ANY($1::uuid[])
            AND code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
        [[...new Set(changes.map((change) => change.clinicId))].sort()],
      );
      const supportedClinicIds = new Set(supportedClinics.rows.map((clinic) => clinic.id));
      const validationIssues: ClinicCalendarBatchIssue[] = [];
      for (const change of changes) {
        if (!supportedClinicIds.has(change.clinicId)) {
          validationIssues.push(issueForChange(
            change,
            "INVALID_CHANGE",
            "Clinic not found or does not support calendar editing.",
          ));
          continue;
        }
        if (activeRecords.some((record) => (
          record.clinicId === change.clinicId
          && record.startDate <= change.date
          && record.endDate >= change.date
        ))) {
          validationIssues.push(issueForChange(
            change,
            "ACTIVE_BLOCK_CONFLICT",
            "This clinic date is already blocked.",
          ));
        }
      }
      if (validationIssues.length) throw batchRejected(validationIssues);

      const context = await createPlanningContext(client, activeRecords, changes);
      const plans = [];
      for (const change of changes) plans.push(await planClinicBlock(client, change, context));

      const impacts = [];
      for (const plan of plans) impacts.push(await applyClinicBlockPlan(client, plan, actor, batchId));
      const movedStudentNumbers = new Set(impacts.flatMap((impact) => impact.studentNumbers));
      const movedAppointmentCount = impacts.reduce(
        (total, impact) => total + impact.movedAppointmentCount,
        0,
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,'CLINIC_CALENDAR_BATCH_UPDATED','clinic_calendar_batch',$2::text,
                 jsonb_build_object(
                   'batchId',$2::text,
                   'blockedDateCount',$3::int,
                   'unblockedDateCount',0,
                   'movedStudentCount',$4::int,
                   'movedAppointmentCount',$5::int,
                   'restoredStudentCount',0,
                   'restoredAppointmentCount',0
                 ))`,
        [actor.userId, batchId, changes.length, movedStudentNumbers.size, movedAppointmentCount],
      );
      return {
        batchId,
        activeUnavailableDates: await listActiveRecordsWithClient(client),
        blockedDateCount: changes.length,
        unblockedDateCount: 0,
        movedStudentCount: movedStudentNumbers.size,
        movedAppointmentCount,
        restoredStudentCount: 0,
        restoredAppointmentCount: 0,
      };
    });
  } catch (error) {
    if (isCalendarActiveDateUniqueViolation(error)) {
      throw batchRejected([
        issueForChange(
          changes[0],
          "ACTIVE_BLOCK_CONFLICT",
          "This clinic date was blocked by another calendar update.",
        ),
      ]);
    }
    throw error;
  }
}

async function legacyBatchError(error: AppError) {
  if (error.code !== "CLINIC_CALENDAR_BATCH_REJECTED") return error;
  const details = error.details as { issues?: ClinicCalendarBatchIssue[] } | undefined;
  const issue = details?.issues?.[0];
  if (!issue) return error;
  if (issue.code === "ACTIVE_BLOCK_CONFLICT") {
    return new AppError(
      "CLINIC_BLOCK_OVERLAP",
      "This clinic already has an overlapping unavailable date.",
      409,
    );
  }
  if (issue.code === "PROTECTED_REPLACEMENT") {
    const appointmentIds = issue.appointmentIds ?? [];
    const appointments = appointmentIds.length
      ? await query<{ id: string; student_number: string }>(
          `SELECT id::text, student_number
             FROM appointments
            WHERE id=ANY($1::uuid[])`,
          [appointmentIds],
        )
      : { rows: [] };
    const studentNumberByAppointmentId = new Map(
      appointments.rows.map((appointment) => [appointment.id, appointment.student_number]),
    );
    const unresolved = appointmentIds.map((appointmentId) => (
      `${appointmentId}:${studentNumberByAppointmentId.get(appointmentId) ?? ""}`
    ));
    return new AppError(
      "CLINIC_BLOCK_PROTECTED_APPOINTMENTS",
      issue.message,
      409,
      { unresolved },
    );
  }
  if (issue.code === "CAPACITY_CONFLICT") {
    return new AppError(
      "CLINIC_BLOCK_REPLACEMENT_UNAVAILABLE",
      "Affected appointments could not be replaced.",
      409,
    );
  }
  if (issue.code === "PAIR_INTEGRITY_FAILURE") {
    return new AppError(
      "CLINIC_BLOCK_PAIR_NOT_FOUND",
      "The paired Laboratory appointment could not be found.",
      409,
    );
  }
  if (issue.code === "INVALID_CHANGE" && issue.message.startsWith("Clinic not found")) {
    return new AppError("CLINIC_NOT_FOUND", "Clinic not found.", 404);
  }
  return error;
}

export async function createClinicUnavailableDate(raw: unknown, actor: SessionUser) {
  assertAdmin(actor);
  const input = legacyInputSchema.parse(raw);
  if (input.startDate <= manilaToday()) {
    throw new AppError(
      "CLINIC_BLOCK_NOT_FUTURE",
      "Automatic clinic blocks must begin after today in Manila.",
      422,
    );
  }
  if (datesBetween(input.startDate, input.endDate).length > 366) {
    throw new AppError("CLINIC_BLOCK_RANGE_TOO_LONG", "Clinic blocks may span at most 366 days.", 422);
  }
  if (input.startDate !== input.endDate) {
    throw new AppError(
      "CLINIC_BLOCK_RANGE_NOT_SUPPORTED",
      "Clinic unavailable dates must be saved one day at a time.",
      422,
    );
  }
  try {
    const result = await saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: input.clinicId,
        date: input.startDate,
        category: input.category,
        reason: input.reason,
      }],
    }, actor);
    const record = result.activeUnavailableDates.find((item) => (
      item.clinicId === input.clinicId && item.startDate === input.startDate
    ));
    if (!record) {
      throw new AppError("CLINIC_BLOCK_NOT_FOUND", "The created clinic block could not be read.", 500);
    }
    return {
      id: record.id,
      updatedAt: record.updatedAt,
      movedStudentCount: result.movedStudentCount,
      movedAppointmentCount: result.movedAppointmentCount,
    };
  } catch (error) {
    if (error instanceof AppError) throw await legacyBatchError(error);
    throw error;
  }
}
