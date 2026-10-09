import "server-only";
import { query } from "@/server/db/pool";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import {
  authoritativeScheduleDateSql,
  authoritativeScheduleLocationSql,
  currentPublishedSchedulePredicate,
} from "@/server/schedule/schedule-state-sql";

export type ActiveStudentIdentity = {
  studentNumber: string;
  studentName: string;
  email: string | null;
  emailVerifiedAt: Date | null;
};

export async function findActiveStudentIdentity(studentNumber: string) {
  const result = await query<ActiveStudentIdentity>(
    `SELECT student.student_number AS "studentNumber",
            ${studentDisplayNameSql("student")} AS "studentName",
            student.email, student.email_verified_at AS "emailVerifiedAt"
       FROM students student
      WHERE student.student_number=$1 AND student.is_active=TRUE`,
    [studentNumber],
  );
  return result.rows[0] ?? null;
}

export async function getStudentPortalSchedule(studentNumber: string) {
  const student = await findActiveStudentIdentity(studentNumber);
  if (!student) return null;
  const appointments = await query<{
    id: string;
    studentNumber: string;
    scheduleType: string;
    appointmentDate: string | null;
    status: string;
    rescheduledFrom: string | null;
    locationName: string;
    isOvpsaFirstYear: boolean;
    displayStatus: string;
    academicYearStart: number;
    isFutureAcademicYear: boolean;
  }>(
    `SELECT appointment.id,
            appointment.student_number AS "studentNumber",
            appointment.schedule_type AS "scheduleType",
            ${authoritativeScheduleDateSql("appointment")} AS "appointmentDate",
            appointment.status,
            appointment.rescheduled_from AS "rescheduledFrom",
            appointment.schedule_cycle_start AS "academicYearStart",
            (make_date(academic_year.start_year, 8, 1) >
              (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date) AS "isFutureAcademicYear",
            ${authoritativeScheduleLocationSql("appointment", "clinic")} AS "locationName",
            (appointment.ovpsa_batch_id IS NOT NULL) AS "isOvpsaFirstYear",
            CASE WHEN appointment.ovpsa_batch_id IS NOT NULL
                       AND appointment.schedule_type='LABORATORY'
                       AND appointment.status='PENDING' AND verification.id IS NULL
                 THEN 'Awaiting confirmation at Physical Examination' ELSE appointment.status END AS "displayStatus"
       FROM appointments appointment
       JOIN academic_years academic_year ON academic_year.start_year=appointment.schedule_cycle_start
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
       LEFT JOIN ovpsa_external_laboratory_verifications verification
         ON verification.appointment_id=appointment.id
      WHERE appointment.student_number=$1
        AND academic_year.closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
        AND ${currentPublishedSchedulePredicate("appointment")}
      ORDER BY appointment.appointment_date, appointment.schedule_type, appointment.created_at`,
    [studentNumber],
  );
  const history = await query<{
    id: string;
    scheduleType: string;
    originalDate: string;
    status: string;
    closureReason: string | null;
    strategy: string | null;
    academicYearStart: number;
    isEndedAcademicYear: boolean;
    isFutureAcademicYear: boolean;
  }>(
    `SELECT appointment.id::text,appointment.schedule_type AS "scheduleType",
            appointment.appointment_date::text AS "originalDate",appointment.status,
            closure.reason AS "closureReason",event.strategy,
            appointment.schedule_cycle_start AS "academicYearStart",
            (academic_year.closing_date < (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date) AS "isEndedAcademicYear",
            (make_date(academic_year.start_year, 8, 1) >
              (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date) AS "isFutureAcademicYear"
       FROM appointments appointment
       JOIN academic_years academic_year ON academic_year.start_year=appointment.schedule_cycle_start
       LEFT JOIN appointment_reschedule_events event
         ON appointment.id IN (event.old_laboratory_appointment_id,event.old_physical_exam_appointment_id)
       LEFT JOIN clinic_closure_groups closure ON closure.id=event.closure_group_id
      WHERE appointment.student_number=$1
        AND (appointment.status IN ('RESCHEDULED','AWAITING_RESCHEDULE') OR event.id IS NOT NULL)
      ORDER BY appointment.appointment_date,appointment.schedule_type,appointment.created_at`,
    [studentNumber],
  );
  const previousAcademicYears = await query<{
    id: string; scheduleType: string; appointmentDate: string | null; status: string;
    academicYearStart: number; locationName: string;
  }>(
    `SELECT appointment.id::text,appointment.schedule_type AS "scheduleType",
            ${authoritativeScheduleDateSql("appointment")} AS "appointmentDate",
            appointment.status,appointment.schedule_cycle_start AS "academicYearStart",
            ${authoritativeScheduleLocationSql("appointment", "clinic")} AS "locationName"
       FROM appointments appointment
       JOIN academic_years academic_year ON academic_year.start_year=appointment.schedule_cycle_start
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
      WHERE appointment.student_number=$1
        AND academic_year.closing_date < (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
        AND ${currentPublishedSchedulePredicate("appointment")}
      ORDER BY appointment.schedule_cycle_start DESC,appointment.appointment_date,appointment.schedule_type`,
    [studentNumber],
  );
  return { ...student, appointments: appointments.rows, history: history.rows,
    previousAcademicYears: previousAcademicYears.rows };
}
