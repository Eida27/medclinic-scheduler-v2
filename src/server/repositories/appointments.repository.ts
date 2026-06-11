import "server-only";
import { query, transaction } from "@/server/db/pool";

export type AppointmentStatus = "DRAFT" | "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
type AppointmentDetail = {
  id: string; batchId: string | null; studentNumber: string; studentName: string; scheduleType: string;
  appointmentDate: string; appointmentTime: string | null; status: AppointmentStatus; isPublished: boolean;
  notes: string | null; rescheduledFrom: string | null; collegeName: string; programName: string;
};
type StatusLog = { id: string; oldStatus: string | null; newStatus: string; notes: string | null; createdAt: Date; changedByName: string | null };

export async function listAppointments(filters: {
  appointmentDate?: string; scheduleType?: string; status?: string; collegeId?: string; programId?: string;
  studentNumber?: string; isPublished?: boolean; page: number; limit: number; offset: number;
}) {
  const clauses = ["1=1"]; const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (filters.appointmentDate) add("a.appointment_date = ?::date", filters.appointmentDate);
  if (filters.scheduleType) add("a.schedule_type = ?", filters.scheduleType);
  if (filters.status) add("a.status = ?", filters.status);
  if (filters.collegeId) add("s.college_id = ?::uuid", filters.collegeId);
  if (filters.programId) add("s.program_id = ?::uuid", filters.programId);
  if (filters.studentNumber) add("a.student_number ILIKE ?", `%${filters.studentNumber}%`);
  if (filters.isPublished !== undefined) add("a.is_published = ?::boolean", filters.isPublished);
  const where = clauses.join(" AND ");
  const count = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM appointments a JOIN students s ON s.student_number=a.student_number WHERE ${where}`, values);
  values.push(filters.limit, filters.offset);
  const result = await query<AppointmentDetail>(
    `SELECT a.id, a.batch_id AS "batchId", a.student_number AS "studentNumber",
            CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName", a.schedule_type AS "scheduleType",
            a.appointment_date::text AS "appointmentDate", a.appointment_time::text AS "appointmentTime",
            a.status, a.is_published AS "isPublished", c.name AS "collegeName", p.name AS "programName"
     FROM appointments a JOIN students s ON s.student_number=a.student_number
     JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id
     WHERE ${where} ORDER BY a.appointment_date, s.last_name, s.first_name
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: result.rows, total: Number(count.rows[0].count) };
}

export async function getAppointment(id: string) {
  const result = await query<AppointmentDetail>(
    `SELECT a.id, a.batch_id AS "batchId", a.student_number AS "studentNumber",
            CONCAT_WS(' ', s.first_name, s.middle_name, s.last_name, s.suffix) AS "studentName",
            a.schedule_type AS "scheduleType", a.appointment_date::text AS "appointmentDate",
            a.appointment_time::text AS "appointmentTime", a.status, a.is_published AS "isPublished",
            a.notes, a.rescheduled_from AS "rescheduledFrom", c.name AS "collegeName", p.name AS "programName"
     FROM appointments a JOIN students s ON s.student_number=a.student_number
     JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id WHERE a.id=$1`, [id]);
  if (!result.rows[0]) return null;
  const logs = await query<StatusLog>(
    `SELECT l.id, l.old_status AS "oldStatus", l.new_status AS "newStatus", l.notes,
            l.created_at AS "createdAt", u.full_name AS "changedByName"
     FROM appointment_status_logs l LEFT JOIN users u ON u.id=l.changed_by
     WHERE l.appointment_id=$1 ORDER BY l.created_at DESC`, [id]);
  return { ...result.rows[0], statusLogs: logs.rows };
}

