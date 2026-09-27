import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { assertOpenAppointmentCycle } from "@/server/appointments/academic-year-visibility";
import {
  assertManualAppointmentDestination,
} from "@/server/appointments/manual-appointment-destination";
import {
  cancellationTargetsForPair,
  type PairAppointment,
} from "@/server/appointments/appointment-pair-integrity";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  changeAppointmentStatusWithClient, getAppointmentLockMutationContext,
  getAppointmentMutationContext, getAppointmentMutationScope, getPublishedAppointment,
  getManualRescheduleDestinationState,
  rescheduleAppointmentWithClient, updateCapacitySetting,
  setAppointmentManualLockWithClient,
  type AppointmentMutationContext, type AppointmentStatus,
} from "@/server/repositories/appointments.repository";
import {
  resolveEffectiveAppointmentPair,
  type EffectivePairAppointment,
} from "@/server/repositories/effective-appointment-pair.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import type { SessionUser } from "@/types/roles";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAdministratorRescheduledNotification,
  buildCancellationNotification,
  type PreviousScheduleState,
} from "@/server/schedule/schedule-notifications";

const transitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["COMPLETED", "RESCHEDULED", "CANCELLED"],
  COMPLETED: [], NO_SHOW: ["RESCHEDULED"], RESCHEDULED: [], CANCELLED: [],
  AWAITING_RESCHEDULE: [],
};

const ADMINISTRATOR_SCHEDULE_NOTIFICATION_REASON = {
  RESCHEDULE: "Administrator-authorized reschedule",
  CANCELLATION: "Administrator-authorized cancellation",
} as const;

export function assertStatusTransition(from: AppointmentStatus, to: AppointmentStatus) {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new AppError("INVALID_STATUS_TRANSITION", `Cannot change ${from} to ${to}.`, 422);
}

