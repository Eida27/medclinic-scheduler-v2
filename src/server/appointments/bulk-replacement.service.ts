import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { manilaCalendarDate } from "@/lib/academic-year";
import { assertManualAppointmentDestination } from "@/server/appointments/manual-appointment-destination";
import { assertOpenAppointmentCycle } from "@/server/appointments/academic-year-visibility";
import { transaction } from "@/server/db/pool";
import { getInternalOccupancy, internalOccupancyPredicate } from "@/server/schedule/scheduling-occupancy.repository";
import { getAppointmentMutationContext, getAppointmentMutationScope,
  rescheduleAppointmentWithClient } from "@/server/repositories/appointments.repository";
import { resolveEffectiveAppointmentPair } from "@/server/repositories/effective-appointment-pair.repository";
import { lockEffectiveAppointmentScopes, lockSchedulingMutationQueue } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import { buildAdministratorRescheduledNotification } from "@/server/schedule/schedule-notifications";
import type { SessionUser } from "@/types/roles";

export const bulkReplacementPayloadSchema = z.object({
  appointments: z.array(z.object({
    id: z.uuid(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
  }).strict()).min(1).max(100),
  replacementDate: z.iso.date(),
  reason: z.string().trim().min(3).max(1000),
}).strict().superRefine((value, context) => {
  if (new Set(value.appointments.map((row) => row.id)).size !== value.appointments.length) {
    context.addIssue({ code: "custom", path: ["appointments"], message: "Select each appointment only once." });
  }
});
export type BulkReplacementPayload = z.infer<typeof bulkReplacementPayloadSchema>;
const commitSchema = bulkReplacementPayloadSchema.safeExtend({
  requestId: z.uuid(),
  previewToken: z.string().min(20).max(10000),
});

function canonical(input: BulkReplacementPayload) {
  return JSON.stringify({
    appointments: [...input.appointments].sort((a, b) => a.id.localeCompare(b.id)),
    replacementDate: input.replacementDate,
    reason: input.reason.trim(),
  });
}
function hash(input: BulkReplacementPayload) {
  return createHash("sha256").update(canonical(input)).digest("hex");
}
function mac(data: string, secret: string) {
  const key = createHmac("sha256", secret).update("medclinic:bulk-replacement-preview:v1").digest();
  return createHmac("sha256", key).update(data).digest("base64url");
}
type PreviewProof = { actorId: string; payloadHash: string; fingerprint: string; expiresAt: number };
export function signBulkReplacementPreview(input: {
  actorId: string; payload: BulkReplacementPayload; fingerprint: string;
  now?: number; secret?: string;
}) {
  const proof: PreviewProof = {
    actorId: input.actorId,
    payloadHash: hash(input.payload),
    fingerprint: input.fingerprint,
    expiresAt: (input.now ?? Date.now()) + 600_000,
  };
  const body = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return `${body}.${mac(body, input.secret ?? serverEnv().JWT_SECRET)}`;
}
export function verifyBulkReplacementPreview(token: string, input: {
  actorId: string; payload: BulkReplacementPayload; now?: number; secret?: string;
}): PreviewProof {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra || body.length > 9000) {
    throw new AppError("BULK_PREVIEW_INVALID", "Preview this selection again before saving.", 409);
  }
  const expected = mac(body, input.secret ?? serverEnv().JWT_SECRET);
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new AppError("BULK_PREVIEW_INVALID", "Preview this selection again before saving.", 409);
  }
  let proof: PreviewProof;
  try { proof = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewProof; }
  catch { throw new AppError("BULK_PREVIEW_INVALID", "Preview this selection again before saving.", 409); }
  if (proof.actorId !== input.actorId || proof.payloadHash !== hash(input.payload)) {
    throw new AppError("BULK_PREVIEW_INVALID", "Preview this selection again before saving.", 409);
  }
  if (!Number.isFinite(proof.expiresAt) || (input.now ?? Date.now()) > proof.expiresAt) {
    throw new AppError("BULK_PREVIEW_EXPIRED", "The preview expired. Review this selection again.", 409);
  }
  return proof;
}

