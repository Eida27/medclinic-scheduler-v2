import "server-only";
import { query } from "@/server/db/pool";

export type ScheduleType = "LABORATORY" | "PHYSICAL_EXAM";
export type OperationalAttendanceStatus =
  | "PENDING"
  | "COMPLETED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "CANCELLED";
export type AttendanceStatus = OperationalAttendanceStatus | "UNSCHEDULED";

export type CurrentEffectiveAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: ScheduleType;
  appointmentDate: string;
  status: OperationalAttendanceStatus;
  createdAt: Date;
};

export const CURRENT_EFFECTIVE_APPOINTMENTS_CTE = `
  published_leaf_appointments AS (
    SELECT appointment.id,
           appointment.student_number AS "studentNumber",
           appointment.schedule_type AS "scheduleType",
           appointment.appointment_date,
           appointment.status,
           appointment.created_at
      FROM appointments appointment
     WHERE appointment.is_published=TRUE
       AND appointment.status<>'DRAFT'
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
             PARTITION BY leaf."studentNumber", leaf."scheduleType"
             ORDER BY leaf.appointment_date DESC, leaf.created_at DESC, leaf.id DESC
           ) AS effective_rank
      FROM published_leaf_appointments leaf
  ),
  current_effective_appointments AS (
    SELECT id, "studentNumber", "scheduleType", appointment_date, status, created_at
      FROM ranked_effective_appointments
     WHERE effective_rank=1
  )`;

export async function getCurrentEffectiveAppointmentsForStudent(studentNumber: string) {
  const result = await query<CurrentEffectiveAppointment>(
    `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE}
     SELECT id, "studentNumber", "scheduleType",
            appointment_date::text AS "appointmentDate", status,
            created_at AS "createdAt"
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
