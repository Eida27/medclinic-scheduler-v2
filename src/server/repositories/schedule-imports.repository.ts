import "server-only";
import type { PoolClient } from "pg";
import type { AppointmentScheduleType, ClinicCode } from "@/server/clinics";
import { query, transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import type { ImportedStudentRow } from "@/server/services/student-import-csv";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type ScheduleImportStatus =
  | "DRAFT"
  | "VALIDATED"
  | "GENERATED"
  | "PUBLISHED"
  | "CANCELLED"
  | "NEEDS_REVIEW";

const synchronizedStatuses = new Set<ScheduleImportStatus>([
  "DRAFT",
  "VALIDATED",
  "GENERATED",
  "PUBLISHED",
  "CANCELLED",
]);

export function deriveScheduleImportStatus(statuses: string[]): ScheduleImportStatus {
  const first = statuses[0];
  if (!first || !synchronizedStatuses.has(first as ScheduleImportStatus)) return "NEEDS_REVIEW";
  return statuses.every((status) => status === first) ? first as ScheduleImportStatus : "NEEDS_REVIEW";
}

export type CreateScheduleImportInput = {
  sourceFilename: string;
  studentCategory: "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";
  academicYearStart: number;
  preferredMonth: number | null;
  rows: ImportedStudentRow[];
};

export type ScheduleImportResult = {
  importId: string;
  status: "DRAFT";
  totalRows: number;
  insertedStudentCount: number;
  updatedStudentCount: number;
  skippedStudentCount: number;
  laboratoryItemCount: number;
  physicalExaminationItemCount: number;
  batchIds: string[];
};

export type ScheduleImportListItem = {
  importId: string;
  importName: string;
  sourceFilename: string;
  totalRows: number;
  createdStudentCount: number;
  matchedStudentCount: number;
  submittedByName: string | null;
  description: string | null;
  createdByName: string;
  laboratoryItemCount: number;
  physicalExaminationItemCount: number;
  status: ScheduleImportStatus;
  createdAt: string;
  updatedAt: string;
};

type StoredImportChildBatch = NonNullable<Awaited<ReturnType<typeof getScheduleBatch>>>;

export type ScheduleImportAppointment = {
  id: string;
  batchId: string;
  studentNumber: string;
  studentName: string;
  scheduleType: AppointmentScheduleType;
  priorityGroupName: string | null;
  appointmentDate: string;
  appointmentTime: string | null;
  status: string;
  isPublished: boolean;
  notes: string | null;
};

export type ImportChildBatch = StoredImportChildBatch & {
  appointments: ScheduleImportAppointment[];
};

export type ScheduleImportDetail = ScheduleImportListItem & {
  childBatches: ImportChildBatch[];
};

export type LockedImportChild = {
  id: string;
  status: string;
  clinicCode: ClinicCode;
};

type CollegeReference = {
  id: string;
  name: string;
};

type ProgramReference = {
  id: string;
  college_id: string;
  code: string;
};

type ExistingStudent = {
  student_number: string;
};

type ResolvedRow = ImportedStudentRow & {
  collegeId: string | null;
  programId: string | null;
  existedBeforeImport: boolean;
  alreadyScheduledForCycle: boolean;
};

function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function addFieldError(
  fields: Record<string, string[]>,
  field: string,
  message: string,
) {
  fields[field] = [...(fields[field] ?? []), message];
}

function uniqueReferenceMap<T>(
  rows: T[],
  keyFor: (row: T) => string,
): Map<string, T | null> {
  const result = new Map<string, T | null>();
  for (const row of rows) {
    const key = keyFor(row);
    result.set(key, result.has(key) ? null : row);
  }
  return result;
}


export async function createScheduleImport(
  input: CreateScheduleImportInput,
  actorUserId: string,
): Promise<ScheduleImportResult | { fields: Record<string, string[]> }> {
  return transaction(async (client) => {
    const fields: Record<string, string[]> = {};
    const colleges = await client.query<CollegeReference>(
      "SELECT id, name FROM colleges WHERE is_active=TRUE",
    );
    const programs = await client.query<ProgramReference>(
      "SELECT id, college_id, code FROM programs WHERE is_active=TRUE",
    );
    const existingStudents = await client.query<ExistingStudent>(
      `SELECT student_number FROM students
        WHERE student_number = ANY($1::varchar[])`,
      [[...new Set(input.rows.map((row) => row.studentNumber))]],
    );
    const scheduledStudents = await client.query<{ student_number: string }>(
      `SELECT DISTINCT student_number
         FROM appointments
        WHERE student_number = ANY($1::varchar[])
          AND schedule_cycle_start=$2
          AND status <> 'CANCELLED'`,
      [[...new Set(input.rows.map((row) => row.studentNumber))], input.academicYearStart],
    );

    const collegeByName = uniqueReferenceMap(
      colleges.rows,
      (college) => normalizeComparable(college.name),
    );
    const programByCollegeAndCode = uniqueReferenceMap(
      programs.rows,
      (program) => `${program.college_id}:${normalizeComparable(program.code)}`,
    );
    const existingStudentNumbers = new Set(
      existingStudents.rows.map((student) => student.student_number),
    );
    const scheduledStudentNumbers = new Set(
      scheduledStudents.rows.map((student) => student.student_number),
    );

    const resolvedRows: ResolvedRow[] = input.rows.map((row) => {
      const college = collegeByName.get(normalizeComparable(row.collegeName));
      if (!college) {
        addFieldError(
          fields,
          `rows.${row.rowNumber}.College`,
          "College must match an active college name.",
        );
      }
      const program = college
        ? programByCollegeAndCode.get(`${college.id}:${normalizeComparable(row.courseCode)}`)
        : null;
      if (college && !program) {
        addFieldError(
          fields,
          `rows.${row.rowNumber}.Course`,
          "Course must match an active code in the selected college.",
        );
      }

      return {
        ...row,
        collegeId: college?.id ?? null,
        programId: program?.id ?? null,
        existedBeforeImport: existingStudentNumbers.has(row.studentNumber),
        alreadyScheduledForCycle: scheduledStudentNumbers.has(row.studentNumber),
      };
    });

    if (Object.keys(fields).length) return { fields };

    const insertedStudentCount = resolvedRows.filter((row) => !row.existedBeforeImport).length;
    const updatedStudentCount = resolvedRows.length - insertedStudentCount;
    const skippedStudentCount = resolvedRows.filter(
      (row) => row.alreadyScheduledForCycle,
    ).length;
    const importName = Array.from(
      `${input.studentCategory} ${input.academicYearStart}-${input.academicYearStart + 1} - ${input.sourceFilename}`,
    ).slice(0, 150).join("");
    const importGroup = await client.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_student_count,
         matched_student_count, created_by, student_category, academic_year_start,
         preferred_month, accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
       RETURNING id`,
      [
        importName,
        input.sourceFilename,
        input.rows.length,
        insertedStudentCount,
        updatedStudentCount,
        actorUserId,
        input.studentCategory,
        input.academicYearStart,
        input.preferredMonth,
      ],
    );
    const importId = importGroup.rows[0].id;

    await client.query(
      `INSERT INTO students (
         student_number, first_name, middle_name, last_name, suffix,
         college_id, program_id, year_level, date_of_birth
       )
       SELECT fixture.student_number, fixture.first_name, fixture.middle_name,
              fixture.last_name, fixture.suffix, fixture.college_id,
              fixture.program_id, fixture.year_level, fixture.date_of_birth
         FROM UNNEST(
           $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[],
           $5::varchar[], $6::uuid[], $7::uuid[], $8::integer[], $9::date[]
         ) AS fixture(
           student_number, first_name, middle_name, last_name, suffix,
           college_id, program_id, year_level, date_of_birth
         )
       ON CONFLICT (student_number) DO UPDATE SET
         first_name=EXCLUDED.first_name,
         middle_name=EXCLUDED.middle_name,
         last_name=EXCLUDED.last_name,
         suffix=EXCLUDED.suffix,
         college_id=EXCLUDED.college_id,
         program_id=EXCLUDED.program_id,
         year_level=EXCLUDED.year_level,
         date_of_birth=EXCLUDED.date_of_birth,
         updated_at=NOW()`,
      [
        resolvedRows.map((student) => student.studentNumber),
        resolvedRows.map((student) => student.firstName),
        resolvedRows.map((student) => student.middleInitial),
        resolvedRows.map((student) => student.surname),
        resolvedRows.map((student) => student.suffix),
        resolvedRows.map((student) => student.collegeId),
        resolvedRows.map((student) => student.programId),
        resolvedRows.map((student) => student.yearLevel),
        resolvedRows.map((student) => student.dateOfBirth),
      ],
    );
    const updatedStudentNumbers = resolvedRows
      .filter((student) => student.existedBeforeImport)
      .map((student) => student.studentNumber);
    if (updatedStudentNumbers.length) {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         SELECT $1, 'STUDENT_PROFILE_UPDATED_BY_IMPORT', 'student', student_number,
                jsonb_build_object('importId', $2::text)
           FROM UNNEST($3::varchar[]) AS fixture(student_number)`,
        [actorUserId, importId, updatedStudentNumbers],
      );
    }

    const batchIds: string[] = [];
    const laboratoryItemCount = 0;
    const physicalExaminationItemCount = 0;
    const metadata = {
      sourceFilename: input.sourceFilename,
      batchIds,
      totalRows: input.rows.length,
      laboratoryItemCount,
      physicalExaminationItemCount,
      insertedStudentCount,
      updatedStudentCount,
      skippedStudentCount,
      studentCategory: input.studentCategory,
      academicYearStart: input.academicYearStart,
    };
    await writeAudit(
      actorUserId,
      "SCHEDULE_IMPORT_CREATED",
      "schedule_import_group",
      importId,
      metadata,
      client,
    );

    return {
      importId,
      status: "DRAFT",
      totalRows: input.rows.length,
      insertedStudentCount,
      updatedStudentCount,
      skippedStudentCount,
      laboratoryItemCount,
      physicalExaminationItemCount,
      batchIds,
    };
  });
}

