import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  changeAppointmentStatusWithClient, getAppointmentLockMutationContext,
  getAppointmentMutationContext, getPublishedAppointment,
  publishBatch, rescheduleAppointmentWithClient, updateCapacitySetting,
  setAppointmentManualLockWithClient,
  type AppointmentMutationContext, type AppointmentStatus,
} from "@/server/repositories/appointments.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { ensureBatchStudentAcademicSnapshotsWithClient } from "@/server/repositories/student-academic-snapshots.repository";
import {
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
} from "@/server/repositories/student-result-submissions.repository";
import type { SessionUser } from "@/types/roles";
import { assertOvpsaAppointmentCompletionAllowed } from "@/server/ovpsa/external-laboratory-verification.service";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAdministratorRescheduledNotification,
  buildCancellationNotification,
  buildInitialPublicationNotification,
  type PreviousScheduleState,
} from "@/server/schedule/schedule-notifications";

const transitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["COMPLETED", "RESCHEDULED", "CANCELLED"],
  COMPLETED: [], NO_SHOW: ["RESCHEDULED"], RESCHEDULED: [], CANCELLED: [],
  AWAITING_RESCHEDULE: [],
};

export function assertStatusTransition(from: AppointmentStatus, to: AppointmentStatus) {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new AppError("INVALID_STATUS_TRANSITION", `Cannot change ${from} to ${to}.`, 422);
}

export const appointmentUpdateSchema = z.object({
  status: z.enum(["DRAFT", "PENDING", "COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED"]).optional(),
  appointmentDate: z.iso.date().optional(),
  notes: z.union([z.string().max(1000), z.null()]).optional(),
  lockAction: z.enum(["LOCK", "UNLOCK"]).optional(),
  lockReason: z.union([z.string().max(500), z.null()]).optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  correctionReason: z.string().trim().min(3).max(1000).optional(),
  source: z.enum(["APPOINTMENTS", "LABORATORY", "PHYSICAL_EXAM"]).optional(),
}).superRefine((input, context) => {
  if (!input.status && !input.appointmentDate && !input.lockAction) {
    context.addIssue({ code: "custom", message: "Provide a status, reschedule date, or lock action." });
  }
  if (input.lockAction && !input.expectedUpdatedAt) {
    context.addIssue({ code: "custom", path: ["expectedUpdatedAt"], message: "The current appointment version is required." });
  }
});

type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;

export const appointmentQuickStatusSchema = z.object({
  quickStatusAction: z.enum(["MARK_COMPLETED", "REVERT_COMPLETION"]),
  expectedStatus: z.enum(["PENDING", "NO_SHOW", "COMPLETED"]),
}).strict();

export type AppointmentQuickStatusRequest = z.infer<typeof appointmentQuickStatusSchema>;

function isQuickStatusRequestCandidate(raw: unknown): boolean {
  return typeof raw === "object"
    && raw !== null
    && ("quickStatusAction" in raw || "expectedStatus" in raw);
}

function isManualLockRequestCandidate(raw: unknown): boolean {
  return typeof raw === "object"
    && raw !== null
    && "lockAction" in raw;
}