export const appointmentUpdateSchema = z.object({
  status: z.enum(["DRAFT", "PENDING", "NO_SHOW", "RESCHEDULED", "CANCELLED"]).optional(),
  appointmentDate: z.iso.date().optional(),
  notes: z.union([z.string().max(1000), z.null()]).optional(),
  lockAction: z.enum(["LOCK", "UNLOCK"]).optional(),
  lockReason: z.union([z.string().max(500), z.null()]).optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((input, context) => {
  if (!input.status && !input.appointmentDate && !input.lockAction) {
    context.addIssue({ code: "custom", message: "Provide a status, reschedule date, or lock action." });
  }
  if (input.lockAction && !input.expectedUpdatedAt) {
    context.addIssue({ code: "custom", path: ["expectedUpdatedAt"], message: "The current appointment version is required." });
  }
});

type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;
type AppointmentMutationContextWithDate = AppointmentMutationContext & { appointmentDate: string };

function isManualLockRequestCandidate(raw: unknown): boolean {
  return typeof raw === "object"
    && raw !== null
    && "lockAction" in raw;
}

function parseAppointmentUpdate(raw: unknown): AppointmentUpdateInput {
  return appointmentUpdateSchema.parse(raw);
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

async function loadLockedAppointmentPair(
  id: string,
  actor: SessionUser,
  client: PoolClient,
) {
  const scope = await getAppointmentMutationScope(id, client);
  if (!scope) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, scope);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
  );
  await lockEffectiveAppointmentScopes(client, [
    { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
    { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
  ]);
  const appointment = await getAppointmentMutationContext(id, client);
  if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  assertAppointmentMutationAuthorized(actor, appointment);
  const pair = await resolveEffectiveAppointmentPair(client, appointment);
  return { appointment, pair };
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

async function recordCancellationScheduleEvent(
  client: PoolClient,
  appointment: AppointmentMutationContextWithDate,
  targets: PairAppointment[],
  actorUserId: string,
) {
  const event = await client.query<{ id: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number,schedule_pair_id,cause,schedule_cycle_start,
       old_laboratory_appointment_id,old_physical_exam_appointment_id,actor_user_id
     ) VALUES ($1,$2,'MANUAL',$3,$4,$5,$6)
     RETURNING id::text`,
    [
      appointment.studentNumber,
      appointment.schedulePairId,
      appointment.scheduleCycleStart,
      targets.find((target) => target.scheduleType === "LABORATORY")?.id ?? null,
      targets.find((target) => target.scheduleType === "PHYSICAL_EXAM")?.id ?? null,
      actorUserId,
    ],
  );
  return event.rows[0].id;
}

function previousStateForCancellation(
  appointment: AppointmentMutationContextWithDate,
  pair: { laboratory: EffectivePairAppointment | null; physicalExam: EffectivePairAppointment | null },
  targets: PairAppointment[],
) {
  const state: PreviousScheduleState = {};
  for (const target of targets) {
    const detail = target.id === appointment.id
      ? appointment
      : target.scheduleType === "LABORATORY"
        ? pair.laboratory
        : pair.physicalExam;
    if (!detail) continue;
    Object.assign(state, previousStateForAppointment(detail));
  }
  return state;
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
  await assertOpenAppointmentCycle(client, appointment.scheduleCycleStart, new Date());

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

export async function updateAppointment(id: string, raw: unknown, actor: SessionUser) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)
    && ("quickStatusAction" in raw || ("status" in raw && raw.status === "COMPLETED"))) {
    throw new AppError("CLINICAL_COMPLETION_RETIRED",
      "Use the Laboratory checklist or examination completion form for clinical completion.", 422);
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
  const input = parseAppointmentUpdate(raw);
  assertAppointmentMutationAuthorized(actor, current);
  if (current.academicYearEnded) {
    throw new AppError("ACADEMIC_YEAR_ENDED", "The academic year has ended; this appointment is historical.", 409);
  }
  if (current.status === "COMPLETED" && (input.status === "PENDING" || input.status === "NO_SHOW")) {
    throw new AppError("CLINICAL_COMPLETION_RETIRED",
      "Correct Laboratory tests through the checklist or use the certificate correction workflow.", 422);
  }
  if (input.appointmentDate) {
    const appointmentDate = input.appointmentDate;
    try {
      const replacementId = await transaction(async (client) => {
        const scope = await getAppointmentMutationScope(id, client);
        if (!scope) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
        assertAppointmentMutationAuthorized(actor, scope);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
        );
        await lockEffectiveAppointmentScopes(client, [
          { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
          { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
        ]);
        const appointment = await getAppointmentMutationContext(id, client);
        if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
        assertAppointmentMutationAuthorized(actor, appointment);
        await assertOpenAppointmentCycle(client, appointment.scheduleCycleStart, new Date());
        if (
          input.expectedUpdatedAt
          && appointment.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()
        ) {
          throw new AppError(
            "APPOINTMENT_STALE",
            "The appointment changed. Reload before creating a replacement.",
            409,
          );
        }
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
        const pair = await resolveEffectiveAppointmentPair(client, appointment);
        const blocked = await isSchedulingDateBlocked(client, {
          scheduleType: appointment.scheduleType as "LABORATORY" | "PHYSICAL_EXAM",
          date: appointmentDate,
        });
        const destination = await getManualRescheduleDestinationState(client, {
          appointmentId: appointment.id,
          clinicId: appointment.clinicId,
          scheduleType: appointment.scheduleType,
          appointmentDate,
          scheduleCycleStart: appointment.scheduleCycleStart,
        });
        if (!destination.cycleClosingDate) {
          throw new AppError(
            "OUTSIDE_SCHEDULING_CYCLE",
            "The appointment scheduling cycle is not configured.",
            409,
          );
        }
        if (destination.maxDailyCapacity === null) {
          throw new AppError(
            "SCHEDULE_CAPACITY_NOT_CONFIGURED",
            "Daily capacity is not configured for this service.",
            409,
          );
        }
        assertManualAppointmentDestination({
          appointment,
          pair,
          destinationDate: appointmentDate,
          manilaToday: manilaToday(),
          cycleStartDate: `${appointment.scheduleCycleStart}-08-01`,
          cycleClosingDate: destination.cycleClosingDate,
          isBlocked: blocked,
          usedCapacity: destination.usedCapacity,
          maxDailyCapacity: destination.maxDailyCapacity,
        });
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
            reason: ADMINISTRATOR_SCHEDULE_NOTIFICATION_REASON.RESCHEDULE,
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
  if (input.status) {
    const requestedStatus = input.status;
    await transaction(async (client) => {
      const lockedPair = requestedStatus === "CANCELLED"
        ? await loadLockedAppointmentPair(id, actor, client)
        : null;
      const appointment = lockedPair?.appointment
        ?? await getAppointmentMutationContext(id, client);
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
      if (requestedStatus === "CANCELLED") {
        const targets = cancellationTargetsForPair(appointment, lockedPair!.pair);
        const note = input.notes?.trim() || null;
        for (const target of targets) {
          await changeAppointmentStatusWithClient(
            client,
            target.id,
            target.status as AppointmentStatus,
            "CANCELLED",
            note,
            actor.userId,
          );
          await writeAudit(
            actor.userId,
            "APPOINTMENT_STATUS_CHANGED",
            "appointment",
            target.id,
            {
              oldStatus: target.status,
              newStatus: "CANCELLED",
              ...(target.id === appointment.id
                ? {}
                : { cascadeFromAppointmentId: appointment.id }),
            },
            client,
          );
        }
        const eventId = await recordCancellationScheduleEvent(
          client,
          appointment,
          targets,
          actor.userId,
        );
        await queueAuthoritativeScheduleNotification(
          client,
          appointment.studentNumber,
          (state) => buildCancellationNotification({
            state,
            eventId,
            reason: ADMINISTRATOR_SCHEDULE_NOTIFICATION_REASON.CANCELLATION,
            previous: previousStateForCancellation(appointment, lockedPair!.pair, targets),
            sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
          }),
        );
        return;
      }
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

export const capacitySchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]),
  scheduleType: z.enum(["PHYSICAL_EXAM", "LABORATORY"]),
  maxDailyCapacity: z.coerce.number().int().positive(),
});

export async function changeCapacity(raw: unknown, actorUserId: string) {
  const input = capacitySchema.parse(raw);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const result = await updateCapacitySetting(input.clinicCode, input.scheduleType, input.maxDailyCapacity, client);
    if (!result) throw new AppError("CAPACITY_NOT_FOUND", "Capacity setting not found.", 404);
    await writeAudit(actorUserId, "CAPACITY_UPDATED", "capacity_setting", `${input.clinicCode}:${input.scheduleType}`, input, client);
    return result;
  });
}