type ScheduleImportSummaryRow = {
  import_id: string;
  import_name: string;
  source_filename: string;
  total_rows: number;
  created_student_count: number;
  matched_student_count: number;
  submitted_by_name: string | null;
  description: string | null;
  created_by_name: string;
  laboratory_item_count: number;
  physical_examination_item_count: number;
  child_statuses: string[];
  created_at: Date;
  updated_at: Date;
};

async function loadScheduleImportGroups(importId?: string) {
  const values = importId ? [importId] : [];
  const where = importId ? "WHERE import_group.id=$1" : "";
  const result = await query<ScheduleImportSummaryRow>(
    `SELECT import_group.id AS import_id,
            import_group.import_name,
            import_group.source_filename,
            import_group.total_rows,
            import_group.created_student_count,
            import_group.matched_student_count,
            import_group.submitted_by_name,
            import_group.description,
            creator.full_name AS created_by_name,
            COUNT(item.id) FILTER (WHERE item.schedule_type='LABORATORY')::int
              AS laboratory_item_count,
            COUNT(item.id) FILTER (WHERE item.schedule_type='PHYSICAL_EXAM')::int
              AS physical_examination_item_count,
            COALESCE(
              ARRAY_AGG(DISTINCT batch.status) FILTER (WHERE batch.id IS NOT NULL),
              ARRAY[]::varchar[]
            ) AS child_statuses,
            import_group.created_at,
            import_group.updated_at
       FROM schedule_import_groups import_group
       JOIN users creator ON creator.id=import_group.created_by
       LEFT JOIN schedule_batches batch ON batch.import_group_id=import_group.id
       LEFT JOIN coordinator_schedule_items item ON item.batch_id=batch.id
       ${where}
       GROUP BY import_group.id, creator.full_name
       ORDER BY import_group.created_at DESC`,
    values,
  );
  return result.rows.map((row): ScheduleImportListItem => ({
    importId: row.import_id,
    importName: row.import_name,
    sourceFilename: row.source_filename,
    totalRows: row.total_rows,
    createdStudentCount: row.created_student_count,
    matchedStudentCount: row.matched_student_count,
    submittedByName: row.submitted_by_name,
    description: row.description,
    createdByName: row.created_by_name,
    laboratoryItemCount: row.laboratory_item_count,
    physicalExaminationItemCount: row.physical_examination_item_count,
    status: deriveScheduleImportStatus(row.child_statuses),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listScheduleImportGroups(): Promise<ScheduleImportListItem[]> {
  return loadScheduleImportGroups();
}

export async function withLockedScheduleImport<T>(
  importId: string,
  callback: (client: PoolClient, children: LockedImportChild[]) => Promise<T>,
): Promise<T | null> {
  return transaction(async (client) => {
    const group = await client.query(
      "SELECT id FROM schedule_import_groups WHERE id=$1 FOR UPDATE",
      [importId],
    );
    if (!group.rowCount) return null;

    const children = await client.query<{
      id: string;
      status: string;
      clinic_code: ClinicCode;
    }>(
      `SELECT batch.id, batch.status, clinic.code AS clinic_code
         FROM schedule_batches batch
         JOIN clinics clinic ON clinic.id=batch.clinic_id
        WHERE batch.import_group_id=$1
        ORDER BY CASE clinic.code
          WHEN 'KABALAKA_CLINIC' THEN 1
          WHEN 'CPU_CLINIC' THEN 2
          ELSE 3
        END, batch.id
        FOR UPDATE OF batch`,
      [importId],
    );
    return callback(client, children.rows.map((child) => ({
      id: child.id,
      status: child.status,
      clinicCode: child.clinic_code,
    })));
  });
}

export async function touchScheduleImportGroup(
  importId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    "UPDATE schedule_import_groups SET updated_at=NOW() WHERE id=$1",
    [importId],
  );
}

export async function getImportChildBatches(
  importId: string,
  client?: PoolClient,
): Promise<ImportChildBatch[]> {
  const sql = `SELECT batch.id
                 FROM schedule_batches batch
                 JOIN clinics clinic ON clinic.id=batch.clinic_id
                WHERE batch.import_group_id=$1
                ORDER BY CASE clinic.code
                  WHEN 'KABALAKA_CLINIC' THEN 1
                  WHEN 'CPU_CLINIC' THEN 2
                  ELSE 3
                END, batch.id`;
  const ids = client
    ? await client.query<{ id: string }>(sql, [importId])
    : await query<{ id: string }>(sql, [importId]);
  const appointmentsSql = `SELECT appointment.id,
                                  appointment.batch_id AS "batchId",
                                  appointment.student_number AS "studentNumber",
                                  ${studentDisplayNameSql("student")} AS "studentName",
                                  appointment.schedule_type AS "scheduleType",
                                  priority_group.name AS "priorityGroupName",
                                  appointment.appointment_date::text AS "appointmentDate",
                                  appointment.appointment_time::text AS "appointmentTime",
                                  appointment.status,
                                  appointment.is_published AS "isPublished",
                                  appointment.notes
                             FROM appointments appointment
                             JOIN schedule_batches batch ON batch.id=appointment.batch_id
                             JOIN students student ON student.student_number=appointment.student_number
                             LEFT JOIN coordinator_schedule_items schedule_item
                               ON schedule_item.id=appointment.schedule_item_id
                             LEFT JOIN priority_groups priority_group
                               ON priority_group.id=schedule_item.priority_group_id
                            WHERE batch.import_group_id=$1
                            ORDER BY appointment.appointment_date,
                                     appointment.appointment_time NULLS LAST,
                                     student.last_name, student.first_name, appointment.id`;
  const appointmentResult = client
    ? await client.query<ScheduleImportAppointment>(appointmentsSql, [importId])
    : await query<ScheduleImportAppointment>(appointmentsSql, [importId]);
  const appointmentsByBatch = new Map<string, ScheduleImportAppointment[]>();
  for (const appointment of appointmentResult.rows) {
    appointmentsByBatch.set(appointment.batchId, [
      ...(appointmentsByBatch.get(appointment.batchId) ?? []),
      appointment,
    ]);
  }
  const children: ImportChildBatch[] = [];
  for (const { id } of ids.rows) {
    const child = await getScheduleBatch(id, client);
    if (child) {
      children.push({
        ...child,
        appointments: appointmentsByBatch.get(id) ?? [],
      });
    }
  }
  return children;
}

export async function getScheduleImportGroup(
  importId: string,
): Promise<ScheduleImportDetail | null> {
  const summary = (await loadScheduleImportGroups(importId))[0];
  if (!summary) return null;
  return {
    ...summary,
    childBatches: await getImportChildBatches(importId),
  };
}
