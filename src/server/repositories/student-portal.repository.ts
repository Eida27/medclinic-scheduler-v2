import "server-only";
import { query } from "@/server/db/pool";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

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
    appointmentDate: string;
    status: string;
    rescheduledFrom: string | null;
  }>(
    `SELECT appointment.id,
            appointment.student_number AS "studentNumber",
            appointment.schedule_type AS "scheduleType",
            appointment.appointment_date::text AS "appointmentDate",
            appointment.status,
            appointment.rescheduled_from AS "rescheduledFrom"
       FROM appointments appointment
      WHERE appointment.student_number=$1 AND appointment.is_published=TRUE
      ORDER BY appointment.appointment_date, appointment.schedule_type, appointment.created_at`,
    [studentNumber],
  );
  return { ...student, appointments: appointments.rows };
}