function parseAppointmentUpdate(raw: unknown, currentStatus: AppointmentStatus): AppointmentUpdateInput {
  const parsed = appointmentUpdateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (
    currentStatus === "COMPLETED"
    && typeof raw === "object"
    && raw !== null
    && "status" in raw
    && (raw.status === "PENDING" || raw.status === "NO_SHOW")
    && "correctionReason" in raw
    && typeof raw.correctionReason === "string"
    && parsed.error.issues.every((issue) => issue.path[0] === "correctionReason" && issue.code === "too_small")
  ) {
    const withoutInvalidReason = appointmentUpdateSchema.safeParse({ ...raw, correctionReason: undefined });
    if (withoutInvalidReason.success) {
      return { ...withoutInvalidReason.data, correctionReason: raw.correctionReason.trim() };
    }
  }
  throw parsed.error;
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

function assertAppointmentMutationAuthorized(
  actor: SessionUser,
  appointment: Pick<AppointmentMutationContext, "clinicId">,
) {
  if (actor.role !== "ADMIN" && actor.role !== "CLINIC_STAFF") {
    throw new AppError("FORBIDDEN", "You do not have permission to update appointments.", 403);
  }
  if (actor.role === "CLINIC_STAFF" && actor.clinicId !== appointment.clinicId) {
    throw new AppError("CLINIC_ACCESS_DENIED", "You can only manage your assigned clinic.", 403);
  }
}

function assertManualNoShowNotRequested(status?: AppointmentStatus) {
  if (status === "NO_SHOW") {
    throw new AppError(
      "MANUAL_NO_SHOW_NOT_ALLOWED",
      "No-show is assigned automatically at midnight and cannot be set manually.",
      422,
    );
  }
}

function previousStateForAppointment(appointment: {
  scheduleType: string;
  appointmentDate: string;
  clinicCode: string;
}): PreviousScheduleState {
  const previous = {
    date: appointment.appointmentDate,
    location: appointment.clinicCode === "KABALAKA_CLINIC"
      ? "KABALAKA Clinic"
      : "CPU Clinic",
  };
  return appointment.scheduleType === "LABORATORY"
    ? { laboratory: previous }
    : { physicalExam: previous };
}

async function recordManualScheduleEvent(
  client: PoolClient,
  appointment: AppointmentMutationContext & { appointmentDate: string },
  replacementId: string | null,
  actorUserId: string,
) {
  const event = await client.query<{ id: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number,schedule_pair_id,cause,schedule_cycle_start,
       old_laboratory_appointment_id,new_laboratory_appointment_id,
       old_physical_exam_appointment_id,new_physical_exam_appointment_id,
       actor_user_id
     ) VALUES (
       $1,$2,'MANUAL',$3,
       CASE WHEN $4='LABORATORY' THEN $5::uuid END,
       CASE WHEN $4='LABORATORY' THEN $6::uuid END,
       CASE WHEN $4='PHYSICAL_EXAM' THEN $5::uuid END,
       CASE WHEN $4='PHYSICAL_EXAM' THEN $6::uuid END,$7
     ) RETURNING id::text`,
    [
      appointment.studentNumber,
      appointment.schedulePairId,
      appointment.scheduleCycleStart,
      appointment.scheduleType,
      appointment.id,
      replacementId,
      actorUserId,
    ],
  );
  return event.rows[0].id;
}

async function applyAppointmentManualLockWithClient(
  id: string,
  raw: unknown,
  actor: SessionUser,
  client: PoolClient,
) {
  const appointment = await getAppointmentLockMutationContext(id, client);
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "Only administrators can manage appointment locks.", 403);
  }
  if (!appointment || !appointment.isPublished) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  }

  const record = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const actionResult = z.enum(["LOCK", "UNLOCK"]).safeParse(record.lockAction);
  if (!actionResult.success) throw actionResult.error;

  const locking = actionResult.data === "LOCK";
  const expectedUpdatedAt = z.iso.datetime({ offset: true }).parse(record.expectedUpdatedAt);
  if (appointment.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new AppError(
      "APPOINTMENT_STALE",
      "The appointment changed. Reload before updating its protection.",
      409,
    );
  }
  if (locking && appointment.status !== "DRAFT" && appointment.status !== "PENDING") {
    throw new AppError(
      "APPOINTMENT_LOCK_STATUS_INVALID",
      "Only draft or pending appointments can be locked.",
      422,
    );
  }
  if (locking && appointment.isManuallyLocked) {
    throw new AppError("APPOINTMENT_ALREADY_LOCKED", "This appointment is already locked. Refresh the page.", 409);
  }
  if (!locking && !appointment.isManuallyLocked) {
    throw new AppError("APPOINTMENT_ALREADY_UNLOCKED", "This appointment is already unlocked. Refresh the page.", 409);
  }

  const rawReason = record.lockReason;
  const reason = locking && typeof rawReason === "string"
    ? rawReason.trim()
    : locking
      ? null
      : appointment.lockReason;
  if (locking && (!reason || reason.length < 3)) {
    throw new AppError(
      "LOCK_REASON_REQUIRED",
      "Enter a reason for locking this appointment.",
      422,
    );
  }
  if (reason && reason.length > 500) {
    throw z.string().max(500).parse(reason);
  }
  const updated = await setAppointmentManualLockWithClient(
    client,
    id,
    locking,
    actor.userId,
    locking ? reason! : null,
  );
  if (!updated) {
    throw new AppError("APPOINTMENT_STALE", "The appointment changed. Reload before updating its protection.", 409);
  }
  await writeAudit(
    actor.userId,
    locking ? "APPOINTMENT_LOCKED" : "APPOINTMENT_UNLOCKED",
    "appointment",
    id,
    {
      appointmentId: id,
      studentNumber: appointment.studentNumber,
      scheduleType: appointment.scheduleType,
      reason: reason ?? null,
      previousAppointmentId: null,
    },
    client,
  );
}

export async function completeAppointmentWithClient(
  id: string,
  actor: SessionUser,
  reason: string | null | undefined,
  client: PoolClient,
) {
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
  if (appointment.ovpsaBatchId && appointment.scheduleType === "LABORATORY") {
    throw new AppError(
      "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
      "First Year Mission Hospital Laboratory appointments can only be changed through external-result verification or the batch lifecycle.",
      422,
    );
  }
  await assertOvpsaAppointmentCompletionAllowed(client, appointment);
  if (appointment.status === "COMPLETED") return appointment;
  if (appointment.status === "NO_SHOW") {
    if (!isAutomaticNoShowLog(appointment.latestLog)) {
      throw new AppError("NO_SHOW_CORRECTION_NOT_ALLOWED", "Only an automatic no-show can be corrected to completed.", 422);
    }
    if (!reason?.trim()) {
      throw new AppError("CORRECTION_REASON_REQUIRED", "Enter a reason for correcting this automatic no-show.", 422);
    }
  } else if (appointment.status !== "PENDING") {
    assertStatusTransition(appointment.status, "COMPLETED");
  }
  await changeAppointmentStatusWithClient(
    client,
    id,
    appointment.status,
    "COMPLETED",
    reason?.trim() || null,
    actor.userId,
  );
  await ensurePendingUploadResult(client, appointment);
  return appointment;
}

async function correctCompletedAppointmentWithClient(
  id: string,
  target: "PENDING" | "NO_SHOW",
  correctionReason: string | undefined,
  source: "APPOINTMENTS" | "LABORATORY" | "PHYSICAL_EXAM" | undefined,
  actor: SessionUser,
  client: PoolClient,
) {
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
  if (appointment.ovpsaBatchId && appointment.scheduleType === "LABORATORY") {
    throw new AppError(
      "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
      "First Year Mission Hospital Laboratory appointments cannot be corrected through generic appointment controls.",
      422,
    );
  }
  if (appointment.status !== "COMPLETED") {
    throw new AppError(
      "APPOINTMENT_STATUS_CONFLICT",
      "The appointment status changed. Refresh and try again.",
      409,
    );
  }
  const reason = correctionReason?.trim();
  if (!reason || reason.length < 3) {
    throw new AppError(
      "CORRECTION_REASON_REQUIRED",
      "Enter a reason for correcting this completed appointment.",
      422,
    );
  }
  if (target === "NO_SHOW" && appointment.appointmentDate >= manilaToday()) {
    throw new AppError(
      "NO_SHOW_REQUIRES_PAST_DATE",
      "A completed appointment can be corrected to no-show only after its appointment date.",
      422,
    );
  }
  const resultState = await getAppointmentResultCorrectionState(client, appointment);
  if (resultState.type === "PROTECTED") {
    throw new AppError(
      "APPOINTMENT_RESULT_PROTECTED",
      "This appointment has protected result data and cannot be corrected.",
      409,
    );
  }
  if (resultState.type === "PENDING_PLACEHOLDER") {
    await deletePendingResultPlaceholder(client, resultState);
  }
  await changeAppointmentStatusWithClient(
    client,
    id,
    "COMPLETED",
    target,
    reason,
    actor.userId,
  );
  await writeAudit(
    actor.userId,
    "APPOINTMENT_STATUS_CORRECTED",
    "appointment",
    id,
    {
      oldStatus: "COMPLETED",
      newStatus: target,
      reason,
      source: source ?? "APPOINTMENTS",
    },
    client,
  );
}

async function applyQuickStatusWithClient(
  id: string,
  input: AppointmentQuickStatusRequest,
  actor: SessionUser,
  client: PoolClient,
) {
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
  if (appointment.ovpsaBatchId && appointment.scheduleType === "LABORATORY") {
    throw new AppError(
      "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
      "First Year Mission Hospital Laboratory appointments can only be changed through external-result verification or the batch lifecycle.",
      422,
    );
  }
  if (appointment.status !== input.expectedStatus) {
    throw new AppError(
      "APPOINTMENT_STATUS_CONFLICT",
      "The appointment status changed. Refresh and try again.",
      409,
    );
  }

  if (input.quickStatusAction === "MARK_COMPLETED") {
    await assertOvpsaAppointmentCompletionAllowed(client, appointment);
    if (appointment.status !== "PENDING" && appointment.status !== "NO_SHOW") {
      throw new AppError(
        "APPOINTMENT_QUICK_STATUS_NOT_ALLOWED",
        "Only pending or automatic no-show appointments can be marked completed from the clinic schedule.",
        422,
      );
    }
    if (appointment.status === "NO_SHOW" && !isAutomaticNoShowLog(appointment.latestLog)) {
      throw new AppError(
        "NO_SHOW_CORRECTION_NOT_ALLOWED",
        "Only an automatic no-show can be corrected to completed.",
        422,
      );
    }
    const oldStatus = appointment.status;
    const note = oldStatus === "PENDING"
      ? "Marked completed through the clinic schedule."
      : "Automatic no-show corrected to completed through the clinic schedule.";
    await changeAppointmentStatusWithClient(client, id, oldStatus, "COMPLETED", note, actor.userId);
    await ensurePendingUploadResult(client, appointment);
    await writeAudit(
      actor.userId,
      oldStatus === "PENDING" ? "APPOINTMENT_STATUS_CHANGED" : "APPOINTMENT_STATUS_CORRECTED",
      "appointment",
      id,
      {
        oldStatus,
        newStatus: "COMPLETED",
        quickStatusAction: input.quickStatusAction,
        source: "CLINIC_SCHEDULE_QUICK_STATUS",
      },
      client,
    );
    return;
  }

  if (appointment.status !== "COMPLETED") {
    throw new AppError(
      "APPOINTMENT_QUICK_STATUS_NOT_ALLOWED",
      "Only completed appointments can be reverted from the clinic schedule.",
      422,
    );
  }
  const target = appointment.completedFromStatus;
  if (target !== "PENDING" && target !== "NO_SHOW") {
    throw new AppError(
      "APPOINTMENT_COMPLETION_HISTORY_INVALID",
      "The previous appointment status could not be determined. Open the appointment details to review its history.",
      409,
    );
  }
  const resultState = await getAppointmentResultCorrectionState(client, appointment);
  if (resultState.type === "PROTECTED") {
    throw new AppError(
      "APPOINTMENT_RESULT_PROTECTED",
      "This appointment can no longer be reverted because protected result data is linked to it.",
      409,
    );
  }
  if (resultState.type === "PENDING_PLACEHOLDER") {
    await deletePendingResultPlaceholder(client, resultState);
  }
  const note = target === "PENDING"
    ? "Clinic schedule completion reverted to pending."
    : "Clinic schedule completion reverted to the previous automatic no-show.";
  await changeAppointmentStatusWithClient(client, id, "COMPLETED", target, note, actor.userId);
  await writeAudit(
    actor.userId,
    "APPOINTMENT_STATUS_CORRECTED",
    "appointment",
    id,
    {
      oldStatus: "COMPLETED",
      newStatus: target,
      quickStatusAction: input.quickStatusAction,
      source: "CLINIC_SCHEDULE_QUICK_STATUS",
    },
    client,
  );
}

export async function updateAppointment(id: string, raw: unknown, actor: SessionUser) {
  if (isQuickStatusRequestCandidate(raw)) {
    const input = appointmentQuickStatusSchema.parse(raw);
    await transaction((client) => applyQuickStatusWithClient(id, input, actor, client));
    return getPublishedAppointment(id);
  }
  if (isManualLockRequestCandidate(raw)) {
    await transaction((client) => applyAppointmentManualLockWithClient(
      id,
      raw,
      actor,
      client,
    ));
    return getPublishedAppointment(id);
  }
  const current = await getPublishedAppointment(id);
  if (!current) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  const input = parseAppointmentUpdate(raw, current.status);
  assertAppointmentMutationAuthorized(actor, current);
  if (input.appointmentDate) {
    const appointmentDate = input.appointmentDate;
    try {
      const replacementId = await transaction(async (client) => {
        await lockEffectiveAppointmentScopes(client, [current]);
        const appointment = await getAppointmentMutationContext(id, client);
        if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
        assertAppointmentMutationAuthorized(actor, appointment);
        assertManualNoShowNotRequested(input.status);
        if (!["PENDING", "NO_SHOW"].includes(appointment.status)) {
          throw new AppError("INVALID_RESCHEDULE", "Only pending or no-show appointments can be rescheduled.", 422);
        }
        if (appointment.ovpsaBatchId) {
          throw new AppError(
            "OVPSA_APPOINTMENT_REQUIRES_BATCH_RESCHEDULE",
            "First Year OVPSA appointments must be moved through the batch reschedule workflow.",
            409,
          );
        }
        if (await isSchedulingDateBlocked(client, {
          scheduleType: appointment.scheduleType as "LABORATORY" | "PHYSICAL_EXAM",
          date: appointmentDate,
        })) {
          throw new AppError(
            "OVPSA_SERVICE_RESERVATION_CONFLICT",
            `${appointmentDate} is closed or reserved for First Year OVPSA scheduling.`,
            409,
          );
        }
        const replacementAppointmentId = await rescheduleAppointmentWithClient(
          client,
          appointment,
          appointmentDate,
          input.notes?.trim() || null,
          actor.userId,
        );
        if (appointment.isManuallyLocked) {
          await writeAudit(
            actor.userId,
            "APPOINTMENT_LOCK_INHERITED",
            "appointment",
            replacementAppointmentId,
            {
              appointmentId: replacementAppointmentId,
              previousAppointmentId: appointment.id,
              studentNumber: appointment.studentNumber,
              scheduleType: appointment.scheduleType,
              reason: appointment.lockReason,
            },
            client,
          );
        }
        await writeAudit(
          actor.userId,
          "APPOINTMENT_RESCHEDULED",
          "appointment",
          id,
          { replacementId: replacementAppointmentId, appointmentDate },
          client,
        );
        const eventId = await recordManualScheduleEvent(
          client,
          appointment,
          replacementAppointmentId,
          actor.userId,
        );
        await queueAuthoritativeScheduleNotification(
          client,
          appointment.studentNumber,
          (state) => buildAdministratorRescheduledNotification({
            state,
            eventId,
            reason: input.notes?.trim() || "Administrator-authorized reschedule",
            previous: previousStateForAppointment(appointment),
          }),
        );
        return replacementAppointmentId;
      });
      return getPublishedAppointment(String(replacementId));
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new AppError("ACTIVE_APPOINTMENT_EXISTS", "The student already has an active appointment for this service.", 409);
      throw error;
    }
  }
  if (
    current.status === "COMPLETED"
    && (input.status === "PENDING" || input.status === "NO_SHOW")
  ) {
    const correctionTarget = input.status;
    await transaction((client) => correctCompletedAppointmentWithClient(
      id,
      correctionTarget,
      input.correctionReason,
      input.source,
      actor,
      client,
    ));
    return getPublishedAppointment(id);
  }
  if (input.status === "COMPLETED") {
    await transaction(async (client) => {
      const appointment = await completeAppointmentWithClient(id, actor, input.notes, client);
      if (appointment.status === "COMPLETED") return;
      const reason = input.notes?.trim() || null;
      await writeAudit(
        actor.userId,
        appointment.status === "NO_SHOW"
          ? "APPOINTMENT_STATUS_CORRECTED"
          : "APPOINTMENT_STATUS_CHANGED",
        "appointment",
        id,
        {
          oldStatus: appointment.status,
          newStatus: "COMPLETED",
          reason,
          source: "APPOINTMENT_DETAIL",
        },
        client,
      );
    });
    return getPublishedAppointment(id);
  }
  if (input.status) {
    const requestedStatus = input.status;
    await transaction(async (client) => {
      const appointment = await getAppointmentMutationContext(id, client);
      if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
      assertAppointmentMutationAuthorized(actor, appointment);
      if (appointment.ovpsaBatchId && appointment.scheduleType === "LABORATORY") {
        throw new AppError(
          "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
          "First Year Mission Hospital Laboratory appointments can only be changed through external-result verification or the batch lifecycle.",
          422,
        );
      }
      assertManualNoShowNotRequested(requestedStatus);
      assertStatusTransition(appointment.status, requestedStatus);
      await changeAppointmentStatusWithClient(
        client,
        id,
        appointment.status,
        requestedStatus,
        input.notes?.trim() || null,
        actor.userId,
      );
      await writeAudit(
        actor.userId,
        "APPOINTMENT_STATUS_CHANGED",
        "appointment",
        id,
        { oldStatus: appointment.status, newStatus: requestedStatus },
        client,
      );
      if (requestedStatus === "CANCELLED") {
        const eventId = await recordManualScheduleEvent(
          client,
          appointment,
          null,
          actor.userId,
        );
        await queueAuthoritativeScheduleNotification(
          client,
          appointment.studentNumber,
          (state) => buildCancellationNotification({
            state,
            eventId,
            reason: input.notes?.trim() || "Administrator-authorized cancellation",
            previous: previousStateForAppointment(appointment),
            sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
          }),
        );
      }
    });
  }
  return getPublishedAppointment(id);
}

export async function publishScheduleBatchWithClient(
  batchId: string,
  actorUserId: string,
  client?: PoolClient,
  allowGrouped = false,
  snapshotsAlreadyEnsured = false,
) {
  const publish = async (transactionClient: PoolClient) => {
    const batch = await getScheduleBatch(batchId, transactionClient);
    if (!batch) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404);
    if (batch.importGroupId && !allowGrouped) {
      throw new AppError(
        "GROUPED_BATCH_ACTION_REQUIRED",
        "This batch belongs to a grouped schedule import. Use the grouped import action instead.",
        409,
      );
    }
    if (!snapshotsAlreadyEnsured) {
      const snapshots = await ensureBatchStudentAcademicSnapshotsWithClient(
        transactionClient,
        { actorUserId, batchIds: [batchId] },
      );
      if (snapshots.outcome === "CONFLICT") {
        return { snapshotConflict: snapshots.conflicts } as const;
      }
    }
    const result = await publishBatch(batchId, actorUserId, transactionClient);
    if (!result) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404);
    if ("invalidStatus" in result) throw new AppError("BATCH_NOT_GENERATED", "Only generated batches can be published.", 409);
    await writeAudit(
      actorUserId,
      "SCHEDULE_BATCH_PUBLISHED",
      "schedule_batch",
      batchId,
      result,
      transactionClient,
    );
    if (!allowGrouped) {
      const students = await transactionClient.query<{ student_number: string }>(
        `SELECT DISTINCT student_number FROM appointments
          WHERE batch_id=$1 AND is_published=TRUE ORDER BY student_number`,
        [batchId],
      );
      for (const student of students.rows) {
        await queueAuthoritativeScheduleNotification(
          transactionClient,
          student.student_number,
          (state) => buildInitialPublicationNotification({
            state,
            sourceType: "SCHEDULE_BATCH",
            sourceId: batchId,
          }),
        );
      }
    }
    return result;
  };
  return client ? publish(client) : transaction(publish);
}

export async function publishScheduleBatch(batchId: string, actorUserId: string) {
  const result = await publishScheduleBatchWithClient(batchId, actorUserId);
  if ("snapshotConflict" in result) {
    throw new AppError(
      "SNAPSHOT_CONFLICT",
      "Publication conflicts with immutable academic history.",
      409,
      undefined,
      { conflicts: result.snapshotConflict },
    );
  }
  return result;
}

export const capacitySchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]),
  scheduleType: z.enum(["PHYSICAL_EXAM", "LABORATORY"]),
  maxDailyCapacity: z.coerce.number().int().positive(),
});

export async function changeCapacity(raw: unknown, actorUserId: string) {
  const input = capacitySchema.parse(raw);
  const result = await updateCapacitySetting(input.clinicCode, input.scheduleType, input.maxDailyCapacity);
  if (!result) throw new AppError("CAPACITY_NOT_FOUND", "Capacity setting not found.", 404);
  await writeAudit(actorUserId, "CAPACITY_UPDATED", "capacity_setting", `${input.clinicCode}:${input.scheduleType}`, input);
  return result;
}
