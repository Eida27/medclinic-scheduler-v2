import "server-only";
import type { PoolClient } from "pg";
import { writeAudit } from "@/server/repositories/audit.repository";
import { query, transaction } from "@/server/db/pool";
import type { DraftAppointment } from "@/server/rule-engine/types";
import {
  clinicCodeByScheduleType,
  clinicConfigForCode,
  type AppointmentScheduleType,
  type ClinicCode,
} from "@/server/clinics";

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
  clinicCode?: ClinicCode | null;
  batchName: string;
  collegeId: string | null;
  programId: string | null;
  submittedByName: string | null;
  description: string | null;
  items: ScheduleItemCreate[];
};

export type CsvImportScheduleRow = {
  rowNumber: number;
  studentNumber: string;
  fullName: string;
  firstName: string;
  lastName: string;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  targetDate: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
};

export type CsvImportBatchCreate = {
  clinicCode?: ClinicCode | null;
  batchName: string;
  priorityGroupId: string;
  submittedByName: string | null;
  description: string | null;
  fileName: string;
  rows: CsvImportScheduleRow[];
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
  clinicId: string;
  studentNumber: string;
  scheduleType: AppointmentScheduleType;
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

type StoredScheduleItemCreate = Omit<ScheduleItemCreate, "scheduleType"> & {
  clinicCode: ClinicCode;
  scheduleType: AppointmentScheduleType;
};

type ClinicBatchCreate = Omit<BatchCreate, "clinicCode" | "items"> & {
  clinicCode: ClinicCode;
  batchName: string;
  items: StoredScheduleItemCreate[];
};

const clinicOrder: ClinicCode[] = ["CPU_CLINIC", "KABALAKA_CLINIC"];

function servicesFor(scheduleType: ScheduleItemCreate["scheduleType"]): AppointmentScheduleType[] {
  return scheduleType === "BOTH" ? ["PHYSICAL_EXAM", "LABORATORY"] : [scheduleType];
}

function expandItemsForClinic(items: ScheduleItemCreate[], clinicCode?: ClinicCode | null): StoredScheduleItemCreate[] {
  return items.flatMap((item) => servicesFor(item.scheduleType).flatMap((scheduleType) => {
    const itemClinicCode = clinicCodeByScheduleType[scheduleType];
    if (clinicCode && itemClinicCode !== clinicCode) return [];
    return [{ ...item, clinicCode: itemClinicCode, scheduleType }];
  }));
}

function splitByClinic(input: BatchCreate): ClinicBatchCreate[] {
  const expanded = expandItemsForClinic(input.items, input.clinicCode);
  const grouped = new Map<ClinicCode, StoredScheduleItemCreate[]>();
  for (const item of expanded) grouped.set(item.clinicCode, [...(grouped.get(item.clinicCode) ?? []), item]);
  const groupCount = grouped.size;
  return clinicOrder.flatMap((clinicCode) => {
    const items = grouped.get(clinicCode);
    if (!items?.length) return [];
    const clinic = clinicConfigForCode(clinicCode);
    return [{
      batchName: groupCount > 1 ? `${input.batchName} - ${clinic.name}` : input.batchName,
      collegeId: input.collegeId,
      programId: input.programId,
      submittedByName: input.submittedByName,
      description: input.description,
      clinicCode,
      items,
    }];
  });
}

async function insertClinicBatch(client: PoolClient, input: ClinicBatchCreate, actorUserId: string) {
  const batch = await client.query<{ id: string }>(
    `INSERT INTO schedule_batches (
      clinic_id, batch_name, college_id, program_id, submitted_by_name, description, created_by
    ) VALUES ((SELECT id FROM clinics WHERE code=$1),$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.clinicCode, input.batchName, input.collegeId, input.programId, input.submittedByName, input.description, actorUserId],
  );
  for (const item of input.items) {
    await client.query(
      `INSERT INTO coordinator_schedule_items (
        batch_id, clinic_id, student_number, schedule_type, priority_group_id,
        target_date, target_week_start, target_week_end, remarks
      ) VALUES ($1,(SELECT id FROM clinics WHERE code=$2),$3,$4,$5,$6,$7,$8,$9)`,
      [
        batch.rows[0].id,
        item.clinicCode,
        item.studentNumber,
        item.scheduleType,
        item.priorityGroupId,
        item.targetDate,
        item.targetWeekStart,
        item.targetWeekEnd,
        item.remarks,
      ],
    );
  }
  return batch.rows[0].id;
}

export async function createScheduleBatch(input: BatchCreate, actorUserId: string) {
  return transaction(async (client) => {
    const batches = splitByClinic(input);
    if (!batches.length) throw new Error("NO_MATCHING_CLINIC_ITEMS");
    const batchIds: string[] = [];
    for (const batch of batches) batchIds.push(await insertClinicBatch(client, batch, actorUserId));
    return { id: batchIds[0], batchIds, itemCount: batches.reduce((sum, batch) => sum + batch.items.length, 0) };
  });
}

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function addImportError(fields: Record<string, string[]>, field: string, message: string) {
  fields[field] = [...(fields[field] ?? []), message];
}

export async function createImportedScheduleBatch(input: CsvImportBatchCreate, actorUserId: string) {
  return transaction(async (client) => {
    const fields: Record<string, string[]> = {};
    const priority = await client.query(
      "SELECT id FROM priority_groups WHERE id=$1 AND is_active=TRUE",
      [input.priorityGroupId],
    );
    if (!priority.rowCount) addImportError(fields, "priorityGroupId", "Select an active priority group.");

    const collegeNames = [...new Set(input.rows.map((row) => normalized(row.collegeName)))];
    const colleges = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM colleges WHERE is_active=TRUE AND LOWER(name) = ANY($1::text[])",
      [collegeNames],
    );
    const collegeByName = new Map(colleges.rows.map((college) => [normalized(college.name), college]));

    const collegeIds = colleges.rows.map((college) => college.id);
    const courseCodes = [...new Set(input.rows.map((row) => normalized(row.courseCode)))];
    const programs = collegeIds.length
      ? await client.query<{ id: string; college_id: string; code: string }>(
          `SELECT id, college_id, code FROM programs
           WHERE is_active=TRUE AND college_id = ANY($1::uuid[]) AND LOWER(code) = ANY($2::text[])`,
          [collegeIds, courseCodes],
        )
      : { rows: [] as Array<{ id: string; college_id: string; code: string }> };
    const programByCollegeAndCode = new Map(
      programs.rows.map((program) => [`${program.college_id}:${normalized(program.code)}`, program]),
    );

    const resolvedRows = input.rows.map((row) => {
      const college = collegeByName.get(normalized(row.collegeName));
      if (!college) {
        addImportError(fields, `rows.${row.rowNumber}.College`, "College must match an active college name.");
        return null;
      }
      const program = programByCollegeAndCode.get(`${college.id}:${normalized(row.courseCode)}`);
      if (!program) {
        addImportError(fields, `rows.${row.rowNumber}.Course`, "Course must match an active code in the selected college.");
        return null;
      }
      return { ...row, collegeId: college.id, programId: program.id };
    }).filter((row): row is NonNullable<typeof row> => Boolean(row));

    const existingStudents = await client.query<{
      student_number: string;
      full_name: string;
      college_id: string;
      program_id: string;
      year_level: number | null;
    }>(
      `SELECT student_number, CONCAT_WS(' ', first_name, middle_name, last_name, suffix) AS full_name,
              college_id, program_id, year_level
         FROM students WHERE student_number = ANY($1::varchar[])`,
      [[...new Set(resolvedRows.map((row) => row.studentNumber))]],
    );
    const existingByStudentNumber = new Map(existingStudents.rows.map((student) => [student.student_number, student]));
    const firstRowByStudentNumber = new Map<string, (typeof resolvedRows)[number]>();

    for (const row of resolvedRows) {
      const existing = existingByStudentNumber.get(row.studentNumber);
      const firstRow = firstRowByStudentNumber.get(row.studentNumber);
      if (existing || firstRow) {
        if (normalized(existing ? existing.full_name : firstRow!.fullName) !== normalized(row.fullName)) {
          addImportError(fields, `rows.${row.rowNumber}.Name`, "Name does not match the existing student data in this import.");
        }
        if ((existing ? existing.college_id : firstRow!.collegeId) !== row.collegeId) {
          addImportError(fields, `rows.${row.rowNumber}.College`, "College does not match the existing student data in this import.");
        }
        if ((existing ? existing.program_id : firstRow!.programId) !== row.programId) {
          addImportError(fields, `rows.${row.rowNumber}.Course`, "Course does not match the existing student data in this import.");
        }
        if ((existing ? existing.year_level : firstRow!.yearLevel) !== row.yearLevel) {
          addImportError(fields, `rows.${row.rowNumber}.Year`, "Year does not match the existing student data in this import.");
        }
      } else {
        firstRowByStudentNumber.set(row.studentNumber, row);
      }
    }

    if (Object.keys(fields).length) return { fields } as const;

    const missingStudents = [...firstRowByStudentNumber.values()];
    for (const student of missingStudents) {
      await client.query(
        `INSERT INTO students (
          student_number, first_name, last_name, college_id, program_id, year_level
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [student.studentNumber, student.firstName, student.lastName, student.collegeId, student.programId, student.yearLevel],
      );
    }

    const commonCollegeIds = new Set(resolvedRows.map((row) => row.collegeId));
    const commonProgramIds = new Set(resolvedRows.map((row) => row.programId));
    const batches = splitByClinic({
      clinicCode: input.clinicCode,
      batchName: input.batchName,
      collegeId: commonCollegeIds.size === 1 ? [...commonCollegeIds][0] : null,
      programId: commonCollegeIds.size === 1 && commonProgramIds.size === 1 ? [...commonProgramIds][0] : null,
      submittedByName: input.submittedByName,
      description: input.description,
      items: resolvedRows.map((row) => ({
        studentNumber: row.studentNumber,
        scheduleType: row.scheduleType,
        priorityGroupId: input.priorityGroupId,
        targetDate: row.targetDate,
        targetWeekStart: null,
        targetWeekEnd: null,
        remarks: null,
      })),
    });
    if (!batches.length) {
      const clinic = input.clinicCode ? clinicConfigForCode(input.clinicCode) : null;
      return {
        fields: {
          file: [clinic ? `CSV file does not contain any ${clinic.serviceLabel.toLowerCase()} requests for ${clinic.name}.` : "CSV file does not contain any schedule requests."],
        } satisfies Record<string, string[]>,
      };
    }
    const batchIds: string[] = [];
    for (const batch of batches) batchIds.push(await insertClinicBatch(client, batch, actorUserId));
    const itemCount = batches.reduce((sum, batch) => sum + batch.items.length, 0);

    await writeAudit(actorUserId, "SCHEDULE_BATCH_CSV_IMPORTED", "schedule_batch", batchIds[0], {
      fileName: input.fileName,
      itemCount,
      batchIds,
      createdStudentCount: missingStudents.length,
    }, client);

    return {
      id: batchIds[0],
      batchIds,
      status: "DRAFT" as const,
      itemCount,
      createdStudentCount: missingStudents.length,
    };
  });
}

