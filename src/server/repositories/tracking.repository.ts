import "server-only";
import {
  parseAppointmentSummarySort,
  type OverallStatus,
} from "@/components/appointments/appointment-summary";
import { query } from "@/server/db/pool";
import type { ClinicCode } from "@/server/clinics";
import { appointmentSummaryReport } from "./appointment-summary.repository";

export type ResultType = "PHYSICAL_EXAM" | "LABORATORY";

export async function resultsForStudent(studentNumber: string) {
  const student = await query<{ studentNumber: string; studentName: string; collegeName: string; programName: string }>(
    `SELECT s.student_number AS "studentNumber", CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName",
            c.name AS "collegeName", p.name AS "programName"
     FROM students s JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id
     WHERE s.student_number=$1`, [studentNumber]);
  if (!student.rows[0]) return null;
  const exam = await query(
    `SELECT r.id, r.appointment_id AS "appointmentId", r.result_status AS "resultStatus",
            r.completed_at::text AS "completedAt", r.remarks, r.created_at AS "createdAt",
            a.appointment_date::text AS "appointmentDate"
     FROM exam_results r LEFT JOIN appointments a ON a.id=r.appointment_id
     WHERE r.student_number=$1
       AND (r.appointment_id IS NULL OR a.is_published=TRUE)
     ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC`, [studentNumber]);
  const laboratory = await query(
    `SELECT r.id, r.appointment_id AS "appointmentId", r.result_status AS "resultStatus",
            r.completed_at::text AS "completedAt", r.remarks, r.created_at AS "createdAt",
            a.appointment_date::text AS "appointmentDate"
     FROM laboratory_results r LEFT JOIN appointments a ON a.id=r.appointment_id
     WHERE r.student_number=$1
       AND (r.appointment_id IS NULL OR a.is_published=TRUE)
     ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC`, [studentNumber]);
  const appointments = await query(
    `SELECT id, schedule_type AS "scheduleType", appointment_date::text AS "appointmentDate", status
     FROM appointments
     WHERE student_number=$1
       AND is_published=TRUE
       AND status IN ('PENDING','COMPLETED','NO_SHOW')
     ORDER BY appointment_date DESC`, [studentNumber]);
  return { ...student.rows[0], examResults: exam.rows, laboratoryResults: laboratory.rows, appointments: appointments.rows };
}

export async function upsertResult(input: {
  studentNumber: string; appointmentId: string | null; resultType: ResultType; resultStatus: string;
  completedAt: string | null; remarks: string | null; actorUserId: string;
}) {
  const table = input.resultType === "PHYSICAL_EXAM" ? "exam_results" : "laboratory_results";
  if (input.appointmentId) {
    const appointment = await query<{ schedule_type: string; student_number: string }>(
      "SELECT schedule_type, student_number FROM appointments WHERE id=$1 AND is_published=TRUE",
      [input.appointmentId],
    );
    if (!appointment.rows[0]) return { error: "APPOINTMENT_NOT_FOUND" as const };
    if (appointment.rows[0].student_number !== input.studentNumber || appointment.rows[0].schedule_type !== input.resultType) return { error: "APPOINTMENT_MISMATCH" as const };
  }
  const result = input.appointmentId
    ? await query(
        `INSERT INTO ${table} (student_number, appointment_id, result_status, completed_at, remarks, encoded_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (appointment_id) DO UPDATE SET result_status=EXCLUDED.result_status,
           completed_at=EXCLUDED.completed_at, remarks=EXCLUDED.remarks, encoded_by=EXCLUDED.encoded_by
         RETURNING id`, [input.studentNumber, input.appointmentId, input.resultStatus, input.completedAt, input.remarks, input.actorUserId])
    : await query(
        `INSERT INTO ${table} (student_number, result_status, completed_at, remarks, encoded_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.studentNumber, input.resultStatus, input.completedAt, input.remarks, input.actorUserId]);
  return { id: result.rows[0].id };
}

export async function complianceReport(filters: {
  clinicCode?: ClinicCode;
  collegeId?: string; programId?: string; priorityGroupId?: string; physicalExamStatus?: string;
  laboratoryStatus?: string; appointmentStatus?: string; appointmentDate?: string; overallStatus?: OverallStatus;
  search?: string; sort?: string; page: number; limit: number; offset: number;
}) {
  return appointmentSummaryReport({
    ...filters,
    sort: parseAppointmentSummarySort(filters.sort),
  });
}

export async function dashboardMetrics(filters: { clinicCode?: ClinicCode } = {}) {
  const clinicWhere = filters.clinicCode ? " AND c.code=$1" : "";
  const values = filters.clinicCode ? [filters.clinicCode] : [];
  const result = await query<{
    total_students: number; pending_appointments: number; completed_exam: number; completed_lab: number;
    no_shows: number; rescheduled: number; over_capacity_dates: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE is_active=TRUE) AS total_students,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='PENDING' AND a.is_published=TRUE${clinicWhere}) AS pending_appointments,
      (SELECT COUNT(*)::int FROM exam_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED' AND a.is_published=TRUE${clinicWhere}) AS completed_exam,
      (SELECT COUNT(*)::int FROM laboratory_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED' AND a.is_published=TRUE${clinicWhere}) AS completed_lab,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='NO_SHOW' AND a.is_published=TRUE${clinicWhere}) AS no_shows,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='RESCHEDULED' AND a.is_published=TRUE${clinicWhere}) AS rescheduled,
      (SELECT COUNT(*)::int FROM (
        SELECT a.clinic_id,a.appointment_date,a.schedule_type FROM appointments a
        JOIN clinics cl ON cl.id=a.clinic_id
        JOIN clinic_capacity_settings c ON c.clinic_id=a.clinic_id AND c.schedule_type=a.schedule_type
        WHERE a.status='PENDING' AND a.is_published=TRUE${filters.clinicCode ? " AND cl.code=$1" : ""}
        GROUP BY a.clinic_id,a.appointment_date,a.schedule_type,c.safe_daily_capacity
        HAVING COUNT(*) > c.safe_daily_capacity
      ) x) AS over_capacity_dates
  `, values);
  const row = result.rows[0];
  return { totalStudents: row.total_students, pendingAppointments: row.pending_appointments, completedPhysicalExams: row.completed_exam, completedLaboratory: row.completed_lab, noShows: row.no_shows, rescheduled: row.rescheduled, overCapacityWarnings: row.over_capacity_dates };
}