async function authorizedActor(client: PoolClient, actor: SessionUser) {
  const row = (await client.query<{ role: string; clinicId: string | null; credentialVersion: number;
    verified: boolean; mustChangePassword: boolean }>(
    `SELECT role,clinic_id::text AS "clinicId",credential_version AS "credentialVersion",
            email_verified_at IS NOT NULL AS verified,must_change_password AS "mustChangePassword"
       FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, [actor.userId],
  )).rows[0];
  if (!row || (actor.credentialVersion !== undefined && row.credentialVersion !== actor.credentialVersion)) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  if (!row.verified || row.mustChangePassword || !["ADMIN", "CLINIC_STAFF"].includes(row.role)) {
    throw new AppError("FORBIDDEN", "This account cannot replace appointments.", 403);
  }
  return row;
}

type ReviewedRow = {
  id: string; studentNumber: string | null; originalDate: string | null; pairedDate: string | null;
  expectedUpdatedAt: string; checklistVersion: number | null; retainedTests: string[];
  isManuallyLocked: boolean; issues: Array<{ code: string; message: string }>;
  appointment: Awaited<ReturnType<typeof getAppointmentMutationContext>>;
};
async function review(client: PoolClient, payload: BulkReplacementPayload, actor: SessionUser,
  collectIssues = false) {
  const authority = await authorizedActor(client, actor);
  // A PoolClient runs one query at a time; keep the lock lookup order deterministic.
  const scopes: Awaited<ReturnType<typeof getAppointmentMutationScope>>[] = [];
  for (const row of payload.appointments) scopes.push(await getAppointmentMutationScope(row.id, client));
  if (!collectIssues && scopes.some((scope) => !scope)) {
    throw new AppError("BULK_SOURCE_CHANGED", "One selected appointment is no longer available.", 409);
  }
  await lockEffectiveAppointmentScopes(client, scopes.flatMap((scope) => scope ? [
    { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" as const },
    { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" as const },
  ] : []));
  const ordered = [...payload.appointments].sort((a, b) => {
    const left = scopes[payload.appointments.indexOf(a)];
    const right = scopes[payload.appointments.indexOf(b)];
    return (left?.studentNumber ?? "").localeCompare(right?.studentNumber ?? "") || a.id.localeCompare(b.id);
  });
  const rows: ReviewedRow[] = [];
  const addIssue = (row: ReviewedRow, error: AppError) => {
    if (!collectIssues) throw error;
    row.issues.push({ code: error.code, message: error.message });
  };
  const validate = async (row: ReviewedRow, work: () => void | Promise<void>) => {
    try { await work(); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      addIssue(row, error);
    }
  };
  for (const selected of ordered) {
    const appointment = await getAppointmentMutationContext(selected.id, client);
    if (appointment && authority.role !== "ADMIN" && authority.clinicId !== appointment.clinicId) {
      throw new AppError("CLINIC_ACCESS_DENIED", "You can only replace appointments in your assigned clinic.", 403);
    }
    const row: ReviewedRow = {
      id: selected.id, studentNumber: appointment?.studentNumber ?? null,
      originalDate: appointment?.appointmentDate ?? null, pairedDate: null,
      expectedUpdatedAt: selected.expectedUpdatedAt, checklistVersion: null,
      retainedTests: [], isManuallyLocked: appointment?.isManuallyLocked ?? false,
      issues: [], appointment,
    };
    rows.push(row);
    if (!appointment) {
      addIssue(row, new AppError("BULK_SOURCE_CHANGED", "This appointment is no longer available.", 409));
      continue;
    }
    if (!["PENDING", "NO_SHOW"].includes(appointment.status)
      || appointment.ovpsaBatchId || appointment.ovpsaRevisionId || appointment.ovpsaServiceReservationId) {
      addIssue(row, new AppError("BULK_SOURCE_INELIGIBLE",
        "This appointment needs individual or OVPSA review.", 409));
    }
    if (appointment.updatedAt.getTime() !== new Date(selected.expectedUpdatedAt).getTime()) {
      addIssue(row, new AppError("BULK_SOURCE_CHANGED", "An appointment changed. Preview the selection again.", 409));
    }
    if (appointment.appointmentDate === payload.replacementDate) {
      addIssue(row, new AppError("BULK_SAME_DATE", "Choose a different replacement date.", 422));
    }
    await validate(row, () => assertOpenAppointmentCycle(client, appointment.scheduleCycleStart, new Date()));
    const pair = await resolveEffectiveAppointmentPair(client, appointment);
    row.pairedDate = appointment.scheduleType === "LABORATORY"
      ? pair.physicalExam?.appointmentDate ?? null : pair.laboratory?.appointmentDate ?? null;
    const effective = appointment.scheduleType === "LABORATORY" ? pair.laboratory : pair.physicalExam;
    if (effective?.id !== appointment.id) {
      addIssue(row, new AppError("BULK_SOURCE_INELIGIBLE", "This is no longer the current appointment.", 409));
    }
    const protection = (await loadAppointmentResultProtectionStates(client, [appointment.id])).get(appointment.id);
    if (protection?.type === "PROTECTED") {
      addIssue(row, new AppError("BULK_RESULT_PROTECTED", protection.message, 409));
    }
    const checklist = appointment.scheduleType === "LABORATORY" ? (await client.query<{
      version: number; testCode: string | null }>(
      `SELECT checklist.version,item.test_code AS "testCode"
         FROM laboratory_checklist_appointments link
         JOIN laboratory_checklists checklist ON checklist.id=link.checklist_id
         LEFT JOIN laboratory_checklist_items item ON item.checklist_id=checklist.id AND item.verified_at IS NOT NULL
        WHERE link.appointment_id=$1`, [appointment.id],
    )).rows : [];
    row.checklistVersion = checklist[0]?.version ?? null;
    row.retainedTests = checklist.flatMap((item) => item.testCode ? [item.testCode] : []);
  }
  const first = rows.find((row) => row.appointment)?.appointment;
  if (!first) return { rows, fingerprint: null, capacity: null,
    service: null, clinicId: null, academicYearStart: null };
  for (const row of rows) {
    const appointment = row.appointment;
    if (appointment && (appointment.scheduleType !== first.scheduleType
      || appointment.clinicId !== first.clinicId
      || appointment.scheduleCycleStart !== first.scheduleCycleStart)) {
      addIssue(row, new AppError("BULK_MIXED_SELECTION",
        "Select one service, clinic, and academic year.", 422));
    }
  }
  const blocked = await isSchedulingDateBlocked(client, {
    scheduleType: first.scheduleType, date: payload.replacementDate,
  });
  const capacity = (await client.query<{ maximum: number; closingDate: string }>(
    `SELECT setting.max_daily_capacity AS maximum,year.closing_date::text AS "closingDate"
       FROM clinic_capacity_settings setting
       JOIN academic_years year ON year.start_year=$3
      WHERE setting.clinic_id=$1 AND setting.schedule_type=$2 AND setting.is_active=TRUE
      FOR UPDATE OF setting,year`, [first.clinicId, first.scheduleType, first.scheduleCycleStart],
  )).rows[0];
  if (!capacity || capacity.maximum <= 0) {
    for (const row of rows) addIssue(row, new AppError("SCHEDULE_CAPACITY_NOT_CONFIGURED",
      "Daily capacity is not configured.", 409));
    return { rows, fingerprint: null, capacity: null,
      service: first.scheduleType, clinicId: first.clinicId,
      academicYearStart: first.scheduleCycleStart };
  }
  const groupRows = rows.filter((row) => row.appointment
    && row.appointment.scheduleType === first.scheduleType
    && row.appointment.clinicId === first.clinicId
    && row.appointment.scheduleCycleStart === first.scheduleCycleStart);
  const occupiedBySelection = (await client.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count FROM appointments appointment
      WHERE appointment.id=ANY($1::uuid[]) AND appointment.appointment_date=$2::date
        AND ${internalOccupancyPredicate("appointment")}`,
    [groupRows.map((row) => row.id), payload.replacementDate],
  )).rows[0].count;
  const used = await getInternalOccupancy(client, payload.replacementDate, first.clinicId, first.scheduleType)
    - occupiedBySelection;
  const aggregate = { used, maximum: capacity.maximum,
    incoming: groupRows.length, resulting: used + groupRows.length };
  for (const row of groupRows) {
    const appointment = row.appointment!;
    const pair = await resolveEffectiveAppointmentPair(client, appointment);
    await validate(row, () => assertManualAppointmentDestination({
      appointment, pair, destinationDate: payload.replacementDate,
      manilaToday: manilaCalendarDate(new Date()),
      cycleStartDate: `${appointment.scheduleCycleStart}-08-01`, cycleClosingDate: capacity.closingDate,
      isBlocked: blocked, usedCapacity: 0,
      maxDailyCapacity: Number.MAX_SAFE_INTEGER,
    }));
  }
  if (aggregate.resulting > aggregate.maximum) {
    for (const row of groupRows) addIssue(row, new AppError("DAILY_CAPACITY_EXCEEDED",
      "The selected service has reached its daily appointment capacity.", 409));
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    rows: rows.map(({ id, expectedUpdatedAt, checklistVersion, pairedDate }) => ({
      id, expectedUpdatedAt, checklistVersion, pairedDate,
    })),
    maximum: capacity.maximum, closingDate: capacity.closingDate, used, blocked,
  })).digest("hex");
  return { rows, fingerprint, capacity: aggregate,
    service: first.scheduleType, clinicId: first.clinicId, academicYearStart: first.scheduleCycleStart };
}
export async function previewBulkReplacement(raw: unknown, actor: SessionUser) {
  const payload = bulkReplacementPayloadSchema.parse(raw);
  return transaction(async (client) => {
    const result = await review(client, payload, actor, true);
    return { rows: result.rows.map((row) => ({ id: row.id, studentNumber: row.studentNumber,
      originalDate: row.originalDate, pairedDate: row.pairedDate,
      expectedUpdatedAt: row.expectedUpdatedAt, checklistVersion: row.checklistVersion,
      retainedTests: row.retainedTests, isManuallyLocked: row.isManuallyLocked,
      issues: row.issues })),
      capacity: result.capacity, service: result.service, academicYearStart: result.academicYearStart,
      previewToken: result.fingerprint && result.rows.every((row) => row.issues.length === 0)
        ? signBulkReplacementPreview({ actorId: actor.userId, payload, fingerprint: result.fingerprint }) : null };
  });
}

