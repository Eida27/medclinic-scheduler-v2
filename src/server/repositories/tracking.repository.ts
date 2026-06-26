import "server-only";
import { query } from "@/server/db/pool";
import type { ClinicCode } from "@/server/clinics";

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
     WHERE r.student_number=$1 ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC`, [studentNumber]);
  const laboratory = await query(
    `SELECT r.id, r.appointment_id AS "appointmentId", r.result_status AS "resultStatus",
            r.completed_at::text AS "completedAt", r.remarks, r.created_at AS "createdAt",
            a.appointment_date::text AS "appointmentDate"
     FROM laboratory_results r LEFT JOIN appointments a ON a.id=r.appointment_id
     WHERE r.student_number=$1 ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC`, [studentNumber]);
  const appointments = await query(
    `SELECT id, schedule_type AS "scheduleType", appointment_date::text AS "appointmentDate", status
     FROM appointments WHERE student_number=$1 AND status IN ('PENDING','COMPLETED','NO_SHOW') ORDER BY appointment_date DESC`, [studentNumber]);
  return { ...student.rows[0], examResults: exam.rows, laboratoryResults: laboratory.rows, appointments: appointments.rows };
}

export async function upsertResult(input: {
  studentNumber: string; appointmentId: string | null; resultType: ResultType; resultStatus: string;
  completedAt: string | null; remarks: string | null; actorUserId: string;
}) {
  const table = input.resultType === "PHYSICAL_EXAM" ? "exam_results" : "laboratory_results";
  if (input.appointmentId) {
    const appointment = await query<{ schedule_type: string; student_number: string }>("SELECT schedule_type, student_number FROM appointments WHERE id=$1", [input.appointmentId]);
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
  laboratoryStatus?: string; appointmentStatus?: string; search?: string; page: number; limit: number; offset: number;
}) {
  const clauses = ["s.is_active=TRUE"]; const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (filters.collegeId) add("s.college_id=?::uuid", filters.collegeId);
  if (filters.clinicCode) add("latest_appointment.clinic_code=?", filters.clinicCode);
  if (filters.programId) add("s.program_id=?::uuid", filters.programId);
  if (filters.priorityGroupId) add("latest_item.priority_group_id=?::uuid", filters.priorityGroupId);
  if (filters.physicalExamStatus) add("COALESCE(exam.result_status,'PENDING')=?", filters.physicalExamStatus);
  if (filters.laboratoryStatus) add("COALESCE(lab.result_status,'PENDING')=?", filters.laboratoryStatus);
  if (filters.appointmentStatus) add("latest_appointment.status=?", filters.appointmentStatus);
  if (filters.search) {
    values.push(`%${filters.search}%`);
    clauses.push(`(s.student_number ILIKE $${values.length} OR CONCAT_WS(' ',s.first_name,s.last_name) ILIKE $${values.length})`);
  }
  const where = clauses.join(" AND ");
  const joins = `
    LEFT JOIN LATERAL (SELECT result_status FROM exam_results WHERE student_number=s.student_number ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1) exam ON TRUE
    LEFT JOIN LATERAL (SELECT result_status FROM laboratory_results WHERE student_number=s.student_number ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1) lab ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.status, c.code AS clinic_code
        FROM appointments a JOIN clinics c ON c.id=a.clinic_id
       WHERE a.student_number=s.student_number AND a.status NOT IN ('RESCHEDULED','CANCELLED')
       ORDER BY a.appointment_date DESC, a.created_at DESC LIMIT 1
    ) latest_appointment ON TRUE
    LEFT JOIN LATERAL (SELECT priority_group_id FROM coordinator_schedule_items WHERE student_number=s.student_number ORDER BY created_at DESC LIMIT 1) latest_item ON TRUE`;
  const count = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM students s ${joins} WHERE ${where}`, values);
  values.push(filters.limit, filters.offset);
  const items = await query(
    `SELECT s.student_number AS "studentNumber", CONCAT_WS(' ',s.first_name,s.last_name) AS "studentName",
            c.name AS "collegeName", p.name AS "programName", COALESCE(latest_appointment.status,'UNSCHEDULED') AS "appointmentStatus",
            COALESCE(exam.result_status,'PENDING') AS "physicalExamStatus", COALESCE(lab.result_status,'PENDING') AS "laboratoryStatus"
     FROM students s JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id ${joins}
     WHERE ${where} ORDER BY s.last_name,s.first_name LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const summary = await query<{
    total: number; physical_completed: number; laboratory_completed: number; pending_any: number;
  }>(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(exam.result_status,'PENDING')='COMPLETED')::int AS physical_completed,
      COUNT(*) FILTER (WHERE COALESCE(lab.result_status,'PENDING')='COMPLETED')::int AS laboratory_completed,
      COUNT(*) FILTER (WHERE COALESCE(exam.result_status,'PENDING')<>'COMPLETED' OR COALESCE(lab.result_status,'PENDING')<>'COMPLETED')::int AS pending_any
     FROM students s ${joins} WHERE ${where}`, values.slice(0, -2));
  return { items: items.rows, total: Number(count.rows[0].count), summary: { totalStudents: summary.rows[0].total, physicalCompleted: summary.rows[0].physical_completed, laboratoryCompleted: summary.rows[0].laboratory_completed, pendingAny: summary.rows[0].pending_any } };
}

export async function dashboardMetrics(filters: { clinicCode?: ClinicCode } = {}) {
  const clinicWhere = filters.clinicCode ? " AND c.code=$1" : "";
  const values = filters.clinicCode ? [filters.clinicCode] : [];
  const result = await query<{
    total_students: number; pending_appointments: number; completed_exam: number; completed_lab: number;
    no_shows: number; rescheduled: number; unpublished_batches: number; over_capacity_dates: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE is_active=TRUE) AS total_students,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='PENDING'${clinicWhere}) AS pending_appointments,
      (SELECT COUNT(*)::int FROM exam_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED'${clinicWhere}) AS completed_exam,
      (SELECT COUNT(*)::int FROM laboratory_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED'${clinicWhere}) AS completed_lab,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='NO_SHOW'${clinicWhere}) AS no_shows,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='RESCHEDULED'${clinicWhere}) AS rescheduled,
      (SELECT COUNT(*)::int FROM schedule_batches b JOIN clinics c ON c.id=b.clinic_id WHERE b.status IN ('DRAFT','VALIDATED','GENERATED')${clinicWhere}) AS unpublished_batches,
      (SELECT COUNT(*)::int FROM (
        SELECT a.clinic_id,a.appointment_date,a.schedule_type FROM appointments a
        JOIN clinics cl ON cl.id=a.clinic_id
        JOIN clinic_capacity_settings c ON c.clinic_id=a.clinic_id AND c.schedule_type=a.schedule_type
        WHERE a.status IN ('DRAFT','PENDING')${filters.clinicCode ? " AND cl.code=$1" : ""}
        GROUP BY a.clinic_id,a.appointment_date,a.schedule_type,c.safe_daily_capacity
        HAVING COUNT(*) > c.safe_daily_capacity
      ) x) AS over_capacity_dates
  `, values);
  const row = result.rows[0];
  return { totalStudents: row.total_students, pendingAppointments: row.pending_appointments, completedPhysicalExams: row.completed_exam, completedLaboratory: row.completed_lab, noShows: row.no_shows, rescheduled: row.rescheduled, unpublishedBatches: row.unpublished_batches, overCapacityWarnings: row.over_capacity_dates };
}
