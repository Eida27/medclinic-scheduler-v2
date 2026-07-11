// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { deriveScheduleImportStatus } from "@/server/repositories/schedule-imports.repository";
import {
  getScheduleImport,
  importStudentScheduleCsv,
  listScheduleImports,
} from "./schedule-imports.service";

const header = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
].join(",");

const studentNumberPattern = "TEST-GRP-%";
const batchNamePattern = "TEST-GRP%";
const importNamePattern = "TEST-GRP%";
const sourceFilename = "TEST-GRP-schedule.csv";
const maximumFileSize = 1024 * 1024;

const inactivePriorityId = "31000000-0000-4000-8000-000000000001";
const alternateProgramId = "21000000-0000-4000-8000-000000000001";

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

const clinicStaff: SessionUser = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
};

type CsvRow = {
  studentNumber: string;
  name: string;
  college?: string;
  course?: string;
  year?: number;
  laboratoryDate?: string;
  physicalDate?: string;
};

function csvRow({
  studentNumber,
  name,
  college = "College of Computer Studies",
  course = "BSIT",
  year = 3,
  laboratoryDate = "",
  physicalDate = "",
}: CsvRow) {
  return [
    studentNumber,
    `"${name.replaceAll('"', '""')}"`,
    college,
    course,
    year,
    laboratoryDate,
    physicalDate,
  ].join(",");
}

function csv(...rows: CsvRow[]) {
  return [header, ...rows.map(csvRow)].join("\n");
}

function byteLength(contents: string | ArrayBuffer | Uint8Array) {
  if (typeof contents === "string") return Buffer.byteLength(contents);
  return contents.byteLength;
}

function input(
  importName: string,
  contents: string | ArrayBuffer | Uint8Array,
  overrides: Record<string, unknown> = {},
) {
  return {
    fileName: sourceFilename,
    fileSize: byteLength(contents),
    contents,
    importName,
    priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
    submittedByName: "  Test Registrar  ",
    description: "  Disposable grouped import fixture  ",
    ...overrides,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern, importNamePattern);
  await pool.query("DELETE FROM programs WHERE id=$1", [alternateProgramId]);
  await pool.query("DELETE FROM priority_groups WHERE id=$1", [inactivePriorityId]);
}

async function countImportWrites(importName: string, studentNumbers: string[]) {
  const result = await pool.query<{
    group_count: number;
    batch_count: number;
    student_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE import_name=$1) AS group_count,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE batch_name LIKE $1 || '%') AS batch_count,
       (SELECT COUNT(*)::int FROM students WHERE student_number = ANY($2::varchar[])) AS student_count`,
    [importName, studentNumbers],
  );
  return result.rows[0];
}

beforeAll(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  const residue = await pool.query<{
    groups: number;
    batches: number;
    students: number;
    items: number;
    appointments: number;
    group_audits: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE import_name LIKE $1) AS groups,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE batch_name LIKE $2) AS batches,
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $3) AS students,
       (SELECT COUNT(*)::int
          FROM coordinator_schedule_items item
          LEFT JOIN schedule_batches batch ON batch.id=item.batch_id
         WHERE item.student_number LIKE $3 OR batch.batch_name LIKE $2) AS items,
       (SELECT COUNT(*)::int
          FROM appointments appointment
          LEFT JOIN schedule_batches batch ON batch.id=appointment.batch_id
         WHERE appointment.student_number LIKE $3 OR batch.batch_name LIKE $2) AS appointments,
       (SELECT COUNT(*)::int
          FROM audit_logs
         WHERE entity_type='schedule_import_group'
           AND metadata->>'sourceFilename' LIKE 'TEST-GRP%') AS group_audits`,
    [importNamePattern, batchNamePattern, studentNumberPattern],
  );
  expect(residue.rows[0]).toEqual({
    groups: 0,
    batches: 0,
    students: 0,
    items: 0,
    appointments: 0,
    group_audits: 0,
  });
  await pool.end();
});

