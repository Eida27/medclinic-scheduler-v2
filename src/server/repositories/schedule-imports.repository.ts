import "server-only";
import type { PoolClient } from "pg";
import { clinicConfigForCode, type AppointmentScheduleType, type ClinicCode } from "@/server/clinics";
import { query, transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import type { StudentScheduleCsvRow } from "@/server/services/student-schedule-import-csv";
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
  importName: string;
  sourceFilename: string;
  priorityGroupId: string;
  submittedByName: string | null;
  description: string | null;
  rows: StudentScheduleCsvRow[];
};

export type ScheduleImportResult = {
  importId: string;
  status: "DRAFT";
  totalRows: number;
  createdStudentCount: number;
  matchedStudentCount: number;
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
  first_name: string;
  middle_name: string | null;
  last_name: string;
  suffix: string | null;
  college_id: string;
  program_id: string;
  year_level: number | null;
};

type ResolvedRow = StudentScheduleCsvRow & {
  collegeId: string | null;
  programId: string | null;
  existingStudent: ExistingStudent | null;
};

type ChildService = {
  scheduleType: AppointmentScheduleType;
  clinicCode: ClinicCode;
  dateField: "laboratoryDate" | "physicalExaminationDate";
};

const childServices: ChildService[] = [
  {
    scheduleType: "LABORATORY",
    clinicCode: "KABALAKA_CLINIC",
    dateField: "laboratoryDate",
  },
  {
    scheduleType: "PHYSICAL_EXAM",
    clinicCode: "CPU_CLINIC",
    dateField: "physicalExaminationDate",
  },
];

const maximumBatchNameCharacters = 150;

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

function nameMatches(row: StudentScheduleCsvRow, student: ExistingStudent): boolean {
  return normalizeComparable(row.firstName) === normalizeComparable(student.first_name)
    && normalizeComparable(row.middleName) === normalizeComparable(student.middle_name)
    && normalizeComparable(row.lastName) === normalizeComparable(student.last_name)
    && normalizeComparable(row.suffix) === normalizeComparable(student.suffix);
}

function childBatchName(importName: string, clinicName: string, childCount: number): string {
  if (childCount === 1) return importName;
  const suffix = ` - ${clinicName}`;
  const availableBaseCharacters = maximumBatchNameCharacters - Array.from(suffix).length;
  return `${Array.from(importName).slice(0, availableBaseCharacters).join("")}${suffix}`;
}

async function insertChildBatch(
  client: PoolClient,
  input: CreateScheduleImportInput,
  importId: string,
  actorUserId: string,
  service: ChildService,
  rows: ResolvedRow[],
  childCount: number,
  commonCollegeId: string | null,
  commonProgramId: string | null,
) {
  const clinic = clinicConfigForCode(service.clinicCode);
  const batchName = childBatchName(input.importName, clinic.name, childCount);
  const batch = await client.query<{ id: string }>(
    `INSERT INTO schedule_batches (
       clinic_id, batch_name, college_id, program_id, submitted_by_name,
       description, created_by, import_group_id
     ) VALUES (
       (SELECT id FROM clinics WHERE code=$1),$2,$3,$4,$5,$6,$7,$8
     ) RETURNING id`,
    [
      service.clinicCode,
      batchName,
      commonCollegeId,
      commonProgramId,
      input.submittedByName,
      input.description,
      actorUserId,
      importId,
    ],
  );
  const batchId = batch.rows[0].id;
  await client.query(
    `INSERT INTO coordinator_schedule_items (
       batch_id, clinic_id, student_number, schedule_type, priority_group_id, target_date
     )
     SELECT $1, clinic.id, fixture.student_number, $3, $4, fixture.target_date
       FROM clinics clinic
       CROSS JOIN UNNEST($5::varchar[], $6::date[]) AS fixture(student_number, target_date)
      WHERE clinic.code=$2`,
    [
      batchId,
      service.clinicCode,
      service.scheduleType,
      input.priorityGroupId,
      rows.map((row) => row.studentNumber),
      rows.map((row) => row[service.dateField]),
    ],
  );
  return batchId;
}

