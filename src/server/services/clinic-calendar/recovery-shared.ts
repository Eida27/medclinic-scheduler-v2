import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import type { SessionUser } from "@/types/roles";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import { type AuthoritativeScheduleState, type PreviousScheduleState } from "@/server/schedule/schedule-notifications";
import type { StudentNotificationInput } from "@/server/repositories/student-notifications.repository";
import {
  type ClinicCycleAppointment,
  type ReplacementCapacity,
  type UsedReplacementCapacity,
} from "../clinic-calendar-planner";

export function resultProtectionAuditMetadata(appointments: ClinicCycleAppointment[]) {
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

export function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
}

export function validationError(message: string, details?: unknown) {
  return new AppError("VALIDATION_ERROR", message, 422, undefined, details);
}

export function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function loadCapacity(client: PoolClient) {
  const capacityRows = await client.query<{ schedule_type: keyof ReplacementCapacity; max_daily_capacity: number }>(
    `SELECT setting.schedule_type,setting.max_daily_capacity
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE clinic.code IN ('KABALAKA_CLINIC','CPU_CLINIC') AND setting.is_active=TRUE`,
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
      WHERE status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
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

export function reserveCapacity(
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

export function copyCapacity(used: UsedReplacementCapacity): UsedReplacementCapacity {
  return { LABORATORY: new Map(used.LABORATORY), PHYSICAL_EXAM: new Map(used.PHYSICAL_EXAM) };
}

export async function createClosureNotification(
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

export function previousScheduleForAppointments(appointments: Array<{
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