describe("grouped student schedule imports", () => {
  it("denies clinic staff before validating or parsing input", async () => {
    await expect(importStudentScheduleCsv(undefined, clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action.",
      status: 403,
    });
    expect(await countImportWrites("TEST-GRP denied", [])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("atomically creates a group, student, two clinic children, dated items, and one group audit", async () => {
    const importName = "TEST-GRP both services";
    const studentNumber = "TEST-GRP-BOTH-001";
    const csvText = csv({
      studentNumber,
      name: "Dela Cruz, Anna Marie",
      laboratoryDate: "08-10-2026",
      physicalDate: "08-11-2026",
    });
    const encoded = new TextEncoder().encode(csvText);
    const backing = new Uint8Array(encoded.byteLength + 2);
    backing[0] = 0xff;
    backing.set(encoded, 1);
    backing[backing.byteLength - 1] = 0xff;
    const contents = backing.subarray(1, -1);

    const created = await importStudentScheduleCsv(input(importName, contents), admin);

    expect(created).toEqual({
      importId: expect.any(String),
      status: "DRAFT",
      totalRows: 1,
      createdStudentCount: 1,
      matchedStudentCount: 0,
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 1,
      batchIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
    });
    expect(created.batchIds).toHaveLength(2);

    const student = await pool.query(
      `SELECT first_name, middle_name, last_name, suffix, college_id, program_id, year_level
         FROM students WHERE student_number=$1`,
      [studentNumber],
    );
    expect(student.rows).toEqual([{
      first_name: "Anna",
      middle_name: "Marie",
      last_name: "Dela Cruz",
      suffix: null,
      college_id: TEST_REFERENCE_IDS.college,
      program_id: TEST_REFERENCE_IDS.program,
      year_level: 3,
    }]);

    const group = await pool.query(
      `SELECT import_name, source_filename, total_rows, created_student_count,
              matched_student_count, submitted_by_name, description, created_by
         FROM schedule_import_groups WHERE id=$1`,
      [created.importId],
    );
    expect(group.rows).toEqual([{
      import_name: importName,
      source_filename: sourceFilename,
      total_rows: 1,
      created_student_count: 1,
      matched_student_count: 0,
      submitted_by_name: "Test Registrar",
      description: "Disposable grouped import fixture",
      created_by: admin.userId,
    }]);

    const children = await pool.query(
      `SELECT batch.id, batch.batch_name, batch.import_group_id, batch.status,
              clinic.code AS clinic_code, batch.college_id, batch.program_id
         FROM schedule_batches batch
         JOIN clinics clinic ON clinic.id=batch.clinic_id
        WHERE batch.import_group_id=$1
        ORDER BY clinic.code`,
      [created.importId],
    );
    expect(children.rows).toEqual([
      expect.objectContaining({
        batch_name: `${importName} - CPU Clinic`,
        import_group_id: created.importId,
        status: "DRAFT",
        clinic_code: "CPU_CLINIC",
        college_id: TEST_REFERENCE_IDS.college,
        program_id: TEST_REFERENCE_IDS.program,
      }),
      expect.objectContaining({
        batch_name: `${importName} - KABALAKA Clinic`,
        import_group_id: created.importId,
        status: "DRAFT",
        clinic_code: "KABALAKA_CLINIC",
        college_id: TEST_REFERENCE_IDS.college,
        program_id: TEST_REFERENCE_IDS.program,
      }),
    ]);

    const items = await pool.query(
      `SELECT item.student_number, item.schedule_type, item.target_date::text,
              item.priority_group_id, clinic.code AS clinic_code
         FROM coordinator_schedule_items item
         JOIN clinics clinic ON clinic.id=item.clinic_id
        WHERE item.batch_id = ANY($1::uuid[])
        ORDER BY item.schedule_type`,
      [created.batchIds],
    );
    expect(items.rows).toEqual([
      {
        student_number: studentNumber,
        schedule_type: "LABORATORY",
        target_date: "2026-08-10",
        priority_group_id: TEST_REFERENCE_IDS.regularPriority,
        clinic_code: "KABALAKA_CLINIC",
      },
      {
        student_number: studentNumber,
        schedule_type: "PHYSICAL_EXAM",
        target_date: "2026-08-11",
        priority_group_id: TEST_REFERENCE_IDS.regularPriority,
        clinic_code: "CPU_CLINIC",
      },
    ]);

    const audit = await pool.query(
      `SELECT action, entity_type, entity_id, actor_user_id, metadata
         FROM audit_logs
        WHERE entity_type='schedule_import_group' AND entity_id=$1`,
      [created.importId],
    );
    expect(audit.rows).toEqual([{
      action: "SCHEDULE_IMPORT_CREATED",
      entity_type: "schedule_import_group",
      entity_id: created.importId,
      actor_user_id: admin.userId,
      metadata: {
        sourceFilename,
        batchIds: created.batchIds,
        totalRows: 1,
        laboratoryItemCount: 1,
        physicalExaminationItemCount: 1,
        createdStudentCount: 1,
        matchedStudentCount: 0,
      },
    }]);
  });

  it.each([
    {
      label: "laboratory-only",
      studentNumber: "TEST-GRP-LAB-001",
      laboratoryDate: "08-12-2026",
      physicalDate: "",
      expectedClinic: "KABALAKA_CLINIC",
      expectedType: "LABORATORY",
      expectedDate: "2026-08-12",
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 0,
    },
    {
      label: "physical-only",
      studentNumber: "TEST-GRP-PE-001",
      laboratoryDate: "",
      physicalDate: "08-13-2026",
      expectedClinic: "CPU_CLINIC",
      expectedType: "PHYSICAL_EXAM",
      expectedDate: "2026-08-13",
      laboratoryItemCount: 0,
      physicalExaminationItemCount: 1,
    },
  ])("creates exactly one correct $label child", async ({
    label,
    studentNumber,
    laboratoryDate,
    physicalDate,
    expectedClinic,
    expectedType,
    expectedDate,
    laboratoryItemCount,
    physicalExaminationItemCount,
  }) => {
    const importName = `TEST-GRP ${label}`;
    const created = await importStudentScheduleCsv(input(importName, csv({
      studentNumber,
      name: "Single, Service",
      laboratoryDate,
      physicalDate,
    })), admin);

    expect(created).toMatchObject({
      laboratoryItemCount,
      physicalExaminationItemCount,
    });
    expect(created.batchIds).toHaveLength(1);
    const child = await pool.query(
      `SELECT batch.batch_name, clinic.code AS clinic_code, item.schedule_type,
              item.target_date::text
         FROM schedule_batches batch
         JOIN clinics clinic ON clinic.id=batch.clinic_id
         JOIN coordinator_schedule_items item ON item.batch_id=batch.id
        WHERE batch.import_group_id=$1`,
      [created.importId],
    );
    expect(child.rows).toEqual([{
      batch_name: importName,
      clinic_code: expectedClinic,
      schedule_type: expectedType,
      target_date: expectedDate,
    }]);
  });

  it("keeps two clinic-suffixed child names within the database limit", async () => {
    const importName = `TEST-GRP ${"😀".repeat(141)}`;
    const submittedByName = "😀".repeat(150);
    expect(Array.from(importName)).toHaveLength(150);
    expect(Array.from(submittedByName)).toHaveLength(150);

    const created = await importStudentScheduleCsv(input(importName, csv({
      studentNumber: "TEST-GRP-LONG-NAME",
      name: "Boundary, Name",
      laboratoryDate: "08-12-2026",
      physicalDate: "08-13-2026",
    }), { submittedByName }), admin);

    const children = await pool.query<{ batch_name: string; clinic_name: string }>(
      `SELECT batch.batch_name, clinic.name AS clinic_name
         FROM schedule_batches batch
         JOIN clinics clinic ON clinic.id=batch.clinic_id
        WHERE batch.import_group_id=$1
        ORDER BY clinic.code`,
      [created.importId],
    );
    expect(children.rows).toHaveLength(2);
    for (const child of children.rows) {
      expect(Array.from(child.batch_name).length).toBeLessThanOrEqual(150);
      expect(child.batch_name).toMatch(new RegExp(` - ${child.clinic_name}$`));
    }
  });

  it("matches normalized canonical components without overwriting the existing student", async () => {
    const importName = "TEST-GRP canonical match";
    const studentNumber = "TEST-GRP-MATCH-001";
    await pool.query(
      `INSERT INTO students (
         student_number, first_name, middle_name, last_name, suffix,
         college_id, program_id, year_level
       ) VALUES ($1,'Ａna','  MARIE  ','O''Neil','',$2,$3,3)`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
    );

    const created = await importStudentScheduleCsv(input(importName, csv({
      studentNumber,
      name: "o'neil, ana marie",
      laboratoryDate: "08-14-2026",
    })), admin);

    expect(created).toMatchObject({ createdStudentCount: 0, matchedStudentCount: 1 });
    const student = await pool.query(
      "SELECT first_name, middle_name, last_name, suffix FROM students WHERE student_number=$1",
      [studentNumber],
    );
    expect(student.rows).toEqual([{
      first_name: "Ａna",
      middle_name: "  MARIE  ",
      last_name: "O'Neil",
      suffix: "",
    }]);
  });

  it("collects component, college, program, and year mismatches before any write", async () => {
    const importName = "TEST-GRP mismatch rollback";
    const studentNumbers = {
      name: "TEST-GRP-MM-N",
      college: "TEST-GRP-MM-C",
      course: "TEST-GRP-MM-P",
      year: "TEST-GRP-MM-Y",
      missing: "TEST-GRP-MM-X",
    };
    await pool.query(
      `INSERT INTO programs (id, college_id, code, name)
       VALUES ($1,$2,'TESTALT','TEST-GRP Alternate Program')`,
      [alternateProgramId, TEST_REFERENCE_IDS.college],
    );
    await pool.query(
      `INSERT INTO students (
         student_number, first_name, last_name, college_id, program_id, year_level
       ) SELECT fixture.student_number, fixture.first_name, fixture.last_name, $2, $3, 4
           FROM (VALUES
             ($1::varchar, 'Correct', 'Name'),
             ($4::varchar, 'College', 'Mismatch'),
             ($5::varchar, 'Course', 'Mismatch'),
             ($6::varchar, 'Year', 'Mismatch')
           ) AS fixture(student_number, first_name, last_name)`,
      [
        studentNumbers.name,
        TEST_REFERENCE_IDS.college,
        TEST_REFERENCE_IDS.program,
        studentNumbers.college,
        studentNumbers.course,
        studentNumbers.year,
      ],
    );

    const contents = csv(
      { studentNumber: studentNumbers.name, name: "Wrong, Person", year: 4, laboratoryDate: "08-15-2026" },
      {
        studentNumber: studentNumbers.college,
        name: "Mismatch, College",
        college: "College of Nursing",
        course: "BSN",
        year: 4,
        laboratoryDate: "08-15-2026",
      },
      {
        studentNumber: studentNumbers.course,
        name: "Mismatch, Course",
        course: "TESTALT",
        year: 4,
        laboratoryDate: "08-15-2026",
      },
      { studentNumber: studentNumbers.year, name: "Mismatch, Year", year: 3, laboratoryDate: "08-15-2026" },
      { studentNumber: studentNumbers.missing, name: "Valid, Missing", year: 3, laboratoryDate: "08-15-2026" },
    );

    await expect(importStudentScheduleCsv(input(importName, contents), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: {
        "rows.2.Name": expect.any(Array),
        "rows.3.College": expect.any(Array),
        "rows.3.Course": expect.any(Array),
        "rows.4.Course": expect.any(Array),
        "rows.5.Year": expect.any(Array),
      },
    });
    expect(await countImportWrites(importName, [studentNumbers.missing])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("collects inactive priority and unknown, inactive, or mismatched references without partial writes", async () => {
    const importName = "TEST-GRP reference rollback";
    const studentNumbers = [
      "TEST-GRP-R-OK",
      "TEST-GRP-R-U",
      "TEST-GRP-R-I",
      "TEST-GRP-R-M",
    ];
    await pool.query(
      "INSERT INTO priority_groups (id, name, rank_order, is_active) VALUES ($1,'TEST-GRP Inactive Priority',1001,FALSE)",
      [inactivePriorityId],
    );
    await pool.query(
      `INSERT INTO programs (id, college_id, code, name, is_active)
       VALUES ($1,$2,'TESTINACTIVE','TEST-GRP Inactive Program',FALSE)`,
      [alternateProgramId, TEST_REFERENCE_IDS.college],
    );

    const contents = csv(
      { studentNumber: studentNumbers[0], name: "Reference, Valid", laboratoryDate: "08-16-2026" },
      {
        studentNumber: studentNumbers[1],
        name: "Reference, Unknown",
        college: "Unknown College",
        course: "NOPE",
        laboratoryDate: "08-16-2026",
      },
      {
        studentNumber: studentNumbers[2],
        name: "Reference, Inactive",
        course: "TESTINACTIVE",
        laboratoryDate: "08-16-2026",
      },
      {
        studentNumber: studentNumbers[3],
        name: "Reference, Mismatch",
        college: "College of Engineering",
        course: "BSIT",
        laboratoryDate: "08-16-2026",
      },
    );

    await expect(importStudentScheduleCsv(input(importName, contents, {
      priorityGroupId: inactivePriorityId,
    }), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      fields: {
        priorityGroupId: expect.any(Array),
        "rows.3.College": expect.any(Array),
        "rows.4.Course": expect.any(Array),
        "rows.5.Course": expect.any(Array),
      },
    });
    expect(await countImportWrites(importName, studentNumbers)).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("supports multiple seeded colleges and programs with null common child references", async () => {
    const importName = "TEST-GRP mixed programs";
    const created = await importStudentScheduleCsv(input(importName, csv(
      {
        studentNumber: "TEST-GRP-MIXED-CCS",
        name: "Studies, Computer",
        laboratoryDate: "08-17-2026",
        physicalDate: "08-18-2026",
      },
      {
        studentNumber: "TEST-GRP-MIXED-CON",
        name: "Nursing, College",
        college: "College of Nursing",
        course: "BSN",
        year: 4,
        laboratoryDate: "08-19-2026",
        physicalDate: "08-20-2026",
      },
    )), admin);

    expect(created).toMatchObject({
      totalRows: 2,
      createdStudentCount: 2,
      laboratoryItemCount: 2,
      physicalExaminationItemCount: 2,
    });
    const children = await pool.query(
      `SELECT college_id, program_id, COUNT(item.id)::int AS item_count
         FROM schedule_batches batch
         JOIN coordinator_schedule_items item ON item.batch_id=batch.id
        WHERE batch.import_group_id=$1
        GROUP BY batch.id
        ORDER BY batch.id`,
      [created.importId],
    );
    expect(children.rows).toEqual([
      { college_id: null, program_id: null, item_count: 2 },
      { college_id: null, program_id: null, item_count: 2 },
    ]);
  });

  it("rejects a non-CSV extension before parsing and leaves no writes", async () => {
    const importName = "TEST-GRP invalid extension";
    const studentNumber = "TEST-GRP-FILE-EXT";
    const contents = csv({ studentNumber, name: "Extension, Invalid", laboratoryDate: "08-21-2026" });
    await expect(importStudentScheduleCsv(input(importName, contents, {
      fileName: "TEST-GRP-schedule.txt",
    }), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { file: expect.any(Array) },
    });
    expect(await countImportWrites(importName, [studentNumber])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("rejects an empty file before parsing and leaves no writes", async () => {
    const importName = "TEST-GRP empty file";
    await expect(importStudentScheduleCsv(input(importName, ""), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { file: expect.any(Array) },
    });
    expect(await countImportWrites(importName, [])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it.each([
    {
      label: "declared size",
      contents: `${header}\nunused`,
      fileSize: maximumFileSize + 1,
    },
    {
      label: "actual byte size",
      contents: new Uint8Array(maximumFileSize + 1),
      fileSize: 1,
    },
  ])("rejects an oversized $label before parsing and leaves no writes", async ({ contents, fileSize }) => {
    const importName = "TEST-GRP oversized file";
    await expect(importStudentScheduleCsv(input(importName, contents, { fileSize }), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { file: expect.any(Array) },
    });
    expect(await countImportWrites(importName, [])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("passes byte input unchanged so fatal UTF-8 decoding remains structured", async () => {
    const importName = "TEST-GRP malformed UTF8";
    await expect(importStudentScheduleCsv(input(importName, new Uint8Array([0xff])), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { file: ["The file must be valid UTF-8."] },
    });
    expect(await countImportWrites(importName, [])).toEqual({
      group_count: 0,
      batch_count: 0,
      student_count: 0,
    });
  });

  it("returns ADMIN import history and detail with metadata, counts, children, and DRAFT status", async () => {
    const importName = "TEST-GRP admin read model";
    const studentNumber = "TEST-GRP-READ-001";
    const created = await importStudentScheduleCsv(input(importName, csv({
      studentNumber,
      name: "Model, Read",
      laboratoryDate: "08-22-2026",
      physicalDate: "08-23-2026",
    })), admin);

    const history = await listScheduleImports(admin);
    expect(history).toContainEqual(expect.objectContaining({
      importId: created.importId,
      importName,
      sourceFilename,
      totalRows: 1,
      createdStudentCount: 1,
      matchedStudentCount: 0,
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 1,
      submittedByName: "Test Registrar",
      description: "Disposable grouped import fixture",
      createdByName: admin.fullName,
      status: "DRAFT",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    }));

    const detail = await getScheduleImport(created.importId, admin);
    expect(detail).toMatchObject({
      importId: created.importId,
      importName,
      status: "DRAFT",
      childBatches: expect.arrayContaining([
        expect.objectContaining({
          clinicCode: "KABALAKA_CLINIC",
          status: "DRAFT",
          validationSummary: null,
          items: [expect.objectContaining({
            studentNumber,
            scheduleType: "LABORATORY",
            targetDate: "2026-08-22",
            validationIssues: [],
          })],
        }),
        expect.objectContaining({
          clinicCode: "CPU_CLINIC",
          status: "DRAFT",
          validationSummary: null,
          items: [expect.objectContaining({
            studentNumber,
            scheduleType: "PHYSICAL_EXAM",
            targetDate: "2026-08-23",
            validationIssues: [],
          })],
        }),
      ]),
    });
    expect(detail.childBatches).toHaveLength(2);
  });

  it("denies clinic staff from history and detail reads", async () => {
    await expect(listScheduleImports(clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(getScheduleImport("not-a-uuid", clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("returns the structured not-found error for an absent import", async () => {
    await expect(getScheduleImport("00000000-0000-4000-8000-000000000099", admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_NOT_FOUND",
      message: "Schedule import not found.",
      status: 404,
    });
  });
});

describe("deriveScheduleImportStatus", () => {
  it("returns a shared recognized status and NEEDS_REVIEW for empty, mixed, or unknown child states", () => {
    for (const status of ["DRAFT", "VALIDATED", "GENERATED", "PUBLISHED", "CANCELLED"] as const) {
      expect(deriveScheduleImportStatus([status, status])).toBe(status);
    }
    expect(deriveScheduleImportStatus([])).toBe("NEEDS_REVIEW");
    expect(deriveScheduleImportStatus(["DRAFT", "VALIDATED"])).toBe("NEEDS_REVIEW");
    expect(deriveScheduleImportStatus(["UNKNOWN", "UNKNOWN"])).toBe("NEEDS_REVIEW");
  });
});