export async function createScheduleImport(
  input: CreateScheduleImportInput,
  actorUserId: string,
): Promise<ScheduleImportResult | { fields: Record<string, string[]> }> {
  return transaction(async (client) => {
    const fields: Record<string, string[]> = {};
    const priority = await client.query(
      "SELECT id FROM priority_groups WHERE id=$1 AND is_active=TRUE",
      [input.priorityGroupId],
    );
    if (!priority.rowCount) {
      addFieldError(fields, "priorityGroupId", "Select an active priority group.");
    }

    const colleges = await client.query<CollegeReference>(
      "SELECT id, name FROM colleges WHERE is_active=TRUE",
    );
    const programs = await client.query<ProgramReference>(
      "SELECT id, college_id, code FROM programs WHERE is_active=TRUE",
    );
    const existingStudents = await client.query<ExistingStudent>(
      `SELECT student_number, first_name, middle_name, last_name, suffix,
              college_id, program_id, year_level
         FROM students
        WHERE student_number = ANY($1::varchar[])`,
      [[...new Set(input.rows.map((row) => row.studentNumber))]],
    );

    const collegeByName = uniqueReferenceMap(
      colleges.rows,
      (college) => normalizeComparable(college.name),
    );
    const programByCollegeAndCode = uniqueReferenceMap(
      programs.rows,
      (program) => `${program.college_id}:${normalizeComparable(program.code)}`,
    );
    const studentByNumber = new Map(
      existingStudents.rows.map((student) => [student.student_number, student]),
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

      const existingStudent = studentByNumber.get(row.studentNumber) ?? null;
      if (existingStudent) {
        if (!nameMatches(row, existingStudent)) {
          addFieldError(
            fields,
            `rows.${row.rowNumber}.Name`,
            "Name does not match the existing student data in this import.",
          );
        }
        if (college && existingStudent.college_id !== college.id) {
          addFieldError(
            fields,
            `rows.${row.rowNumber}.College`,
            "College does not match the existing student data in this import.",
          );
        }
        if (program && existingStudent.program_id !== program.id) {
          addFieldError(
            fields,
            `rows.${row.rowNumber}.Course`,
            "Course does not match the existing student data in this import.",
          );
        }
        if (existingStudent.year_level !== row.yearLevel) {
          addFieldError(
            fields,
            `rows.${row.rowNumber}.Year`,
            "Year does not match the existing student data in this import.",
          );
        }
      }

      return {
        ...row,
        collegeId: college?.id ?? null,
        programId: program?.id ?? null,
        existingStudent,
      };
    });

    if (Object.keys(fields).length) return { fields };

    const missingStudents = resolvedRows.filter((row) => !row.existingStudent);
    const matchedStudentCount = resolvedRows.length - missingStudents.length;
    const importGroup = await client.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_student_count,
         matched_student_count, submitted_by_name, description, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.importName,
        input.sourceFilename,
        input.rows.length,
        missingStudents.length,
        matchedStudentCount,
        input.submittedByName,
        input.description,
        actorUserId,
      ],
    );
    const importId = importGroup.rows[0].id;

    if (missingStudents.length) {
      await client.query(
        `INSERT INTO students (
           student_number, first_name, middle_name, last_name, suffix,
           college_id, program_id, year_level
         )
         SELECT fixture.student_number, fixture.first_name, fixture.middle_name,
                fixture.last_name, fixture.suffix, fixture.college_id,
                fixture.program_id, fixture.year_level
           FROM UNNEST(
             $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[],
             $5::varchar[], $6::uuid[], $7::uuid[], $8::integer[]
           ) AS fixture(
             student_number, first_name, middle_name, last_name, suffix,
             college_id, program_id, year_level
           )`,
        [
          missingStudents.map((student) => student.studentNumber),
          missingStudents.map((student) => student.firstName),
          missingStudents.map((student) => student.middleName),
          missingStudents.map((student) => student.lastName),
          missingStudents.map((student) => student.suffix),
          missingStudents.map((student) => student.collegeId),
          missingStudents.map((student) => student.programId),
          missingStudents.map((student) => student.yearLevel),
        ],
      );
    }

    const collegeIds = new Set(resolvedRows.map((row) => row.collegeId));
    const programIds = new Set(resolvedRows.map((row) => row.programId));
    const commonCollegeId = collegeIds.size === 1 ? [...collegeIds][0] : null;
    const commonProgramId = programIds.size === 1 ? [...programIds][0] : null;
    const populatedServices = childServices.map((service) => ({
      service,
      rows: resolvedRows.filter((row) => Boolean(row[service.dateField])),
    })).filter(({ rows }) => rows.length > 0);

    const batchIds: string[] = [];
    for (const { service, rows } of populatedServices) {
      batchIds.push(await insertChildBatch(
        client,
        input,
        importId,
        actorUserId,
        service,
        rows,
        populatedServices.length,
        commonCollegeId,
        commonProgramId,
      ));
    }

    const laboratoryItemCount = resolvedRows.filter((row) => Boolean(row.laboratoryDate)).length;
    const physicalExaminationItemCount = resolvedRows.filter(
      (row) => Boolean(row.physicalExaminationDate),
    ).length;
    const metadata = {
      sourceFilename: input.sourceFilename,
      batchIds,
      totalRows: input.rows.length,
      laboratoryItemCount,
      physicalExaminationItemCount,
      createdStudentCount: missingStudents.length,
      matchedStudentCount,
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
      createdStudentCount: missingStudents.length,
      matchedStudentCount,
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
