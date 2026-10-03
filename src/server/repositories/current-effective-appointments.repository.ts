import "server-only";
import { query } from "@/server/db/pool";
import type { AppointmentVisibilityScope } from "@/server/appointments/academic-year-visibility";

export type ScheduleType = "LABORATORY" | "PHYSICAL_EXAM";
export const ATTENDANCE_STATUSES = [
  "PENDING", "COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED", "AWAITING_RESCHEDULE", "UNSCHEDULED",
] as const;
export type AttendanceStatus = typeof ATTENDANCE_STATUSES[number];
export type OperationalAttendanceStatus = Exclude<AttendanceStatus, "UNSCHEDULED">;

export type CurrentEffectiveAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: ScheduleType;
  appointmentDate: string;
  status: OperationalAttendanceStatus;
  createdAt: Date;
  scheduleCycleStart: number;
};

export function effectiveAppointmentsCte(scope: AppointmentVisibilityScope): string {
  if (scope.kind === "YEAR" && (!Number.isInteger(scope.startYear) || scope.startYear < 1900 || scope.startYear > 9999)) {
    throw new Error("Invalid academic year scope");
  }
  const yearPredicate = scope.kind === "CURRENT"
    ? `make_date(year.start_year, 8, 1) <= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
       AND year.closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date`
    : `year.start_year=${scope.startYear}`;
  return `
  published_leaf_appointments AS (
    SELECT appointment.id,
           appointment.student_number AS "studentNumber",
           appointment.schedule_type AS "scheduleType",
           appointment.appointment_date,
           appointment.schedule_cycle_start AS "scheduleCycleStart",
           appointment.status,
           appointment.created_at
      FROM appointments appointment
      JOIN academic_years year ON year.start_year=appointment.schedule_cycle_start
     WHERE appointment.is_published=TRUE
       AND appointment.status<>'DRAFT'
       AND ${yearPredicate}
       AND NOT EXISTS (
         SELECT 1
           FROM appointments replacement
          WHERE replacement.rescheduled_from=appointment.id
            AND replacement.is_published=TRUE
            AND replacement.status<>'DRAFT'
       )
  ),
  ranked_effective_appointments AS (
    SELECT leaf.*,
           ROW_NUMBER() OVER (
             PARTITION BY leaf."studentNumber", leaf."scheduleCycleStart", leaf."scheduleType"
             ORDER BY leaf.appointment_date DESC, leaf.created_at DESC, leaf.id DESC
           ) AS effective_rank
      FROM published_leaf_appointments leaf
  ),
  current_effective_appointments AS (
    SELECT id, "studentNumber", "scheduleType", appointment_date, status, created_at,
           "scheduleCycleStart"
      FROM ranked_effective_appointments
     WHERE effective_rank=1
       ${scope.kind === "CURRENT" ? `AND "scheduleCycleStart"=(
         SELECT MAX(cycle."scheduleCycleStart")
           FROM ranked_effective_appointments cycle
          WHERE cycle."studentNumber"=ranked_effective_appointments."studentNumber"
       )` : ""}
  )`;
}

export const CURRENT_EFFECTIVE_APPOINTMENTS_CTE = effectiveAppointmentsCte({ kind: "CURRENT" });

export async function getCurrentEffectiveAppointmentsForStudent(
  studentNumber: string,
  scope: AppointmentVisibilityScope = { kind: "CURRENT" },
) {
  const result = await query<CurrentEffectiveAppointment>(
    `WITH ${effectiveAppointmentsCte(scope)}
     SELECT id, "studentNumber", "scheduleType",
            appointment_date::text AS "appointmentDate", status,
            created_at AS "createdAt", "scheduleCycleStart"
       FROM current_effective_appointments
      WHERE "studentNumber"=$1
      ORDER BY "scheduleType"`,
    [studentNumber],
  );
  return {
    laboratory: result.rows.find((row) => row.scheduleType === "LABORATORY") ?? null,
    physicalExam: result.rows.find((row) => row.scheduleType === "PHYSICAL_EXAM") ?? null,
  };
}
