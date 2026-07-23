import "server-only";
import type { PoolClient } from "pg";
import type { AppointmentListSort } from "@/components/appointments/appointment-list-sort";
import { AppError } from "@/lib/errors";
import type { AutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { query, transaction } from "@/server/db/pool";
import type { ClinicCode } from "@/server/clinics";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type AppointmentStatus = "DRAFT" | "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
type AppointmentDetail = {
  id: string; batchId: string | null; studentNumber: string; studentName: string; scheduleType: string;
  clinicId: string; clinicCode: string; clinicName: string;
  appointmentDate: string; status: AppointmentStatus; isPublished: boolean;
  notes: string | null; rescheduledFrom: string | null; collegeName: string; programName: string;
};
type StatusLog = { id: string; oldStatus: string | null; newStatus: string; notes: string | null; createdAt: Date; changedById: string | null; changedByName: string | null };

export type AppointmentMutationContext = {
  id: string;
  batchId: string | null;
  studentNumber: string;
  scheduleType: string;
  status: AppointmentStatus;
  clinicId: string;
  clinicCode: ClinicCode;
  isPublished: boolean;
  schedulePairId: string | null;
  scheduleCycleStart: number;
  isManuallyLocked: boolean;
  lockReason: string | null;
  latestLog: AutomaticNoShowLog | null;
};

type AppointmentMutationContextWithDate = AppointmentMutationContext & {
  appointmentDate: string;
};

const appointmentListOrderBy: Record<AppointmentListSort, string> = {
  soonest: "a.appointment_date ASC, s.last_name ASC, s.first_name ASC, a.student_number ASC, a.id ASC",
  latest: "a.appointment_date DESC, s.last_name ASC, s.first_name ASC, a.student_number ASC, a.id ASC",
  surname_asc: "s.last_name ASC, s.first_name ASC, a.appointment_date ASC, a.student_number ASC, a.id ASC",
  surname_desc: "s.last_name DESC, s.first_name ASC, a.appointment_date ASC, a.student_number ASC, a.id ASC",
};

export async function listAppointments(filters: {
  clinicCode?: ClinicCode; appointmentDate?: string; scheduleType?: string; status?: string; collegeId?: string; programId?: string;
  studentNumber?: string; isPublished?: true; sort?: AppointmentListSort; page: number; limit: number; offset: number;
}) {
  const clauses = ["a.is_published=TRUE"]; const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replaceAll("?", `$${values.length}`)); };
  if (filters.appointmentDate) add("a.appointment_date = ?::date", filters.appointmentDate);
  if (filters.clinicCode) add("cl.code = ?", filters.clinicCode);
  if (filters.scheduleType) add("a.schedule_type = ?", filters.scheduleType);
  if (filters.status) add("a.status = ?", filters.status);
  if (filters.collegeId) add("s.college_id = ?::uuid", filters.collegeId);
  if (filters.programId) add("s.program_id = ?::uuid", filters.programId);
  if (filters.studentNumber) {
    add(
      `(a.student_number ILIKE ?
        OR ${studentDisplayNameSql("s")} ILIKE ?
        OR CONCAT_WS(' ', BTRIM(s.first_name), BTRIM(s.last_name)) ILIKE ?
        OR CONCAT_WS(
          ' ', BTRIM(s.first_name), NULLIF(BTRIM(s.middle_name), ''),
          BTRIM(s.last_name), NULLIF(BTRIM(s.suffix), '')
        ) ILIKE ?)`,
      `%${filters.studentNumber}%`,
    );
  }
  const where = clauses.join(" AND ");
  const orderBy = appointmentListOrderBy[filters.sort ?? "soonest"];
  const count = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointments a
      JOIN clinics cl ON cl.id=a.clinic_id
      JOIN students s ON s.student_number=a.student_number WHERE ${where}`,
    values,
  );
  values.push(filters.limit, filters.offset);
  const result = await query<AppointmentDetail>(
    `SELECT a.id, a.batch_id AS "batchId", a.student_number AS "studentNumber",
            ${studentDisplayNameSql("s")} AS "studentName", a.schedule_type AS "scheduleType",
            a.clinic_id AS "clinicId", cl.code AS "clinicCode", cl.name AS "clinicName",
            a.appointment_date::text AS "appointmentDate",
            a.status, a.is_published AS "isPublished", c.name AS "collegeName", p.name AS "programName"
     FROM appointments a JOIN students s ON s.student_number=a.student_number
     JOIN clinics cl ON cl.id=a.clinic_id
     JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id
     WHERE ${where} ORDER BY ${orderBy}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: result.rows, total: Number(count.rows[0].count) };
}