export async function listScheduleBatches(filters: { clinicCode?: ClinicCode } = {}) {
  const clauses = ["b.import_group_id IS NULL"];
  const values: unknown[] = [];
  if (filters.clinicCode) {
    values.push(filters.clinicCode);
    clauses.push(`cl.code = $${values.length}`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const result = await query<{
    id: string; batch_name: string; status: string; clinic_code: ClinicCode; clinic_name: string;
    college_name: string | null; program_name: string | null;
    submitted_by_name: string | null; created_at: Date; item_count: number; conflict_count: number; warning_count: number;
  }>(
    `SELECT b.id, b.batch_name, b.status, cl.code AS clinic_code, cl.name AS clinic_name,
            c.name AS college_name, p.name AS program_name,
            b.submitted_by_name, b.created_at,
            COUNT(i.id)::int AS item_count,
            COUNT(*) FILTER (WHERE i.status = 'CONFLICT')::int AS conflict_count,
            COUNT(*) FILTER (WHERE i.status = 'WARNING')::int AS warning_count
     FROM schedule_batches b
     JOIN clinics cl ON cl.id = b.clinic_id
     LEFT JOIN colleges c ON c.id = b.college_id
     LEFT JOIN programs p ON p.id = b.program_id
     LEFT JOIN coordinator_schedule_items i ON i.batch_id = b.id
     ${where}
     GROUP BY b.id, cl.code, cl.name, c.name, p.name
     ORDER BY b.created_at DESC`,
    values,
  );
  return result.rows.map((row) => ({
    id: row.id, batchName: row.batch_name, status: row.status, clinicCode: row.clinic_code,
    clinicName: row.clinic_name, collegeName: row.college_name,
    programName: row.program_name, submittedByName: row.submitted_by_name,
    createdAt: row.created_at.toISOString(), itemCount: row.item_count,
    conflictCount: row.conflict_count, warningCount: row.warning_count,
  }));
}

export async function getScheduleBatch(batchId: string, client?: PoolClient) {
  const sql = `SELECT b.id, b.batch_name AS "batchName", b.clinic_id AS "clinicId", cl.code AS "clinicCode",
                      cl.name AS "clinicName", b.college_id AS "collegeId", c.name AS "collegeName",
                      b.program_id AS "programId", p.name AS "programName", b.submitted_by_name AS "submittedByName",
                      b.description, b.status, b.validation_summary AS "validationSummary", b.override_reason AS "overrideReason",
                      b.import_group_id AS "importGroupId", b.published_at AS "publishedAt", b.created_at AS "createdAt"
               FROM schedule_batches b
               JOIN clinics cl ON cl.id=b.clinic_id
               LEFT JOIN colleges c ON c.id=b.college_id LEFT JOIN programs p ON p.id=b.program_id
               WHERE b.id=$1`;
  const result = client ? await client.query(sql, [batchId]) : await query(sql, [batchId]);
  if (!result.rows[0]) return null;
  const items = client
    ? await client.query(
        `SELECT i.id, i.clinic_id AS "clinicId", cl.code AS "clinicCode", cl.name AS "clinicName",
                i.student_number AS "studentNumber", CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName",
                i.schedule_type AS "scheduleType", i.priority_group_id AS "priorityGroupId", pg.name AS "priorityGroupName",
                i.target_date::text AS "targetDate", i.target_week_start::text AS "targetWeekStart", i.target_week_end::text AS "targetWeekEnd",
                i.remarks, i.status, i.validation_issues AS "validationIssues"
         FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
         JOIN priority_groups pg ON pg.id=i.priority_group_id JOIN clinics cl ON cl.id=i.clinic_id WHERE i.batch_id=$1
         ORDER BY pg.rank_order, i.student_number`, [batchId])
    : await query(
        `SELECT i.id, i.clinic_id AS "clinicId", cl.code AS "clinicCode", cl.name AS "clinicName",
                i.student_number AS "studentNumber", CONCAT_WS(' ', s.first_name, s.last_name) AS "studentName",
                i.schedule_type AS "scheduleType", i.priority_group_id AS "priorityGroupId", pg.name AS "priorityGroupName",
                i.target_date::text AS "targetDate", i.target_week_start::text AS "targetWeekStart", i.target_week_end::text AS "targetWeekEnd",
                i.remarks, i.status, i.validation_issues AS "validationIssues"
         FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
         JOIN priority_groups pg ON pg.id=i.priority_group_id JOIN clinics cl ON cl.id=i.clinic_id WHERE i.batch_id=$1
         ORDER BY pg.rank_order, i.student_number`, [batchId]);
  return { ...result.rows[0], items: items.rows };
}

export async function getRuleItems(batchId: string, client?: PoolClient) {
  const batchSql = "SELECT id, clinic_id, status, college_id, program_id, import_group_id FROM schedule_batches WHERE id=$1";
  const batch = client
    ? await client.query<{
        id: string; clinic_id: string; status: string; college_id: string | null;
        program_id: string | null; import_group_id: string | null;
      }>(batchSql, [batchId])
    : await query<{
        id: string; clinic_id: string; status: string; college_id: string | null;
        program_id: string | null; import_group_id: string | null;
      }>(batchSql, [batchId]);
  if (!batch.rows[0]) return null;
  const itemsSql = `SELECT i.id, i.clinic_id, i.student_number, i.schedule_type, i.priority_group_id, pg.rank_order AS priority_rank,
            pg.is_active AS priority_active, s.is_active AS student_active,
            s.college_id AS student_college_id, s.program_id AS student_program_id,
            i.target_date::text, i.target_week_start::text, i.target_week_end::text
     FROM coordinator_schedule_items i JOIN students s ON s.student_number=i.student_number
     JOIN priority_groups pg ON pg.id=i.priority_group_id WHERE i.batch_id=$1`;
  const items = client
    ? await client.query<{
        id: string; clinic_id: string; student_number: string; schedule_type: RuleItemRow["scheduleType"]; priority_group_id: string;
        priority_rank: number; priority_active: boolean; student_active: boolean; student_college_id: string;
        student_program_id: string; target_date: string | null; target_week_start: string | null; target_week_end: string | null;
      }>(itemsSql, [batchId])
    : await query<{
    id: string; clinic_id: string; student_number: string; schedule_type: RuleItemRow["scheduleType"]; priority_group_id: string;
    priority_rank: number; priority_active: boolean; student_active: boolean; student_college_id: string;
    student_program_id: string; target_date: string | null; target_week_start: string | null; target_week_end: string | null;
      }>(itemsSql, [batchId]);
  return {
    id: batch.rows[0].id,
    clinicId: batch.rows[0].clinic_id,
    status: batch.rows[0].status,
    importGroupId: batch.rows[0].import_group_id,
    collegeId: batch.rows[0].college_id,
    programId: batch.rows[0].program_id,
    items: items.rows.map((row) => ({
      id: row.id, clinicId: row.clinic_id, studentNumber: row.student_number, scheduleType: row.schedule_type,
      priorityGroupId: row.priority_group_id, priorityRank: row.priority_rank,
      priorityActive: row.priority_active, studentActive: row.student_active,
      studentCollegeId: row.student_college_id, studentProgramId: row.student_program_id,
      targetDate: row.target_date, targetWeekStart: row.target_week_start, targetWeekEnd: row.target_week_end,
    } satisfies RuleItemRow)),
  };
}

export async function activeAppointmentKeys(studentNumbers: string[], client?: PoolClient) {
  if (studentNumbers.length === 0) return new Set<string>();
  const sql = `SELECT student_number, clinic_id, schedule_type FROM appointments
     WHERE student_number = ANY($1::varchar[]) AND status IN ('DRAFT','PENDING')`;
  const result = client
    ? await client.query<{ student_number: string; clinic_id: string; schedule_type: string }>(sql, [studentNumbers])
    : await query<{ student_number: string; clinic_id: string; schedule_type: string }>(sql, [studentNumbers]);
  return new Set(result.rows.map((row) => `${row.student_number}:${row.clinic_id}:${row.schedule_type}`));
}

export async function currentAppointmentLoad(client?: PoolClient) {
  const sql = `SELECT clinic_id, appointment_date::text AS date, schedule_type, COUNT(*)::int AS count
     FROM appointments WHERE status IN ('DRAFT','PENDING') GROUP BY clinic_id, appointment_date, schedule_type`;
  const result = client
    ? await client.query<{ clinic_id: string; date: string; schedule_type: AppointmentScheduleType; count: number }>(sql)
    : await query<{ clinic_id: string; date: string; schedule_type: AppointmentScheduleType; count: number }>(sql);
  return result.rows.map((row) => ({ clinicId: row.clinic_id, date: row.date, scheduleType: row.schedule_type, count: row.count }));
}

export async function capacitySettings(client?: PoolClient) {
  const sql = "SELECT clinic_id, schedule_type, safe_daily_capacity, max_daily_capacity FROM clinic_capacity_settings WHERE is_active=TRUE";
  const result = client
    ? await client.query<{ clinic_id: string; schedule_type: AppointmentScheduleType; safe_daily_capacity: number; max_daily_capacity: number }>(sql)
    : await query<{ clinic_id: string; schedule_type: AppointmentScheduleType; safe_daily_capacity: number; max_daily_capacity: number }>(sql);
  return result.rows.map((row) => ({ clinicId: row.clinic_id, scheduleType: row.schedule_type, safeDailyCapacity: row.safe_daily_capacity, maxDailyCapacity: row.max_daily_capacity }));
}

export async function saveValidation(
  batchId: string,
  actorUserId: string,
  summary: Record<string, unknown>,
  items: Array<{ id: string; status: string; issues: ValidationIssue[] }>,
  client?: PoolClient,
) {
  const persist = async (transactionClient: PoolClient) => {
    await transactionClient.query(
      `UPDATE schedule_batches SET status='VALIDATED', validation_summary=$2::jsonb,
       validated_by=$3, validated_at=NOW() WHERE id=$1`,
      [batchId, JSON.stringify(summary), actorUserId],
    );
    for (const item of items) {
      await transactionClient.query(
        "UPDATE coordinator_schedule_items SET status=$2, validation_issues=$3::jsonb WHERE id=$1",
        [item.id, item.status, JSON.stringify(item.issues)],
      );
    }
  };
  if (client) return persist(client);
  return transaction(persist);
}

export async function persistGeneratedAppointments(
  batchId: string,
  actorUserId: string,
  appointments: DraftAppointment[],
  unscheduledItemIds: string[],
  overrideReason?: string,
  client?: PoolClient,
) {
  const persist = async (transactionClient: PoolClient) => {
    const locked = await transactionClient.query<{ status: string }>("SELECT status FROM schedule_batches WHERE id=$1 FOR UPDATE", [batchId]);
    if (locked.rows[0]?.status !== "VALIDATED") throw new Error("BATCH_NOT_VALIDATED");
    const existing = await transactionClient.query("SELECT 1 FROM appointments WHERE batch_id=$1 LIMIT 1", [batchId]);
    if (existing.rowCount) throw new Error("BATCH_ALREADY_GENERATED");
    for (const appointment of appointments) {
      await transactionClient.query(
        `INSERT INTO appointments (
          batch_id, schedule_item_id, clinic_id, student_number, schedule_type, appointment_date,
          status, is_published, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',FALSE,$7,$7)`,
        [
          batchId,
          appointment.scheduleItemId,
          appointment.clinicId,
          appointment.studentNumber,
          appointment.scheduleType,
          appointment.appointmentDate,
          actorUserId,
        ],
      );
    }
    await transactionClient.query(
      `UPDATE coordinator_schedule_items SET status='SCHEDULED'
       WHERE batch_id=$1 AND id = ANY($2::uuid[])`,
      [batchId, [...new Set(appointments.map((appointment) => appointment.scheduleItemId))]],
    );
    if (unscheduledItemIds.length) {
      await transactionClient.query("UPDATE coordinator_schedule_items SET status='UNSCHEDULED' WHERE id = ANY($1::uuid[])", [unscheduledItemIds]);
    }
    await transactionClient.query(
      `UPDATE schedule_batches SET status='GENERATED', override_reason=$2,
       overridden_by=CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END,
       overridden_at=CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END
       WHERE id=$1`,
      [batchId, overrideReason ?? null, actorUserId],
    );
    return getScheduleBatch(batchId, transactionClient);
  };
  if (client) return persist(client);
  return transaction(persist);
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
