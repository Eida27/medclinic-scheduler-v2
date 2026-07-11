// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { publishScheduleBatch } from "@/server/services/appointments.service";
import {
  addScheduleBatch,
  editBatch,
  generateBatchAppointments,
  validateBatch,
} from "@/server/services/coordinator-schedules.service";
import {
  generateScheduleImport,
  getScheduleImport,
  importStudentScheduleCsv,
  publishScheduleImport,
  validateScheduleImport,
} from "@/server/services/schedule-imports.service";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";

const header = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
].join(",");

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

const clinicStaff = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
} satisfies SessionUser;

const studentPattern = "TEST-LIFE-%";
const batchPattern = "TEST Lifecycle%";
const importPattern = "TEST Lifecycle%";

function csv(...rows: string[]) {
  return [header, ...rows].join("\n");
}

function importInput(importName: string, rows: string[]) {
  const contents = csv(...rows);
  return {
    fileName: `${importName.replaceAll(" ", "-")}.csv`,
    fileSize: Buffer.byteLength(contents),
    contents,
    importName,
    priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
    submittedByName: "Lifecycle Test",
    description: "Disposable grouped lifecycle fixture",
  };
}

async function cleanup() {
  await pool.query("DROP TRIGGER IF EXISTS test_schedule_import_batch_failure ON schedule_batches");
  await pool.query("DROP TRIGGER IF EXISTS test_schedule_import_appointment_failure ON appointments");
  await pool.query("DROP FUNCTION IF EXISTS test_schedule_import_batch_failure()");
  await pool.query("DROP FUNCTION IF EXISTS test_schedule_import_appointment_failure()");
  await cleanupTestFixtures(studentPattern, batchPattern, importPattern);
}