export async function getPublishedAppointment(id: string) {
  const result = await query<AppointmentDetail>(
    `SELECT a.id, a.batch_id AS "batchId", a.student_number AS "studentNumber",
            ${studentDisplayNameSql("s")} AS "studentName",
            a.schedule_type AS "scheduleType", a.appointment_date::text AS "appointmentDate",
            a.clinic_id AS "clinicId", cl.code AS "clinicCode", cl.name AS "clinicName",
            a.status, a.is_published AS "isPublished",
            a.notes, a.rescheduled_from AS "rescheduledFrom", c.name AS "collegeName", p.name AS "programName",
            a.is_manually_locked AS "isManuallyLocked", a.lock_reason AS "lockReason"
     FROM appointments a JOIN students s ON s.student_number=a.student_number
     JOIN clinics cl ON cl.id=a.clinic_id
     JOIN colleges c ON c.id=s.college_id JOIN programs p ON p.id=s.program_id
     WHERE a.id=$1 AND a.is_published=TRUE`, [id]);
  if (!result.rows[0]) return null;
  const logs = await query<StatusLog>(
    `SELECT l.id, l.old_status AS "oldStatus", l.new_status AS "newStatus", l.notes,
            l.created_at AS "createdAt", l.changed_by AS "changedById",
            u.full_name AS "changedByName"
     FROM appointment_status_logs l LEFT JOIN users u ON u.id=l.changed_by
     WHERE l.appointment_id=$1 ORDER BY l.created_at DESC, l.id DESC`, [id]);
  return { ...result.rows[0], statusLogs: logs.rows };
}

export async function getAppointmentMutationContext(id: string, client: PoolClient) {
  const result = await client.query<{
    id: string;
    batchId: string | null;
    studentNumber: string;
    scheduleType: string;
    appointmentDate: string;
    status: AppointmentStatus;
    clinicId: string;
    clinicCode: ClinicCode;
    isPublished: boolean;
    latestOldStatus: string | null;
    latestNewStatus: string | null;
    latestNotes: string | null;
    latestChangedById: string | null;
    schedulePairId: string | null;
    scheduleCycleStart: number;
    isManuallyLocked: boolean;
    lockReason: string | null;
  }>(
    `SELECT appointment.id, appointment.batch_id AS "batchId",
            appointment.student_number AS "studentNumber",
            appointment.schedule_type AS "scheduleType",
            appointment.appointment_date::text AS "appointmentDate", appointment.status,
            appointment.clinic_id AS "clinicId", clinic.code AS "clinicCode",
            appointment.is_published AS "isPublished",
            appointment.schedule_pair_id::text AS "schedulePairId",
            appointment.schedule_cycle_start AS "scheduleCycleStart",
            appointment.is_manually_locked AS "isManuallyLocked",
            appointment.lock_reason AS "lockReason",
            latest.old_status AS "latestOldStatus",
            latest.new_status AS "latestNewStatus",
            latest.notes AS "latestNotes",
            latest.changed_by AS "latestChangedById"
       FROM appointments appointment
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
       LEFT JOIN LATERAL (
         SELECT old_status, new_status, notes, changed_by
           FROM appointment_status_logs
          WHERE appointment_id=appointment.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE appointment.id=$1 AND appointment.is_published=TRUE
      FOR UPDATE OF appointment`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batchId,
    studentNumber: row.studentNumber,
    scheduleType: row.scheduleType,
    appointmentDate: row.appointmentDate,
    status: row.status,
    clinicId: row.clinicId,
    clinicCode: row.clinicCode,
    isPublished: row.isPublished,
    schedulePairId: row.schedulePairId,
    scheduleCycleStart: row.scheduleCycleStart,
    isManuallyLocked: row.isManuallyLocked,
    lockReason: row.lockReason,
    latestLog: row.latestNewStatus ? {
      oldStatus: row.latestOldStatus,
      newStatus: row.latestNewStatus,
      notes: row.latestNotes,
      changedById: row.latestChangedById,
    } : null,
  } satisfies AppointmentMutationContextWithDate;
}

