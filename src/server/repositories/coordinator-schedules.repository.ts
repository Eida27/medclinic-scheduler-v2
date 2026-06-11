import "server-only";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/db/pool";
import type { DraftAppointment } from "@/server/rule-engine/types";

export type ScheduleItemCreate = {
  studentNumber: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
  priorityGroupId: string;
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
  remarks: string | null;
};

export type BatchCreate = {
  batchName: string;
  collegeId: string | null;
  programId: string | null;
  submittedByName: string | null;
  description: string | null;
  items: ScheduleItemCreate[];
};

export type ValidationIssue = {
  code: string;
  message: string;
  severity: "WARNING" | "CONFLICT";
  date?: string;
  scheduleType?: string;
};

export type RuleItemRow = {
  id: string;
  studentNumber: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
  priorityGroupId: string;
  priorityRank: number;
  priorityActive: boolean;
  studentActive: boolean;
  studentCollegeId: string;
  studentProgramId: string;
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
};

export async function createScheduleBatch(input: BatchCreate, actorUserId: string) {
  return transaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO schedule_batches (
        batch_name, college_id, program_id, submitted_by_name, description, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.batchName, input.collegeId, input.programId, input.submittedByName, input.description, actorUserId],
    );
    for (const item of input.items) {
      await client.query(
        `INSERT INTO coordinator_schedule_items (
          batch_id, student_number, schedule_type, priority_group_id,
          target_date, target_week_start, target_week_end, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batch.rows[0].id, item.studentNumber, item.scheduleType, item.priorityGroupId, item.targetDate, item.targetWeekStart, item.targetWeekEnd, item.remarks],
      );
    }
    return batch.rows[0].id;
  });
}

export async function listScheduleBatches() {
  const result = await query<{
    id: string; batch_name: string; status: string; college_name: string | null; program_name: string | null;
    submitted_by_name: string | null; created_at: Date; item_count: number; conflict_count: number; warning_count: number;
  }>(
    `SELECT b.id, b.batch_name, b.status, c.name AS college_name, p.name AS program_name,
            b.submitted_by_name, b.created_at,
            COUNT(i.id)::int AS item_count,
            COUNT(*) FILTER (WHERE i.status = 'CONFLICT')::int AS conflict_count,
            COUNT(*) FILTER (WHERE i.status = 'WARNING')::int AS warning_count
     FROM schedule_batches b
     LEFT JOIN colleges c ON c.id = b.college_id
     LEFT JOIN programs p ON p.id = b.program_id
     LEFT JOIN coordinator_schedule_items i ON i.batch_id = b.id
     GROUP BY b.id, c.name, p.name
     ORDER BY b.created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id, batchName: row.batch_name, status: row.status, collegeName: row.college_name,
    programName: row.program_name, submittedByName: row.submitted_by_name,
    createdAt: row.created_at.toISOString(), itemCount: row.item_count,
    conflictCount: row.conflict_count, warningCount: row.warning_count,
  }));
}

export async function getScheduleBatch(batchId: string, client?: PoolClient) {
  const sql = `SELECT b.id, b.batch_name AS "batchName", b.college_id AS "collegeId", c.name AS "collegeName",
                      b.program_id AS "programId", p.name AS "programName", b.submitted_by_name AS "submittedByName",
                      b.description, b.status, b.validation_summary AS "validationSummary", b.override_reason AS "overrideReason",
                      b.published_at AS "publishedAt", b.created_at AS "createdAt"
               FROM schedule_batches b
               LEFT JOIN colleges c ON c.id=b.college_id LEFT JOIN programs p ON p.id=b.program_id
               WHERE b.id=$1`;
  const result = client ? await client.query(sql, [batchId]) : await query(sql, [batchId]);
  if (!result.rows[0]) return null;
  const items = client
    ? await client.query(
        `SELECT i.id, i.student_number AS "studentNumber", CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName",
                i.schedule_type AS "scheduleType", i.priority_group_id AS "priorityGroupId", pg.name AS "priorityGroupName",
                i.target_date::text AS "targetDate", i.target_week_start::text AS "targetWeekStart", i.target_week_end::text AS "targetWeekEnd",
                i.remarks, i.status, i.validation_issues AS "validationIssues"
         FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
         JOIN priority_groups pg ON pg.id=i.priority_group_id WHERE i.batch_id=$1
         ORDER BY pg.rank_order, i.student_number`, [batchId])
    : await query(
        `SELECT i.id, i.student_number AS "studentNumber", CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName",
                i.schedule_type AS "scheduleType", i.priority_group_id AS "priorityGroupId", pg.name AS "priorityGroupName",
                i.target_date::text AS "targetDate", i.target_week_start::text AS "targetWeekStart", i.target_week_end::text AS "targetWeekEnd",
                i.remarks, i.status, i.validation_issues AS "validationIssues"
         FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
         JOIN priority_groups pg ON pg.id=i.priority_group_id WHERE i.batch_id=$1
         ORDER BY pg.rank_order, i.student_number`, [batchId]);
  return { ...result.rows[0], items: items.rows };
}