async function cleanupAndAssertNoResidue() {
  const fixtureIds = await pool.query<{
    group_ids: string[];
    batch_ids: string[];
    appointment_ids: string[];
  }>(
    `SELECT
       COALESCE((SELECT ARRAY_AGG(id::text) FROM schedule_import_groups WHERE import_name LIKE $1), ARRAY[]::text[]) AS group_ids,
       COALESCE((SELECT ARRAY_AGG(id::text) FROM schedule_batches WHERE batch_name LIKE $2), ARRAY[]::text[]) AS batch_ids,
       COALESCE((SELECT ARRAY_AGG(id::text) FROM appointments WHERE student_number LIKE $3), ARRAY[]::text[]) AS appointment_ids`,
    [importPattern, batchPattern, studentPattern],
  );
  await cleanup();
  const ids = fixtureIds.rows[0];
  const residue = await pool.query<{
    group_count: number;
    batch_count: number;
    student_count: number;
    item_count: number;
    appointment_count: number;
    log_count: number;
    audit_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE import_name LIKE $1) AS group_count,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE batch_name LIKE $2) AS batch_count,
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $3) AS student_count,
       (SELECT COUNT(*)::int FROM coordinator_schedule_items WHERE student_number LIKE $3) AS item_count,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE $3) AS appointment_count,
       (SELECT COUNT(*)::int FROM appointment_status_logs WHERE appointment_id::text = ANY($6::text[])) AS log_count,
       (SELECT COUNT(*)::int FROM audit_logs audit
         WHERE audit.entity_id = ANY($4::text[] || $5::text[] || $6::text[])
            OR audit.entity_id LIKE $3
            OR audit.metadata->>'studentNumber' LIKE $3
            OR audit.metadata->>'batchId' = ANY($5::text[])
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(audit.metadata->'batchIds')='array'
                  THEN audit.metadata->'batchIds' ELSE '[]'::jsonb END
              ) AS metadata_batch(id)
              WHERE metadata_batch.id = ANY($5::text[])
            )) AS audit_count`,
    [
      importPattern,
      batchPattern,
      studentPattern,
      ids.group_ids,
      ids.batch_ids,
      ids.appointment_ids,
    ],
  );
  expect(residue.rows[0]).toEqual({
    group_count: 0,
    batch_count: 0,
    student_count: 0,
    item_count: 0,
    appointment_count: 0,
    log_count: 0,
    audit_count: 0,
  });
}

async function childIdsByClinic(importId: string) {
  const children = await pool.query<{ id: string; clinic_code: string }>(
    `SELECT batch.id, clinic.code AS clinic_code
       FROM schedule_batches batch
       JOIN clinics clinic ON clinic.id=batch.clinic_id
      WHERE batch.import_group_id=$1`,
    [importId],
  );
  return new Map(children.rows.map((child) => [child.clinic_code, child.id]));
}

async function failBatchStatus(batchId: string, status: string) {
  await pool.query(`
    CREATE FUNCTION test_schedule_import_batch_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.id = '${batchId}'::uuid AND NEW.status = '${status}' THEN
        RAISE EXCEPTION 'forced grouped batch failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER test_schedule_import_batch_failure
    BEFORE UPDATE OF status ON schedule_batches
    FOR EACH ROW EXECUTE FUNCTION test_schedule_import_batch_failure()
  `);
}

async function failAppointmentInsert(batchId: string) {
  await pool.query(`
    CREATE FUNCTION test_schedule_import_appointment_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.batch_id = '${batchId}'::uuid THEN
        RAISE EXCEPTION 'forced grouped appointment failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER test_schedule_import_appointment_failure
    BEFORE INSERT ON appointments
    FOR EACH ROW EXECUTE FUNCTION test_schedule_import_appointment_failure()
  `);
}

beforeEach(cleanup);
afterEach(cleanupAndAssertNoResidue);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("grouped schedule import lifecycle", () => {
  it("denies clinic staff before validating an import ID", async () => {
    await expect(validateScheduleImport("not-a-uuid", clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(generateScheduleImport("not-a-uuid", clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(publishScheduleImport("not-a-uuid", clinicStaff)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("validates, generates, and publishes both child batches as one lifecycle", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle both", [
      'TEST-LIFE-0001,"Tester, Alice M.",College of Computer Studies,BSIT,3,12-10-2026,12-11-2026',
    ]), admin);

    const validation = await validateScheduleImport(created.importId, admin);
    expect(validation).toMatchObject({
      importId: created.importId,
      status: "VALIDATED",
      totals: { items: 2, valid: 2, warnings: 0, conflicts: 0 },
    });
    expect(validation.clinics.laboratory?.batchId).toBeTruthy();
    expect(validation.clinics.physicalExamination?.batchId).toBeTruthy();
    expect((await getScheduleImport(created.importId, admin)).status).toBe("VALIDATED");

    const generated = await generateScheduleImport(created.importId, admin);
    expect(generated).toEqual({
      importId: created.importId,
      status: "GENERATED",
      batchIds: created.batchIds,
      appointmentCount: 2,
    });
    const drafts = await pool.query(
      `SELECT schedule_type, status, is_published
         FROM appointments
        WHERE batch_id = ANY($1::uuid[])
        ORDER BY schedule_type`,
      [created.batchIds],
    );
    expect(drafts.rows).toEqual([
      { schedule_type: "LABORATORY", status: "DRAFT", is_published: false },
      { schedule_type: "PHYSICAL_EXAM", status: "DRAFT", is_published: false },
    ]);
    const generatedItems = await pool.query<{ status: string }>(
      `SELECT item.status FROM coordinator_schedule_items item
        WHERE item.batch_id = ANY($1::uuid[]) ORDER BY item.schedule_type`,
      [created.batchIds],
    );
    expect(generatedItems.rows.map((row) => row.status)).toEqual(["SCHEDULED", "SCHEDULED"]);

    const published = await publishScheduleImport(created.importId, admin);
    expect(published).toEqual({
      importId: created.importId,
      status: "PUBLISHED",
      batchIds: created.batchIds,
      publishedAppointmentCount: 2,
    });
    const visible = await pool.query(
      `SELECT schedule_type, status, is_published
         FROM appointments
        WHERE batch_id = ANY($1::uuid[])
        ORDER BY schedule_type`,
      [created.batchIds],
    );
    expect(visible.rows).toEqual([
      { schedule_type: "LABORATORY", status: "PENDING", is_published: true },
      { schedule_type: "PHYSICAL_EXAM", status: "PENDING", is_published: true },
    ]);

    const statusLogs = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM appointment_status_logs log
         JOIN appointments appointment ON appointment.id=log.appointment_id
        WHERE appointment.batch_id = ANY($1::uuid[])
          AND log.old_status='DRAFT' AND log.new_status='PENDING'`,
      [created.batchIds],
    );
    expect(statusLogs.rows[0].count).toBe(2);

    const groupAudits = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE entity_type='schedule_import_group' AND entity_id=$1
        ORDER BY created_at`,
      [created.importId],
    );
    expect(groupAudits.rows.map((row) => row.action)).toEqual([
      "SCHEDULE_IMPORT_CREATED",
      "SCHEDULE_IMPORT_VALIDATED",
      "SCHEDULE_IMPORT_GENERATED",
      "SCHEDULE_IMPORT_PUBLISHED",
    ]);
    const childAudits = await pool.query<{ action: string; count: number }>(
      `SELECT action, COUNT(*)::int AS count FROM audit_logs
        WHERE entity_type='schedule_batch' AND entity_id = ANY($1::text[])
          AND action IN (
            'SCHEDULE_BATCH_VALIDATED',
            'APPOINTMENTS_GENERATED',
            'SCHEDULE_BATCH_PUBLISHED'
          )
        GROUP BY action ORDER BY action`,
      [created.batchIds],
    );
    expect(childAudits.rows).toEqual([
      { action: "APPOINTMENTS_GENERATED", count: 2 },
      { action: "SCHEDULE_BATCH_PUBLISHED", count: 2 },
      { action: "SCHEDULE_BATCH_VALIDATED", count: 4 },
    ]);
  });

  it("enforces grouped lifecycle status transitions without partial mutation", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle transitions", [
      'TEST-LIFE-0002,"Tester, Bruno",College of Computer Studies,BSIT,3,12-14-2026,12-15-2026',
    ]), admin);

    await expect(generateScheduleImport(created.importId, admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_INVALID_STATUS",
      status: 409,
    });
    await expect(publishScheduleImport(created.importId, admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_INVALID_STATUS",
      status: 409,
    });
    expect((await getScheduleImport(created.importId, admin)).status).toBe("DRAFT");
    expect((await pool.query("SELECT 1 FROM appointments WHERE batch_id = ANY($1::uuid[])", [created.batchIds])).rowCount).toBe(0);

    await validateScheduleImport(created.importId, admin);
    await generateScheduleImport(created.importId, admin, "Unused override reason");
    const generatedAudit = await pool.query<{ metadata: { overrideReason: string | null } }>(
      `SELECT metadata FROM audit_logs
        WHERE entity_type='schedule_import_group' AND entity_id=$1
          AND action='SCHEDULE_IMPORT_GENERATED'`,
      [created.importId],
    );
    expect(generatedAudit.rows[0].metadata.overrideReason).toBeNull();
    await publishScheduleImport(created.importId, admin);
    await expect(publishScheduleImport(created.importId, admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_INVALID_STATUS",
      status: 409,
    });
  });

  it.each([
    {
      label: "laboratory",
      studentNumber: "TEST-LIFE-0003",
      dates: "12-16-2026,",
    },
    {
      label: "physical examination",
      studentNumber: "TEST-LIFE-0013",
      dates: ",12-17-2026",
    },
  ])("supports a complete $label-only lifecycle", async ({ label, studentNumber, dates }) => {
    const created = await importStudentScheduleCsv(importInput(`TEST Lifecycle ${label}`, [
      `${studentNumber},"Tester, Cara",College of Computer Studies,BSIT,3,${dates}`,
    ]), admin);
    expect(created.batchIds).toHaveLength(1);

    await validateScheduleImport(created.importId, admin);
    const generated = await generateScheduleImport(created.importId, admin);
    expect(generated.appointmentCount).toBe(1);
    const published = await publishScheduleImport(created.importId, admin);
    expect(published.publishedAppointmentCount).toBe(1);
    expect((await getScheduleImport(created.importId, admin)).status).toBe("PUBLISHED");
  });

  it("rejects every direct legacy mutation of a grouped child", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle guards", [
      'TEST-LIFE-0004,"Tester, Diego",College of Computer Studies,BSIT,3,12-17-2026,12-18-2026',
    ]), admin);
    const childId = created.batchIds[0];
    const groupedError = {
      code: "GROUPED_BATCH_ACTION_REQUIRED",
      status: 409,
      message: "This batch belongs to a grouped schedule import. Use the grouped import action instead.",
    };

    await expect(editBatch(childId, undefined, admin.userId)).rejects.toMatchObject(groupedError);
    await expect(validateBatch(childId, admin.userId)).rejects.toMatchObject(groupedError);
    await expect(generateBatchAppointments(childId, admin)).rejects.toMatchObject(groupedError);
    await expect(publishScheduleBatch(childId, admin.userId)).rejects.toMatchObject(groupedError);

    const children = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id",
      [created.importId],
    );
    expect(children.rows.map((row) => row.status)).toEqual(["DRAFT", "DRAFT"]);
    expect((await pool.query("SELECT 1 FROM appointments WHERE batch_id = ANY($1::uuid[])", [created.batchIds])).rowCount).toBe(0);
  });

  it("requires review when child statuses are mixed or a group has no children", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle mixed", [
      'TEST-LIFE-0005,"Tester, Elena",College of Computer Studies,BSIT,3,12-21-2026,12-22-2026',
    ]), admin);
    await pool.query("UPDATE schedule_batches SET status='VALIDATED' WHERE id=$1", [created.batchIds[0]]);

    await expect(validateScheduleImport(created.importId, admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_NEEDS_REVIEW",
      status: 409,
      message: "Schedule import child batches are not synchronized.",
    });

    const empty = await pool.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_by
       ) VALUES ('TEST Lifecycle empty','empty.csv',1,$1)
       RETURNING id`,
      [admin.userId],
    );
    await expect(validateScheduleImport(empty.rows[0].id, admin)).rejects.toMatchObject({
      code: "SCHEDULE_IMPORT_NEEDS_REVIEW",
      status: 409,
    });
  });

  it("requires an administrator reason for a capacity conflict and then generates every child", async () => {
    const original = await pool.query<{
      safe_daily_capacity: number;
      max_daily_capacity: number;
    }>(
      `SELECT safe_daily_capacity, max_daily_capacity
         FROM clinic_capacity_settings
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );
    try {
      const created = await importStudentScheduleCsv(importInput("TEST Lifecycle capacity", [
        'TEST-LIFE-0006,"Tester, Farah",College of Computer Studies,BSIT,3,12-23-2026,12-23-2026',
        'TEST-LIFE-0007,"Tester, Gabe",College of Computer Studies,BSIT,3,12-23-2026,12-23-2026',
      ]), admin);
      const validation = await validateScheduleImport(created.importId, admin);
      expect(validation.totals.conflicts).toBe(2);

      await expect(generateScheduleImport(created.importId, admin)).rejects.toMatchObject({
        code: "OVERRIDE_REASON_REQUIRED",
        status: 422,
      });
      expect((await pool.query(
        "SELECT 1 FROM appointments WHERE batch_id = ANY($1::uuid[])",
        [created.batchIds],
      )).rowCount).toBe(0);

      const generated = await generateScheduleImport(
        created.importId,
        admin,
        "  Approved test capacity exception  ",
      );
      expect(generated.appointmentCount).toBe(4);
      const override = await pool.query<{ override_reason: string | null }>(
        `SELECT override_reason
           FROM schedule_batches
          WHERE import_group_id=$1
          ORDER BY override_reason NULLS LAST`,
        [created.importId],
      );
      expect(override.rows.map((row) => row.override_reason)).toContain("Approved test capacity exception");
      const groupAudit = await pool.query<{ metadata: { overrideReason?: string } }>(
        `SELECT metadata FROM audit_logs
          WHERE entity_type='schedule_import_group' AND entity_id=$1
            AND action='SCHEDULE_IMPORT_GENERATED'`,
        [created.importId],
      );
      expect(groupAudit.rows[0].metadata.overrideReason).toBe("Approved test capacity exception");
    } finally {
      await pool.query(
        `UPDATE clinic_capacity_settings
            SET safe_daily_capacity=$2, max_daily_capacity=$3
          WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          original.rows[0].safe_daily_capacity,
          original.rows[0].max_daily_capacity,
        ],
      );
    }
  });

  it("rolls back an earlier child when a later child has a non-capacity conflict", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle conflict", [
      'TEST-LIFE-0008,"Tester, Hana",College of Computer Studies,BSIT,3,12-28-2026,12-29-2026',
    ]), admin);
    await validateScheduleImport(created.importId, admin);
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,'TEST-LIFE-0008','PHYSICAL_EXAM','2027-01-04','PENDING',TRUE,$2,$2)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, admin.userId],
    );

    await expect(generateScheduleImport(created.importId, admin)).rejects.toMatchObject({
      code: "BATCH_CONFLICTS",
      status: 409,
    });
    const state = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id",
      [created.importId],
    );
    expect(state.rows.map((row) => row.status)).toEqual(["VALIDATED", "VALIDATED"]);
    expect((await pool.query(
      "SELECT 1 FROM appointments WHERE batch_id = ANY($1::uuid[])",
      [created.batchIds],
    )).rowCount).toBe(0);
  });

  it("rolls back every validation write when the second child fails", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle validate rollback", [
      'TEST-LIFE-0009,"Tester, Inez",College of Computer Studies,BSIT,3,12-30-2026,12-31-2026',
    ]), admin);
    const ids = await childIdsByClinic(created.importId);
    await failBatchStatus(String(ids.get("CPU_CLINIC")), "VALIDATED");
    try {
      await expect(validateScheduleImport(created.importId, admin)).rejects.toThrow(
        "forced grouped batch failure",
      );
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_schedule_import_batch_failure ON schedule_batches");
      await pool.query("DROP FUNCTION IF EXISTS test_schedule_import_batch_failure()");
    }

    const batches = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id",
      [created.importId],
    );
    expect(batches.rows.map((row) => row.status)).toEqual(["DRAFT", "DRAFT"]);
    const items = await pool.query<{ status: string }>(
      `SELECT item.status FROM coordinator_schedule_items item
        JOIN schedule_batches batch ON batch.id=item.batch_id
       WHERE batch.import_group_id=$1`,
      [created.importId],
    );
    expect(items.rows.map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    expect((await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_type='schedule_import_group'
        AND entity_id=$1 AND action='SCHEDULE_IMPORT_VALIDATED'`,
      [created.importId],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_type='schedule_batch'
        AND entity_id = ANY($1::text[]) AND action='SCHEDULE_BATCH_VALIDATED'`,
      [created.batchIds],
    )).rowCount).toBe(0);
  });

  it("rolls back every generated appointment and audit when the second child fails", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle generate rollback", [
      'TEST-LIFE-0010,"Tester, Jules",College of Computer Studies,BSIT,3,01-04-2027,01-05-2027',
    ]), admin);
    await validateScheduleImport(created.importId, admin);
    const ids = await childIdsByClinic(created.importId);
    await failAppointmentInsert(String(ids.get("CPU_CLINIC")));
    try {
      await expect(generateScheduleImport(created.importId, admin)).rejects.toThrow(
        "forced grouped appointment failure",
      );
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_schedule_import_appointment_failure ON appointments");
      await pool.query("DROP FUNCTION IF EXISTS test_schedule_import_appointment_failure()");
    }

    const batches = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id",
      [created.importId],
    );
    expect(batches.rows.map((row) => row.status)).toEqual(["VALIDATED", "VALIDATED"]);
    expect((await pool.query(
      "SELECT 1 FROM appointments WHERE batch_id = ANY($1::uuid[])",
      [created.batchIds],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_type='schedule_import_group'
        AND entity_id=$1 AND action='SCHEDULE_IMPORT_GENERATED'`,
      [created.importId],
    )).rowCount).toBe(0);
    const childAudits = await pool.query<{ action: string; count: number }>(
      `SELECT action, COUNT(*)::int AS count FROM audit_logs
        WHERE entity_type='schedule_batch' AND entity_id = ANY($1::text[])
          AND action IN ('SCHEDULE_BATCH_VALIDATED','APPOINTMENTS_GENERATED')
        GROUP BY action ORDER BY action`,
      [created.batchIds],
    );
    expect(childAudits.rows).toEqual([
      { action: "SCHEDULE_BATCH_VALIDATED", count: 2 },
    ]);
  });

  it("rolls back appointments, logs, batch statuses, and audits when the second publish fails", async () => {
    const created = await importStudentScheduleCsv(importInput("TEST Lifecycle publish rollback", [
      'TEST-LIFE-0011,"Tester, Kira",College of Computer Studies,BSIT,3,01-06-2027,01-07-2027',
    ]), admin);
    await validateScheduleImport(created.importId, admin);
    await generateScheduleImport(created.importId, admin);
    const ids = await childIdsByClinic(created.importId);
    await failBatchStatus(String(ids.get("CPU_CLINIC")), "PUBLISHED");
    try {
      await expect(publishScheduleImport(created.importId, admin)).rejects.toThrow(
        "forced grouped batch failure",
      );
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_schedule_import_batch_failure ON schedule_batches");
      await pool.query("DROP FUNCTION IF EXISTS test_schedule_import_batch_failure()");
    }

    const batches = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id",
      [created.importId],
    );
    expect(batches.rows.map((row) => row.status)).toEqual(["GENERATED", "GENERATED"]);
    const appointments = await pool.query<{ status: string; is_published: boolean }>(
      `SELECT status, is_published FROM appointments
        WHERE batch_id = ANY($1::uuid[]) ORDER BY batch_id`,
      [created.batchIds],
    );
    expect(appointments.rows).toEqual([
      { status: "DRAFT", is_published: false },
      { status: "DRAFT", is_published: false },
    ]);
    expect((await pool.query(
      `SELECT 1 FROM appointment_status_logs log
        JOIN appointments appointment ON appointment.id=log.appointment_id
       WHERE appointment.batch_id = ANY($1::uuid[])`,
      [created.batchIds],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_type='schedule_import_group'
        AND entity_id=$1 AND action='SCHEDULE_IMPORT_PUBLISHED'`,
      [created.importId],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_logs WHERE entity_type='schedule_batch'
        AND entity_id = ANY($1::text[]) AND action='SCHEDULE_BATCH_PUBLISHED'`,
      [created.batchIds],
    )).rowCount).toBe(0);
  });

  it("preserves the complete legacy lifecycle for an ungrouped batch", async () => {
    await insertTestStudent({
      studentNumber: "TEST-LIFE-0012",
      firstName: "Legacy",
      lastName: "Tester",
      yearLevel: 3,
    });
    const batch = await addScheduleBatch({
      clinicCode: "KABALAKA_CLINIC",
      batchName: "TEST Lifecycle legacy ungrouped",
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      submittedByName: "Lifecycle Test",
      description: null,
      items: [{
        studentNumber: "TEST-LIFE-0012",
        scheduleType: "LABORATORY",
        priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
        targetDate: "2027-01-08",
        targetWeekStart: null,
        targetWeekEnd: null,
        remarks: null,
      }],
    }, admin);
    expect(batch?.importGroupId).toBeNull();
    await validateBatch(String(batch?.id), admin.userId);
    await generateBatchAppointments(String(batch?.id), admin);
    await publishScheduleBatch(String(batch?.id), admin.userId);
    const state = await pool.query<{ status: string }>(
      "SELECT status FROM schedule_batches WHERE id=$1",
      [batch?.id],
    );
    expect(state.rows[0].status).toBe("PUBLISHED");
  });
});
