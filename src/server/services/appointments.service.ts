import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  changeAppointmentStatusWithClient, getAppointmentMutationContext, getPublishedAppointment,
  publishBatch, rescheduleAppointmentWithClient, updateCapacitySetting,
  setAppointmentManualLockWithClient,
  type AppointmentMutationContext, type AppointmentStatus,
} from "@/server/repositories/appointments.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import {
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
} from "@/server/repositories/student-result-submissions.repository";
import type { SessionUser } from "@/types/roles";

const transitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["COMPLETED", "RESCHEDULED", "CANCELLED"],
  COMPLETED: [], NO_SHOW: ["RESCHEDULED"], RESCHEDULED: [], CANCELLED: [],
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
  correctionReason: z.string().trim().min(3).max(1000).optional(),
  source: z.enum(["APPOINTMENTS", "LABORATORY", "PHYSICAL_EXAM"]).optional(),
}).superRefine((input, context) => {
  if (!input.status && !input.appointmentDate && !input.lockAction) {
    context.addIssue({ code: "custom", message: "Provide a status, reschedule date, or lock action." });
  }
  if (input.lockAction === "LOCK" && !input.lockReason?.trim()) {
    context.addIssue({ code: "custom", path: ["lockReason"], message: "Lock reason is required." });
  }
});

type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;

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

export async function completeAppointmentWithClient(
  id: string,
  actor: SessionUser,
  reason: string | null | undefined,
  client: PoolClient,
) {
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
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

export async function updateAppointment(id: string, raw: unknown, actor: SessionUser) {
  const current = await getPublishedAppointment(id);
  if (!current) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  const input = parseAppointmentUpdate(raw, current.status);
  assertAppointmentMutationAuthorized(actor, current);
  if (input.lockAction) {
    if (actor.role !== "ADMIN") {
      throw new AppError("FORBIDDEN", "Only administrators can lock appointments.", 403);
    }
    await transaction(async (client) => {
      const updated = await setAppointmentManualLockWithClient(
        client,
        id,
        input.lockAction === "LOCK",
        actor.userId,
        input.lockAction === "LOCK" ? input.lockReason!.trim() : null,
      );
      if (!updated) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
      await writeAudit(
        actor.userId,
        input.lockAction === "LOCK" ? "APPOINTMENT_LOCKED" : "APPOINTMENT_UNLOCKED",
        "appointment",
        id,
        input.lockAction === "LOCK" ? { reason: input.lockReason!.trim() } : {},
        client,
      );
    });
    return getPublishedAppointment(id);
  }
  if (input.appointmentDate) {
    const appointmentDate = input.appointmentDate;
    try {
      const replacementId = await transaction(async (client) => {
        const appointment = await getAppointmentMutationContext(id, client);
        if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
        assertAppointmentMutationAuthorized(actor, appointment);
        assertManualNoShowNotRequested(input.status);
        if (!["PENDING", "NO_SHOW"].includes(appointment.status)) {
          throw new AppError("INVALID_RESCHEDULE", "Only pending or no-show appointments can be rescheduled.", 422);
        }
        const replacementAppointmentId = await rescheduleAppointmentWithClient(
          client,
          appointment,
          appointmentDate,
          input.notes?.trim() || null,
          actor.userId,
        );
        await writeAudit(
          actor.userId,
          "APPOINTMENT_RESCHEDULED",
          "appointment",
          id,
          { replacementId: replacementAppointmentId, appointmentDate },
          client,
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
    });
  }
  return getPublishedAppointment(id);
}

export async function publishScheduleBatchWithClient(
  batchId: string,
  actorUserId: string,
  client?: PoolClient,
  allowGrouped = false,
) {
  const batch = await getScheduleBatch(batchId, client);
  if (!batch) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404);
  if (batch.importGroupId && !allowGrouped) {
    throw new AppError(
      "GROUPED_BATCH_ACTION_REQUIRED",
      "This batch belongs to a grouped schedule import. Use the grouped import action instead.",
      409,
    );
  }
  const result = await publishBatch(batchId, actorUserId, client);
  if (!result) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404);
  if ("invalidStatus" in result) throw new AppError("BATCH_NOT_GENERATED", "Only generated batches can be published.", 409);
  await writeAudit(actorUserId, "SCHEDULE_BATCH_PUBLISHED", "schedule_batch", batchId, result, client);
  return result;
}

export async function publishScheduleBatch(batchId: string, actorUserId: string) {
  return publishScheduleBatchWithClient(batchId, actorUserId);
}

export const capacitySchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]),
  scheduleType: z.enum(["PHYSICAL_EXAM", "LABORATORY"]),
  safeDailyCapacity: z.coerce.number().int().positive(),
  maxDailyCapacity: z.coerce.number().int().positive(),
}).refine((input) => input.maxDailyCapacity >= input.safeDailyCapacity, { path: ["maxDailyCapacity"], message: "Maximum capacity must be at least the safe capacity." });

export async function changeCapacity(raw: unknown, actorUserId: string) {
  const input = capacitySchema.parse(raw);
  const result = await updateCapacitySetting(input.clinicCode, input.scheduleType, input.safeDailyCapacity, input.maxDailyCapacity);
  if (!result) throw new AppError("CAPACITY_NOT_FOUND", "Capacity setting not found.", 404);
  await writeAudit(actorUserId, "CAPACITY_UPDATED", "capacity_setting", `${input.clinicCode}:${input.scheduleType}`, input);
  return result;
}
