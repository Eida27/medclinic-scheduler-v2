// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import {
  acceptAndScheduleImport,
  preflightScheduleImport,
} from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-91%";
const importPattern = "% - TEST-AY%";
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
  await pool.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
  await pool.query("DELETE FROM student_academic_snapshots WHERE student_number LIKE $1", [studentPattern]);
  await pool.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-AY%')`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-AY%'");
  await pool.query("DELETE FROM academic_years WHERE start_year=2098");
}

async function insertHorizonTestAcademicYear(closingDate: string) {
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2098,$1,$2,$2)`,
    [closingDate, TEST_REFERENCE_IDS.adminUser],
  );
}

async function blockHorizonTestStartDate() {
  await pool.query(
    `WITH closure AS (
       INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES (
         '2098-08-01','2098-08-01','CLOSURE',
         'TEST-AY Standard horizon boundary',$1,gen_random_uuid()
       )
       RETURNING id
     )
     INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
     SELECT id,'2098-08-01' FROM closure`,
    [TEST_REFERENCE_IDS.adminUser],
  );
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2026,'2027-07-31',$1,$1),(2027,'2028-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING`,
    [TEST_REFERENCE_IDS.adminUser],
  );
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("student scheduling imports", () => {
  it("denies clinic staff before parsing input", async () => {
    await expect(acceptAndScheduleImport(undefined, clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("preflights a valid combination without database writes", async () => {
    const studentNumber = "99-9190-90";
    const contents = csv(
      `${studentNumber},Preflight,Valid,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    );

    await expect(preflightScheduleImport(input(contents), admin)).resolves.toEqual({ valid: true });
    const writes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$2) AS imports,
         (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS appointments`,
      [studentNumber, sourceFilename],
    );
    expect(writes.rows[0]).toEqual({ students: 0, imports: 0, appointments: 0 });
  });

  it("rejects a direct final wrong-category import before database writes", async () => {
    const studentNumber = "99-9191-91";
    const contents = csv(
      `${studentNumber},Final,Rejected,Maria Angela,,College of Computer Studies,BSIT,4,2003-05-06`,
    );

    await expect(acceptAndScheduleImport(input(contents), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: {
        studentCategory: [
          "This CSV contains Year 4 students. Year 4 students can only be imported as OJT.",
        ],
      },
    });
    const writes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$2) AS imports,
         (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS appointments`,
      [studentNumber, sourceFilename],
    );
    expect(writes.rows[0]).toEqual({ students: 0, imports: 0, appointments: 0 });
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
      `${existingStudentNumber},Updated,Alex,Q.,Jr.,College of Computer Studies,BSIT,3,2003-05-06`,
      `${newStudentNumber},New,Bea,Rosa,,College of Computer Studies,BSIT,3,2004-07-08`,
    );
    const created = await acceptAndScheduleImport(input(contents), admin);

    expect(created).toEqual({
      importId: expect.any(String),
      outcome: "PUBLISHED",
      status: "PUBLISHED",
      totalRows: 2,
      insertedStudentCount: 1,
      updatedStudentCount: 1,
      skippedStudentCount: 1,
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 1,
      publishedAppointmentCount: 2,
      generatedRange: { startDate: expect.any(String), endDate: expect.any(String) },
      overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
      displacementTotal: 0,
      batchIds: [expect.any(String), expect.any(String)],
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
        year_level: 3,
        date_of_birth: "2003-05-06",
      },
      {
        student_number: newStudentNumber,
        first_name: "Bea",
        middle_name: "Rosa",
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
    const lineage = await pool.query(
      `SELECT appointment.schedule_type,
              appointment.scheduling_category,
              appointment.scheduling_accepted_at=import.accepted_at AS accepted_matches,
              appointment.scheduling_source_row_order,
              appointment.scheduling_window_start IS NOT NULL AS has_window_start,
              appointment.scheduling_window_end::text
         FROM appointments appointment
         JOIN schedule_import_groups import ON import.id=$2
        WHERE appointment.student_number=$1
        ORDER BY appointment.schedule_type`,
      [newStudentNumber, created.importId],
    );
    expect(lineage.rows).toEqual([
      {
        schedule_type: "LABORATORY",
        scheduling_category: "REGULAR",
        accepted_matches: true,
        scheduling_source_row_order: 2,
        has_window_start: true,
        scheduling_window_end: "2027-03-31",
      },
      {
        schedule_type: "PHYSICAL_EXAM",
        scheduling_category: "REGULAR",
        accepted_matches: true,
        scheduling_source_row_order: 2,
        has_window_start: true,
        scheduling_window_end: "2027-03-31",
      },
    ]);
    const publishedPair = await pool.query<{
      schedule_type: string;
      appointment_date: string;
      status: string;
      is_published: boolean;
    }>(
      `SELECT schedule_type,appointment_date::text,status,is_published
         FROM appointments
        WHERE student_number=$1
        ORDER BY appointment_date,schedule_type`,
      [newStudentNumber],
    );
    expect(publishedPair.rows).toEqual([
      expect.objectContaining({ schedule_type: "LABORATORY", status: "PENDING", is_published: true }),
      expect.objectContaining({ schedule_type: "PHYSICAL_EXAM", status: "PENDING", is_published: true }),
    ]);
    expect(publishedPair.rows[0].appointment_date < publishedPair.rows[1].appointment_date).toBe(true);
    const snapshots = await pool.query(
      `SELECT student_number,student_name,college_name,program_code,program_name,
              year_level,source_import_group_id::text
         FROM student_academic_snapshots
        WHERE student_number=ANY($1::varchar[]) AND academic_year_start=2026
        ORDER BY student_number`,
      [[existingStudentNumber, newStudentNumber]],
    );
    expect(snapshots.rows).toEqual([
      {
        student_number: existingStudentNumber,
        student_name: "Updated, Alex Q. (Jr.)",
        college_name: "College of Computer Studies",
        program_code: "BSIT",
        program_name: "Bachelor of Science in Information Technology",
        year_level: 3,
        source_import_group_id: created.importId,
      },
      {
        student_number: newStudentNumber,
        student_name: "New, Bea Rosa",
        college_name: "College of Computer Studies",
        program_code: "BSIT",
        program_name: "Bachelor of Science in Information Technology",
        year_level: 3,
        source_import_group_id: created.importId,
      },
    ]);
    await pool.query(
      `UPDATE students SET college_id=$2,program_id=$3,year_level=4
        WHERE student_number=$1`,
      [newStudentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
    );
    const historicalAfterProfileEdit = await pool.query(
      `SELECT student_name,college_name,program_code,year_level
         FROM student_academic_snapshots WHERE student_number=$1 AND academic_year_start=2026`,
      [newStudentNumber],
    );
    expect(historicalAfterProfileEdit.rows).toEqual([{
      student_name: "New, Bea Rosa",
      college_name: "College of Computer Studies",
      program_code: "BSIT",
      year_level: 3,
    }]);
  });

  it("commits a snapshot-conflict audit without changing the profile or appointments", async () => {
    const studentNumber = "99-9107-07";
    await insertTestStudent({
      studentNumber,
      firstName: "Original",
      middleName: "Maria",
      lastName: "Profile",
      suffix: null,
      yearLevel: 2,
      dateOfBirth: "2003-05-06",
    });
    const fixtureImport = await pool.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (
         import_name,source_filename,total_rows,created_by,student_category,
         academic_year_start,accepted_at
       ) VALUES ('REGULAR 2026-2027 - TEST-AY snapshot conflict.csv',
                 'TEST-AY-snapshot-conflict.csv',1,$1,'REGULAR',2026,clock_timestamp())
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.adminUser],
    );
    await pool.query(
      `INSERT INTO student_academic_snapshots (
         student_number,academic_year_start,student_name,college_id,college_name,
         program_id,program_code,program_name,year_level,source_import_group_id
       ) VALUES (
         $1,2026,'Profile, Original Maria',$2,'College of Computer Studies',
         $3,'BSIT','Bachelor of Science in Information Technology',2,$4
       ) ON CONFLICT (student_number,academic_year_start) DO NOTHING`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, fixtureImport.rows[0].id],
    );

    const auditBefore = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE action='SNAPSHOT_CONFLICT_DETECTED' AND entity_id=$1`,
      [`${studentNumber}:2026`],
    );
    const attemptedImportCountBefore = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM schedule_import_groups
        WHERE source_filename=$1 AND academic_year_start=2026`,
      [sourceFilename],
    );
    await expect(acceptAndScheduleImport(input(csv(
      `${studentNumber},Changed,Student,Maria Angela,,College of Computer Studies,BSIT,3,2004-06-07`,
    )), admin)).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
      status: 409,
    });

    const state = await pool.query(
      `SELECT first_name,middle_name,last_name,year_level,date_of_birth::text,
              (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS appointments
         FROM students WHERE student_number=$1`,
      [studentNumber],
    );
    expect(state.rows).toEqual([{
      first_name: "Original",
      middle_name: "Maria",
      last_name: "Profile",
      year_level: 2,
      date_of_birth: "2003-05-06",
      appointments: 0,
    }]);
    const auditAfter = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE action='SNAPSHOT_CONFLICT_DETECTED' AND entity_id=$1`,
      [`${studentNumber}:2026`],
    );
    expect(auditAfter.rows[0].count).toBe(auditBefore.rows[0].count + 1);
    const attemptedImportCountAfter = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM schedule_import_groups
        WHERE source_filename=$1 AND academic_year_start=2026`,
      [sourceFilename],
    );
    expect(attemptedImportCountAfter.rows).toEqual(attemptedImportCountBefore.rows);
  });

  it("requires an academic year configuration before writing an import", async () => {
    const studentNumber = "99-9108-08";
    await expect(acceptAndScheduleImport(input(csv(
      `${studentNumber},Missing,Year,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    ), { academicYearStart: 2099 }), admin)).rejects.toMatchObject({
      code: "ACADEMIC_YEAR_NOT_CONFIGURED",
      status: 409,
    });
    const writes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE academic_year_start=2099) AS imports`,
      [studentNumber],
    );
    expect(writes.rows[0]).toEqual({ students: 0, imports: 0 });
  });

  it("allows a Standard pair whose Physical Examination lands exactly on the cycle closing date", async () => {
    const studentNumber = "99-9192-92";
    await insertHorizonTestAcademicYear("2098-08-05");
    await blockHorizonTestStartDate();

    const created = await acceptAndScheduleImport(input(csv(
      `${studentNumber},Boundary,Inclusive,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    ), { academicYearStart: 2098 }), admin);

    expect(created).toMatchObject({
      outcome: "PUBLISHED",
      generatedRange: { startDate: "2098-08-04", endDate: "2098-08-05" },
    });

    const appointments = await pool.query<{
      schedule_type: string;
      appointment_date: string;
    }>(
      `SELECT schedule_type,appointment_date::text
         FROM appointments
        WHERE student_number=$1 AND status='PENDING'
        ORDER BY appointment_date,schedule_type`,
      [studentNumber],
    );

    expect(appointments.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2098-08-04" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2098-08-05" },
    ]);
  });

  it("rejects a Standard import when the complete pair cannot fit by the cycle closing date", async () => {
    const studentNumber = "99-9193-93";
    await insertHorizonTestAcademicYear("2098-08-04");
    await blockHorizonTestStartDate();

    await expect(acceptAndScheduleImport(input(csv(
      `${studentNumber},Boundary,Exhausted,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    ), { academicYearStart: 2098 }), admin)).rejects.toMatchObject({
      code: "SCHEDULE_CAPACITY_EXHAUSTED",
      status: 409,
    });

    const writes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
         (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number=$1) AS snapshots,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE academic_year_start=2098) AS imports,
         (SELECT COUNT(*)::int FROM schedule_batches
           WHERE import_group_id IN (
             SELECT id FROM schedule_import_groups WHERE academic_year_start=2098
           )) AS batches,
         (SELECT COUNT(*)::int FROM coordinator_schedule_items WHERE student_number=$1) AS items,
         (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS appointments,
         (SELECT COUNT(*)::int FROM audit_logs
           WHERE action='SCHEDULE_IMPORT_PUBLISHED'
             AND metadata->>'sourceFilename'=$2
             AND metadata->>'academicYearStart'='2098') AS publication_audits,
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=$1) AS notifications,
         (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=$1) AS email_outbox`,
      [studentNumber, sourceFilename],
    );

    expect(writes.rows[0]).toEqual({
      students: 0,
      snapshots: 0,
      imports: 0,
      batches: 0,
      items: 0,
      appointments: 0,
      publication_audits: 0,
      notifications: 0,
      email_outbox: 0,
    });
  });

  it("rolls back all writes when a reference is unknown", async () => {
    const studentNumber = "99-9103-03";
    const contents = csv(
      `${studentNumber},Invalid,Reference,Maria Angela,,Unknown College,BSIT,3,2003-05-06`,
    );

    await expect(acceptAndScheduleImport(input(contents), admin)).rejects.toMatchObject({
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

  it("requires preferred month only for OJT and Tour categories", async () => {
    const contents = csv(
      "99-9104-04,Priority,Student,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06",
    );
    await expect(acceptAndScheduleImport(input(contents, {
      studentCategory: "OJT",
      preferredMonth: null,
    }), admin)).rejects.toMatchObject({ name: "ZodError" });
    await expect(acceptAndScheduleImport(input(contents, {
      preferredMonth: 9,
    }), admin)).rejects.toMatchObject({ name: "ZodError" });
  });

  it.each([
    { category: "OJT" as const, yearLevel: 4, preferredMonth: 9, studentNumber: "99-9106-06" },
    { category: "TOUR" as const, yearLevel: 3, preferredMonth: 10, studentNumber: "99-9107-07" },
  ])("publishes an atomic Standard $category import", async ({
    category,
    yearLevel,
    preferredMonth,
    studentNumber,
  }) => {
    const contents = csv(
      `${studentNumber},${category},Student,Maria Angela,,College of Computer Studies,BSIT,${yearLevel},2003-05-06`,
    );

    await expect(acceptAndScheduleImport(input(contents, {
      studentCategory: category,
      preferredMonth,
    }), admin)).resolves.toMatchObject({
      outcome: "PUBLISHED",
      status: "PUBLISHED",
      publishedAppointmentCount: 2,
    });
    await expect(pool.query(
      `SELECT schedule_type,scheduling_category,is_published
         FROM appointments
        WHERE student_number=$1
        ORDER BY schedule_type`,
      [studentNumber],
    )).resolves.toMatchObject({
      rows: [
        { schedule_type: "LABORATORY", scheduling_category: category, is_published: true },
        { schedule_type: "PHYSICAL_EXAM", scheduling_category: category, is_published: true },
      ],
    });
  });

  it("uses a soft-unblocked Laboratory date for import allocation", async () => {
    const studentNumber = "99-9105-05";
    await pool.query(
      `WITH closure AS (
         INSERT INTO clinic_closure_groups (
           start_date,end_date,category,reason,created_by,creation_batch_id
         ) VALUES ('2027-08-02','2027-08-02','CLOSURE',
                   'TEST-AY soft-unblocked allocation',$1,gen_random_uuid())
         RETURNING id
       )
       INSERT INTO clinic_unavailable_dates (
         closure_group_id,blocked_date,reopened_at,reopened_by,reopening_batch_id
       ) SELECT id,'2027-08-02',NOW(),$1,gen_random_uuid() FROM closure`,
      [TEST_REFERENCE_IDS.adminUser],
    );

    await acceptAndScheduleImport(input(csv(
      `${studentNumber},Unblocked,Import,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    ), { academicYearStart: 2027 }), admin);

    const laboratory = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number=$1
          AND schedule_type='LABORATORY'
          AND status='PENDING'`,
      [studentNumber],
    );
    expect(laboratory.rows).toEqual([{ appointment_date: "2027-08-02" }]);
  });

  it("uses the unified active-date set for both clinic allocations", async () => {
    const studentNumber = "99-9106-06";
    await pool.query(
      `WITH closure AS (
         INSERT INTO clinic_closure_groups (
           start_date,end_date,category,reason,created_by,creation_batch_id
         ) VALUES ('2027-08-02','2027-08-02','CLOSURE',
                   'TEST-AY unified active allocation',$1,gen_random_uuid())
         RETURNING id
       )
       INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
       SELECT id,'2027-08-02' FROM closure`,
      [TEST_REFERENCE_IDS.adminUser],
    );

    await acceptAndScheduleImport(input(csv(
      `${studentNumber},Blocked,Import,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
    ), { academicYearStart: 2027 }), admin);

    const appointments = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type,appointment_date::text
         FROM appointments
        WHERE student_number=$1 AND status='PENDING'
        ORDER BY schedule_type`,
      [studentNumber],
    );
    expect(appointments.rows.every((appointment) => appointment.appointment_date !== "2027-08-02")).toBe(true);
  });
});