export async function getRuleItems(batchId: string) {
  const batch = await query<{
    id: string; status: string; college_id: string | null; program_id: string | null;
  }>("SELECT id, status, college_id, program_id FROM schedule_batches WHERE id=$1", [batchId]);
  if (!batch.rows[0]) return null;
  const items = await query<{
    id: string; student_number: string; schedule_type: RuleItemRow["scheduleType"]; priority_group_id: string;
    priority_rank: number; priority_active: boolean; student_active: boolean; student_college_id: string;
    student_program_id: string; target_date: string | null; target_week_start: string | null; target_week_end: string | null;
  }>(
    `SELECT i.id, i.student_number, i.schedule_type, i.priority_group_id, pg.rank_order AS priority_rank,
            pg.is_active AS priority_active, s.is_active AS student_active,
            s.college_id AS student_college_id, s.program_id AS student_program_id,
            i.target_date::text, i.target_week_start::text, i.target_week_end::text
     FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
     JOIN priority_groups pg ON pg.id=i.priority_group_id WHERE i.batch_id=$1`,
    [batchId],
  );
  return {
    id: batch.rows[0].id,
    status: batch.rows[0].status,
    collegeId: batch.rows[0].college_id,
    programId: batch.rows[0].program_id,
    items: items.rows.map((row) => ({
      id: row.id, studentNumber: row.student_number, scheduleType: row.schedule_type,
      priorityGroupId: row.priority_group_id, priorityRank: row.priority_rank,
      priorityActive: row.priority_active, studentActive: row.student_active,
      studentCollegeId: row.student_college_id, studentProgramId: row.student_program_id,
      targetDate: row.target_date, targetWeekStart: row.target_week_start, targetWeekEnd: row.target_week_end,
    } satisfies RuleItemRow)),
  };
}

export async function activeAppointmentKeys(studentNumbers: string[]) {
  if (studentNumbers.length === 0) return new Set<string>();
  const result = await query<{ student_number: string; schedule_type: string }>(
    `SELECT student_number, schedule_type FROM appointments
     WHERE student_number = ANY($1::varchar[]) AND status IN ('DRAFT','PENDING')`,
    [studentNumbers],
  );
  return new Set(result.rows.map((row) => `${row.student_number}:${row.schedule_type}`));
}

export async function currentAppointmentLoad() {
  const result = await query<{ date: string; schedule_type: "PHYSICAL_EXAM" | "LABORATORY"; count: number }>(
    `SELECT appointment_date::text AS date, schedule_type, COUNT(*)::int AS count
     FROM appointments WHERE status IN ('DRAFT','PENDING') GROUP BY appointment_date, schedule_type`,
  );
  return result.rows.map((row) => ({ date: row.date, scheduleType: row.schedule_type, count: row.count }));
}

export async function capacitySettings() {
  const result = await query<{ schedule_type: "PHYSICAL_EXAM" | "LABORATORY"; safe_daily_capacity: number; max_daily_capacity: number }>(
    "SELECT schedule_type, safe_daily_capacity, max_daily_capacity FROM clinic_capacity_settings WHERE is_active=TRUE",
  );
  return result.rows.map((row) => ({ scheduleType: row.schedule_type, safeDailyCapacity: row.safe_daily_capacity, maxDailyCapacity: row.max_daily_capacity }));
}

export async function saveValidation(
  batchId: string,
  actorUserId: string,
  summary: Record<string, unknown>,
  items: Array<{ id: string; status: string; issues: ValidationIssue[] }>,
) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE schedule_batches SET status='VALIDATED', validation_summary=$2::jsonb,
       validated_by=$3, validated_at=NOW() WHERE id=$1`,
      [batchId, JSON.stringify(summary), actorUserId],
    );
    for (const item of items) {
      await client.query(
        "UPDATE coordinator_schedule_items SET status=$2, validation_issues=$3::jsonb WHERE id=$1",
        [item.id, item.status, JSON.stringify(item.issues)],
      );
    }
  });
}

export async function persistGeneratedAppointments(
  batchId: string,
  actorUserId: string,
  appointments: DraftAppointment[],
  unscheduledItemIds: string[],
  overrideReason?: string,
) {
  return transaction(async (client) => {
    const locked = await client.query<{ status: string }>("SELECT status FROM schedule_batches WHERE id=$1 FOR UPDATE", [batchId]);
    if (locked.rows[0]?.status !== "VALIDATED") throw new Error("BATCH_NOT_VALIDATED");
    const existing = await client.query("SELECT 1 FROM appointments WHERE batch_id=$1 LIMIT 1", [batchId]);
    if (existing.rowCount) throw new Error("BATCH_ALREADY_GENERATED");
    for (const appointment of appointments) {
      await client.query(
        `INSERT INTO appointments (
          batch_id, schedule_item_id, student_number, schedule_type, appointment_date,
          status, is_published, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,'DRAFT',FALSE,$6,$6)`,
        [batchId, appointment.scheduleItemId, appointment.studentNumber, appointment.scheduleType, appointment.appointmentDate, actorUserId],
      );
    }
    await client.query(
      `UPDATE coordinator_schedule_items SET status='SCHEDULED'
       WHERE batch_id=$1 AND id = ANY($2::uuid[])`,
      [batchId, [...new Set(appointments.map((appointment) => appointment.scheduleItemId))]],
    );
    if (unscheduledItemIds.length) {
      await client.query("UPDATE coordinator_schedule_items SET status='UNSCHEDULED' WHERE id = ANY($1::uuid[])", [unscheduledItemIds]);
    }
    await client.query(
      `UPDATE schedule_batches SET status='GENERATED', override_reason=$2,
       overridden_by=CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END,
       overridden_at=CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END
       WHERE id=$1`,
      [batchId, overrideReason ?? null, actorUserId],
    );
    return getScheduleBatch(batchId, client);
  });
}

export async function updateBatchMetadata(batchId: string, input: Omit<BatchCreate, "items">) {
  const result = await query(
    `UPDATE schedule_batches SET batch_name=$2, college_id=$3, program_id=$4,
      submitted_by_name=$5, description=$6, status='DRAFT', validation_summary=NULL,
      validated_by=NULL, validated_at=NULL
     WHERE id=$1 AND status IN ('DRAFT','VALIDATED') RETURNING id`,
    [batchId, input.batchName, input.collegeId, input.programId, input.submittedByName, input.description],
  );
  return Boolean(result.rowCount);
}