export async function commitBulkReplacement(raw: unknown, actor: SessionUser) {
  const input = commitSchema.parse(raw);
  const payload = bulkReplacementPayloadSchema.parse({ appointments: input.appointments,
    replacementDate: input.replacementDate, reason: input.reason });
  return transaction(async (client) => {
    const authority = await authorizedActor(client, actor);
    await lockSchedulingMutationQueue(client);
    const prior = (await client.query<{ action: string; payloadHash: string; outcome: { appointmentIds: string[]; count: number; clinicId: string } }>(
      `SELECT action,payload_hash AS "payloadHash",outcome FROM clinical_mutation_requests
        WHERE actor_user_id=$1 AND request_id=$2 FOR UPDATE`, [actor.userId, input.requestId],
    )).rows[0];
    if (prior) {
      if (prior.action !== "BULK_REPLACEMENT" || prior.payloadHash !== hash(payload)) {
        throw new AppError("CLINICAL_REQUEST_CONFLICT", "This request ID was used with different details.", 409);
      }
      if (authority.role !== "ADMIN" && authority.clinicId !== prior.outcome.clinicId) {
        throw new AppError("CLINIC_ACCESS_DENIED", "You can only access appointments in your assigned clinic.", 403);
      }
      return prior.outcome;
    }
    const proof = verifyBulkReplacementPreview(input.previewToken, { actorId: actor.userId, payload });
    const reviewed = await review(client, payload, actor);
    if (!reviewed.fingerprint || reviewed.fingerprint !== proof.fingerprint) {
      throw new AppError("BULK_PREVIEW_STALE", "Appointments or capacity changed. Preview again.", 409);
    }
    const appointmentIds: string[] = [];
    for (const row of reviewed.rows) {
      const appointment = row.appointment!;
      const replacementId = await rescheduleAppointmentWithClient(
        client, appointment, payload.replacementDate, payload.reason, actor.userId,
      );
      appointmentIds.push(replacementId);
      const event = await client.query<{ id: string }>(
        `INSERT INTO appointment_reschedule_events (
           student_number,schedule_pair_id,cause,schedule_cycle_start,
           old_laboratory_appointment_id,new_laboratory_appointment_id,
           old_physical_exam_appointment_id,new_physical_exam_appointment_id,actor_user_id
         ) VALUES ($1,$2,'MANUAL',$3,
           CASE WHEN $4='LABORATORY' THEN $5::uuid END,
           CASE WHEN $4='LABORATORY' THEN $6::uuid END,
           CASE WHEN $4='PHYSICAL_EXAM' THEN $5::uuid END,
           CASE WHEN $4='PHYSICAL_EXAM' THEN $6::uuid END,$7) RETURNING id::text`,
        [appointment.studentNumber, appointment.schedulePairId, appointment.scheduleCycleStart,
          appointment.scheduleType, appointment.id, replacementId, actor.userId],
      );
      await writeAudit(actor.userId, "APPOINTMENT_RESCHEDULED", "appointment", appointment.id,
        { replacementId, appointmentDate: payload.replacementDate, reason: payload.reason,
          bulkRequestId: input.requestId }, client);
      if (appointment.isManuallyLocked) await writeAudit(actor.userId, "APPOINTMENT_LOCK_INHERITED", "appointment",
        replacementId, { previousAppointmentId: appointment.id, reason: appointment.lockReason }, client);
      await queueAuthoritativeScheduleNotification(client, appointment.studentNumber,
        (state) => buildAdministratorRescheduledNotification({ state,
          eventId: event.rows[0].id, reason: "Administrator-authorized reschedule",
          previous: appointment.scheduleType === "LABORATORY"
            ? { laboratory: { date: appointment.appointmentDate, location: "KABALAKA Clinic" } }
            : { physicalExam: { date: appointment.appointmentDate, location: "CPU Clinic" } },
        }));
    }
    const outcome = { appointmentIds, count: appointmentIds.length, clinicId: reviewed.clinicId! };
    await client.query(
      `INSERT INTO clinical_mutation_requests(actor_user_id,request_id,action,payload_hash,outcome)
       VALUES ($1,$2,'BULK_REPLACEMENT',$3,$4::jsonb)`,
      [actor.userId, input.requestId, hash(payload), JSON.stringify(outcome)],
    );
    return outcome;
  });
}