export async function changeAppointmentStatusWithClient(
  client: PoolClient,
  id: string,
  expectedOldStatus: AppointmentStatus,
  newStatus: AppointmentStatus,
  notes: string | null,
  actorUserId: string,
) {
  const changed = await client.query(
    `UPDATE appointments
        SET status=$3, notes=COALESCE($4, notes), updated_by=$5
      WHERE id=$1 AND status=$2 AND is_published=TRUE
      RETURNING id`,
    [id, expectedOldStatus, newStatus, notes, actorUserId],
  );
  if (!changed.rowCount) {
    throw new AppError("APPOINTMENT_STATUS_CONFLICT", "The appointment status changed. Refresh and try again.", 409);
  }
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     ) VALUES ($1,$2,$3,$4,$5)`,
    [id, expectedOldStatus, newStatus, notes, actorUserId],
  );
}

export async function setAppointmentManualLockWithClient(
  client: PoolClient,
  appointmentId: string,
  locked: boolean,
  actorUserId: string,
  reason: string | null,
) {
  const result = await client.query(
    `UPDATE appointments
        SET is_manually_locked=$2,
            locked_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            locked_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
            lock_reason=CASE WHEN $2 THEN $4 ELSE NULL END,
            updated_by=$3
      WHERE id=$1 AND is_published=TRUE
      RETURNING id`,
    [appointmentId, locked, actorUserId, reason],
  );
  return Boolean(result.rowCount);
}

export async function rescheduleAppointmentWithClient(
  client: PoolClient,
  appointment: AppointmentMutationContext,
  appointmentDate: string,
  notes: string | null,
  actorUserId: string,
) {
  await lockEffectiveAppointmentScopes(client, [appointment]);
  const changed = await client.query(
    `UPDATE appointments
        SET status='RESCHEDULED', updated_by=$3
      WHERE id=$1 AND status=$2 AND is_published=TRUE
      RETURNING id`,
    [appointment.id, appointment.status, actorUserId],
  );
  if (!changed.rowCount) {
    throw new AppError("APPOINTMENT_STATUS_CONFLICT", "The appointment status changed. Refresh and try again.", 409);
  }
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     ) VALUES ($1,$2,'RESCHEDULED',$3,$4)`,
    [appointment.id, appointment.status, notes, actorUserId],
  );
  const replacement = await client.query<{ id: string }>(
    `INSERT INTO appointments (
      batch_id, clinic_id, student_number, schedule_type, appointment_date,
      status, is_published, notes, rescheduled_from, created_by, updated_by,
      schedule_pair_id, schedule_cycle_start
    ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9,$9,$10,$11) RETURNING id`,
    [
      appointment.batchId,
      appointment.clinicId,
      appointment.studentNumber,
      appointment.scheduleType,
      appointmentDate,
      appointment.isPublished,
      notes,
      appointment.id,
      actorUserId,
      appointment.schedulePairId,
      appointment.scheduleCycleStart,
    ],
  );
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     ) VALUES ($1,NULL,'PENDING',$2,$3)`,
    [replacement.rows[0].id, notes, actorUserId],
  );
  return replacement.rows[0].id;
}

export async function publishBatch(batchId: string, actorUserId: string, client?: PoolClient) {
  const publish = async (transactionClient: PoolClient) => {
    const batch = await transactionClient.query<{ status: string }>("SELECT status FROM schedule_batches WHERE id=$1 FOR UPDATE", [batchId]);
    if (!batch.rows[0]) return null;
    if (batch.rows[0].status !== "GENERATED") return { invalidStatus: batch.rows[0].status };
    const draftScopes = await transactionClient.query<{
      studentNumber: string;
      scheduleType: string;
    }>(
      `SELECT student_number AS "studentNumber", schedule_type AS "scheduleType"
         FROM appointments
        WHERE batch_id=$1 AND status='DRAFT'`,
      [batchId],
    );
    await lockEffectiveAppointmentScopes(transactionClient, draftScopes.rows);
    const appointments = await transactionClient.query("UPDATE appointments SET status='PENDING', is_published=TRUE, updated_by=$2 WHERE batch_id=$1 AND status='DRAFT' RETURNING id", [batchId, actorUserId]);
    for (const appointment of appointments.rows) {
      await transactionClient.query("INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, changed_by) VALUES ($1,'DRAFT','PENDING',$2)", [appointment.id, actorUserId]);
    }
    await transactionClient.query("UPDATE schedule_batches SET status='PUBLISHED', published_by=$2, published_at=NOW() WHERE id=$1", [batchId, actorUserId]);
    return { count: appointments.rowCount ?? 0 };
  };
  if (client) return publish(client);
  return transaction(publish);
}

export async function publicStudentSchedule(studentNumber: string) {
  const student = await query<{ student_number: string; student_name: string }>(
    `SELECT s.student_number, ${studentDisplayNameSql("s")} AS student_name
     FROM students s WHERE s.student_number=$1 AND s.is_active=TRUE`, [studentNumber]);
  if (!student.rows[0]) return null;
  const appointments = await query(
    `SELECT schedule_type AS "scheduleType", appointment_date::text AS "appointmentDate", status
     FROM appointments WHERE student_number=$1 AND is_published=TRUE
     AND status NOT IN ('RESCHEDULED','CANCELLED') ORDER BY appointment_date`, [studentNumber]);
  const compliance = await query<{
    physical_exam: string; laboratory: string;
  }>(
    `SELECT
      COALESCE((
        SELECT result.result_status
          FROM exam_results result
          LEFT JOIN appointments appointment ON appointment.id=result.appointment_id
         WHERE result.student_number=$1
           AND (result.appointment_id IS NULL OR appointment.is_published=TRUE)
         ORDER BY result.completed_at DESC NULLS LAST, result.created_at DESC LIMIT 1
      ), 'PENDING_UPLOAD') AS physical_exam,
      COALESCE((
        SELECT result.result_status
          FROM laboratory_results result
          LEFT JOIN appointments appointment ON appointment.id=result.appointment_id
         WHERE result.student_number=$1
           AND (result.appointment_id IS NULL OR appointment.is_published=TRUE)
         ORDER BY result.completed_at DESC NULLS LAST, result.created_at DESC LIMIT 1
      ), 'PENDING_UPLOAD') AS laboratory`,
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
    `SELECT s.schedule_type AS "scheduleType", c.code AS "clinicCode", c.name AS "clinicName",
            s.max_daily_capacity AS "maxDailyCapacity"
       FROM clinic_capacity_settings s JOIN clinics c ON c.id=s.clinic_id
      ORDER BY c.code, s.schedule_type`,
  )).rows;
}

export async function updateCapacitySetting(clinicCode: string, scheduleType: string, max: number) {
  return (await query(
    `UPDATE clinic_capacity_settings SET safe_daily_capacity=$3, max_daily_capacity=$3
     WHERE clinic_id=(SELECT id FROM clinics WHERE code=$1) AND schedule_type=$2
     RETURNING schedule_type AS "scheduleType",
     max_daily_capacity AS "maxDailyCapacity"`, [clinicCode, scheduleType, max],
  )).rows[0] ?? null;
}