export async function changeAppointmentStatus(id: string, status: AppointmentStatus, notes: string | null, actorUserId: string) {
  return transaction(async (client) => {
    const current = await client.query<{ status: AppointmentStatus }>("SELECT status FROM appointments WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return null;
    await client.query("UPDATE appointments SET status=$2, notes=COALESCE($3, notes), updated_by=$4 WHERE id=$1", [id, status, notes, actorUserId]);
    await client.query("INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by) VALUES ($1,$2,$3,$4,$5)", [id, current.rows[0].status, status, notes, actorUserId]);
    return { oldStatus: current.rows[0].status };
  });
}

export async function rescheduleAppointment(id: string, appointmentDate: string, appointmentTime: string | null, notes: string | null, actorUserId: string) {
  return transaction(async (client) => {
    const current = await client.query<{
      id: string; batch_id: string | null; schedule_item_id: string | null; student_number: string;
      schedule_type: string; status: AppointmentStatus; is_published: boolean;
    }>("SELECT id,batch_id,schedule_item_id,student_number,schedule_type,status,is_published FROM appointments WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return null;
    const row = current.rows[0];
    await client.query("UPDATE appointments SET status='RESCHEDULED', updated_by=$2 WHERE id=$1", [id, actorUserId]);
    await client.query("INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by) VALUES ($1,$2,'RESCHEDULED',$3,$4)", [id, row.status, notes, actorUserId]);
    const replacement = await client.query<{ id: string }>(
      `INSERT INTO appointments (
        batch_id, student_number, schedule_type, appointment_date, appointment_time,
        status, is_published, notes, rescheduled_from, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9,$9) RETURNING id`,
      [row.batch_id, row.student_number, row.schedule_type, appointmentDate, appointmentTime, row.is_published, notes, id, actorUserId],
    );
    await client.query("INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by) VALUES ($1,NULL,'PENDING',$2,$3)", [replacement.rows[0].id, notes, actorUserId]);
    return replacement.rows[0].id;
  });
}

export async function publishBatch(batchId: string, actorUserId: string) {
  return transaction(async (client) => {
    const batch = await client.query<{ status: string }>("SELECT status FROM schedule_batches WHERE id=$1 FOR UPDATE", [batchId]);
    if (!batch.rows[0]) return null;
    if (batch.rows[0].status !== "GENERATED") return { invalidStatus: batch.rows[0].status };
    const appointments = await client.query("UPDATE appointments SET status='PENDING', is_published=TRUE, updated_by=$2 WHERE batch_id=$1 AND status='DRAFT' RETURNING id", [batchId, actorUserId]);
    for (const appointment of appointments.rows) {
      await client.query("INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, changed_by) VALUES ($1,'DRAFT','PENDING',$2)", [appointment.id, actorUserId]);
    }
    await client.query("UPDATE schedule_batches SET status='PUBLISHED', published_by=$2, published_at=NOW() WHERE id=$1", [batchId, actorUserId]);
    return { count: appointments.rowCount ?? 0 };
  });
}

export async function publicStudentSchedule(studentNumber: string) {
  const student = await query<{ student_number: string; student_name: string }>(
    `SELECT student_number, CONCAT_WS(' ', first_name, last_name) AS student_name
     FROM students WHERE student_number=$1 AND is_active=TRUE`, [studentNumber]);
  if (!student.rows[0]) return null;
  const appointments = await query(
    `SELECT schedule_type AS "scheduleType", appointment_date::text AS "appointmentDate",
            appointment_time::text AS "appointmentTime", status
     FROM appointments WHERE student_number=$1 AND is_published=TRUE
     AND status NOT IN ('RESCHEDULED','CANCELLED') ORDER BY appointment_date`, [studentNumber]);
  const compliance = await query<{
    physical_exam: string; laboratory: string;
  }>(
    `SELECT
      COALESCE((SELECT result_status FROM exam_results WHERE student_number=$1 ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1), 'PENDING') AS physical_exam,
      COALESCE((SELECT result_status FROM laboratory_results WHERE student_number=$1 ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1), 'PENDING') AS laboratory`,
    [studentNumber],
  );
  return {
    studentNumber: student.rows[0].student_number,
    studentName: student.rows[0].student_name,
    appointments: appointments.rows,
    compliance: { physicalExam: compliance.rows[0].physical_exam, laboratory: compliance.rows[0].laboratory },
  };
}

export async function getCapacitySettings() {
  return (await query(
    `SELECT schedule_type AS "scheduleType", safe_daily_capacity AS "safeDailyCapacity",
            max_daily_capacity AS "maxDailyCapacity" FROM clinic_capacity_settings ORDER BY schedule_type`,
  )).rows;
}

export async function updateCapacitySetting(scheduleType: string, safe: number, max: number) {
  return (await query(
    `UPDATE clinic_capacity_settings SET safe_daily_capacity=$2,max_daily_capacity=$3
     WHERE schedule_type=$1 RETURNING schedule_type AS "scheduleType",
     safe_daily_capacity AS "safeDailyCapacity", max_daily_capacity AS "maxDailyCapacity"`, [scheduleType, safe, max],
  )).rows[0] ?? null;
}
