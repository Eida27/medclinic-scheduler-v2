import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  changeAppointmentStatus, changeAppointmentStatusWithClient, getAppointmentMutationContext,
  getPublishedAppointment, publishBatch, rescheduleAppointment, updateCapacitySetting,
  type AppointmentMutationContext, type AppointmentStatus,
} from "@/server/repositories/appointments.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import type { SessionUser } from "@/types/roles";

const transitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED"],
  COMPLETED: [], NO_SHOW: ["RESCHEDULED"], RESCHEDULED: [], CANCELLED: [],
};

export function assertStatusTransition(from: AppointmentStatus, to: AppointmentStatus) {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new AppError("INVALID_STATUS_TRANSITION", `Cannot change ${from} to ${to}.`, 422);
}

export const appointmentUpdateSchema = z.object({
  status: z.enum(["DRAFT", "PENDING", "COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED"]).optional(),
  appointmentDate: z.iso.date().optional(),
  appointmentTime: z.union([z.string().regex(/^\d{2}:\d{2}$/), z.literal(""), z.null()]).optional(),
  notes: z.union([z.string().max(1000), z.null()]).optional(),
}).refine((input) => input.status || input.appointmentDate, "Provide a status or a reschedule date.");

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

export async function completeAppointmentWithClient(
  id: string,
  actor: SessionUser,
  reason: string | null | undefined,
  client: PoolClient,
) {
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
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
  return appointment;
}

export async function updateAppointment(id: string, raw: unknown, actor: SessionUser) {
  const current = await getPublishedAppointment(id);
  if (!current) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  const input = appointmentUpdateSchema.parse(raw);
  assertAppointmentMutationAuthorized(actor, current);
  if (input.status === "COMPLETED") {
    await transaction(async (client) => {
      const appointment = await completeAppointmentWithClient(id, actor, input.notes, client);
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
  if (input.appointmentDate) {
    if (!["PENDING", "NO_SHOW"].includes(String(current.status))) throw new AppError("INVALID_RESCHEDULE", "Only pending or no-show appointments can be rescheduled.", 422);
    try {
      const replacementId = await rescheduleAppointment(id, input.appointmentDate, input.appointmentTime || null, input.notes?.trim() || null, actor.userId);
      await writeAudit(actor.userId, "APPOINTMENT_RESCHEDULED", "appointment", id, { replacementId, appointmentDate: input.appointmentDate });
      return getPublishedAppointment(String(replacementId));
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new AppError("ACTIVE_APPOINTMENT_EXISTS", "The student already has an active appointment for this service.", 409);
      throw error;
    }
  }
  if (input.status) {
    assertStatusTransition(current.status as AppointmentStatus, input.status);
    await changeAppointmentStatus(id, input.status, input.notes?.trim() || null, actor.userId);
    await writeAudit(actor.userId, "APPOINTMENT_STATUS_CHANGED", "appointment", id, { oldStatus: current.status, newStatus: input.status });
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
