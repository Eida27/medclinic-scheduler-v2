// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { importStudentScheduleCsv } from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-91%";
const importPattern = "REGULAR 2026-2027 - TEST-AY%";
const sourceFilename = "TEST-AY-students.csv";

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

function csv(...rows: string[]) {
  return [header, ...rows].join("\n");
}

function input(contents: string, overrides: Record<string, unknown> = {}) {
  return {
    fileName: sourceFilename,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: "REGULAR",
    academicYearStart: 2026,
    preferredMonth: null,
    ...overrides,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("student scheduling imports", () => {
  it("denies clinic staff before parsing input", async () => {
    await expect(importStudentScheduleCsv(undefined, clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("upserts demographics in bulk and preserves an existing same-cycle appointment", async () => {
    const existingStudentNumber = "99-9101-01";
    const newStudentNumber = "99-9102-02";
    await insertTestStudent({
      studentNumber: existingStudentNumber,
      firstName: "Old",
      middleName: null,
      lastName: "Profile",
      suffix: null,
      yearLevel: 1,
      dateOfBirth: "2000-01-01",
    });
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date, status,
         is_published, created_by, schedule_pair_id, schedule_cycle_start
       ) VALUES ($1,$2,'LABORATORY','2026-09-15','PENDING',TRUE,$3,gen_random_uuid(),2026)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, existingStudentNumber, TEST_REFERENCE_IDS.adminUser],
    );

    const contents = csv(
      `${existingStudentNumber},Updated,Alex,Q.,Jr.,College of Computer Studies,BSIT,4,05-06-2003`,
      `${newStudentNumber},New,Bea,,,College of Computer Studies,BSIT,3,07-08-2004`,
    );
    const created = await importStudentScheduleCsv(input(contents), admin);

    expect(created).toEqual({
      importId: expect.any(String),
      status: "DRAFT",
      totalRows: 2,
      insertedStudentCount: 1,
      updatedStudentCount: 1,
      skippedStudentCount: 1,
      laboratoryItemCount: 0,
      physicalExaminationItemCount: 0,
      batchIds: [],
    });
    const students = await pool.query(
      `SELECT student_number, first_name, middle_name, last_name, suffix,
              year_level, date_of_birth::text
         FROM students WHERE student_number = ANY($1::varchar[])
        ORDER BY student_number`,
      [[existingStudentNumber, newStudentNumber]],
    );
    expect(students.rows).toEqual([
      {
        student_number: existingStudentNumber,
        first_name: "Alex",
        middle_name: "Q.",
        last_name: "Updated",
        suffix: "Jr.",
        year_level: 4,
        date_of_birth: "2003-05-06",
      },
      {
        student_number: newStudentNumber,
        first_name: "Bea",
        middle_name: null,
        last_name: "New",
        suffix: null,
        year_level: 3,
        date_of_birth: "2004-07-08",
      },
    ]);
    const unchanged = await pool.query(
      "SELECT appointment_date::text, status FROM appointments WHERE id=$1",
      [appointment.rows[0].id],
    );
    expect(unchanged.rows).toEqual([{ appointment_date: "2026-09-15", status: "PENDING" }]);

    const group = await pool.query(
      `SELECT student_category, academic_year_start, preferred_month,
              accepted_at IS NOT NULL AS accepted
         FROM schedule_import_groups WHERE id=$1`,
      [created.importId],
    );
    expect(group.rows).toEqual([{
      student_category: "REGULAR",
      academic_year_start: 2026,
      preferred_month: null,
      accepted: true,
    }]);
  });

  it("rolls back all writes when a reference is unknown", async () => {
    const studentNumber = "99-9103-03";
    const contents = csv(
      `${studentNumber},Invalid,Reference,,,Unknown College,BSIT,3,05-06-2003`,
    );

    await expect(importStudentScheduleCsv(input(contents), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { "rows.2.College": expect.any(Array) },
    });
    const writes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$2) AS imports`,
      [studentNumber, sourceFilename],
    );
    expect(writes.rows[0]).toEqual({ students: 0, imports: 0 });
  });

  it("requires preferred month only for priority categories", async () => {
    const contents = csv(
      "99-9104-04,Priority,Student,,,College of Computer Studies,BSIT,3,05-06-2003",
    );
    await expect(importStudentScheduleCsv(input(contents, {
      studentCategory: "OJT",
      preferredMonth: null,
    }), admin)).rejects.toMatchObject({ name: "ZodError" });
    await expect(importStudentScheduleCsv(input(contents, {
      preferredMonth: 9,
    }), admin)).rejects.toMatchObject({ name: "ZodError" });
  });
});
