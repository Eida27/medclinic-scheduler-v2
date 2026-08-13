// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";
import {
  acceptAndScheduleImport,
  getScheduleImport,
  reviewFirstYearScheduleImport,
} from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";
const sourceFilename = "TEST-FIRST-YEAR-2095.csv";
const studentPattern = "95-81%";
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};
let originalCapacity = 0;

function csvRows(year = 1) {
  return [
    header,
    `95-8101-01,Alpha,Ana,Maria,,College of Computer Studies,BSIT,${year},2006-01-01`,
    "95-8102-01,Beta,Bea,Maria,,College of Computer Studies,BSIT,1,2006-01-02",
    "95-8103-01,Gamma,Gia,Maria,,College of Computer Studies,BSIT,1,2006-01-03",
    "95-8104-01,Delta,Dina,Maria,,College of Engineering,BSCE,1,2006-01-04",
  ].join("\n");
}

function input(contents = csvRows()) {
  return {
    fileName: sourceFilename,
    fileSize: Buffer.byteLength(contents),
    contents,
    importMode: "FIRST_YEAR_OVPSA",
    studentCategory: "REGULAR",
    academicYearStart: 2095,
    preferredMonth: null,
    firstYearLaboratoryDate: "2095-09-22",
  };
}

async function cleanup() {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TEMP TABLE first_year_test_imports ON COMMIT DROP AS
       SELECT id FROM schedule_import_groups WHERE source_filename=$1`,
      [sourceFilename],
    );
    await client.query(
      `CREATE TEMP TABLE first_year_test_batches ON COMMIT DROP AS
       SELECT id FROM ovpsa_first_year_batches
        WHERE source_import_group_id IN (SELECT id FROM first_year_test_imports)`,
    );
    await client.query(
      `CREATE TEMP TABLE first_year_test_schedule_batches ON COMMIT DROP AS
       SELECT id FROM schedule_batches
        WHERE import_group_id IN (SELECT id FROM first_year_test_imports)`,
    );
    await client.query(
      `CREATE TEMP TABLE first_year_test_appointments ON COMMIT DROP AS
       SELECT id FROM appointments
        WHERE ovpsa_batch_id IN (SELECT id FROM first_year_test_batches)
           OR batch_id IN (SELECT id FROM first_year_test_schedule_batches)
           OR student_number LIKE $1`,
      [studentPattern],
    );
    await client.query(
      `DELETE FROM appointment_reschedule_event_unavailable_dates
        WHERE event_id IN (
          SELECT id FROM appointment_reschedule_events
           WHERE ovpsa_batch_id IN (SELECT id FROM first_year_test_batches)
              OR student_number LIKE $1
        )`,
      [studentPattern],
    );
    await client.query(
      `DELETE FROM appointment_reschedule_events
        WHERE ovpsa_batch_id IN (SELECT id FROM first_year_test_batches)
           OR student_number LIKE $1`,
      [studentPattern],
    );
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM first_year_test_appointments)");
    await client.query("DELETE FROM appointments WHERE id IN (SELECT id FROM first_year_test_appointments)");
    await client.query("DELETE FROM coordinator_schedule_items WHERE batch_id IN (SELECT id FROM first_year_test_schedule_batches) OR student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM schedule_batches WHERE id IN (SELECT id FROM first_year_test_schedule_batches)");
    await client.query("DELETE FROM ovpsa_external_laboratory_verifications WHERE batch_id IN (SELECT id FROM first_year_test_batches)");
    await client.query("DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id IN (SELECT id FROM first_year_test_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id IN (SELECT id FROM first_year_test_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM first_year_test_batches)");
    await client.query("UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id IN (SELECT id FROM first_year_test_batches)");
    await client.query("DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM first_year_test_batches)");
    await client.query("DELETE FROM ovpsa_first_year_batches WHERE id IN (SELECT id FROM first_year_test_batches)");
    await client.query("DELETE FROM student_portal_notifications WHERE student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM email_outbox WHERE student_number LIKE $1", [studentPattern]);
    await client.query(
      `DELETE FROM audit_logs
        WHERE entity_id IN (SELECT id::text FROM first_year_test_imports)
           OR entity_id IN (SELECT id::text FROM first_year_test_batches)
           OR metadata->>'importId' IN (SELECT id::text FROM first_year_test_imports)
           OR metadata->>'studentNumber' LIKE $1`,
      [studentPattern],
    );
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM first_year_test_imports)");
    await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM student_academic_snapshots WHERE student_number LIKE $1", [studentPattern]);
    await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM students WHERE student_number LIKE $1", [studentPattern]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await pool.query(await readFile(join(
    process.cwd(),
    "database/migrations/020_first_year_schedule_import_consolidation.sql",
  ), "utf8"));
  await cleanup();
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2095,'2096-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  const capacity = await pool.query<{ max_daily_capacity: number }>(
    `SELECT max_daily_capacity FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM'`,
    [TEST_REFERENCE_IDS.physicalExamClinic],
  );
  originalCapacity = capacity.rows[0].max_daily_capacity;
  await pool.query(
    `UPDATE clinic_capacity_settings SET safe_daily_capacity=3,max_daily_capacity=3
      WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM'`,
    [TEST_REFERENCE_IDS.physicalExamClinic],
  );
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.query(
    `UPDATE clinic_capacity_settings SET safe_daily_capacity=$2,max_daily_capacity=$2
      WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM'`,
    [TEST_REFERENCE_IDS.physicalExamClinic, originalCapacity],
  );
  await pool.end();
});

describe("First Year schedule imports", () => {
  it("reviews without writes and publishes one atomic multi-date import in CSV order", async () => {
    const review = await reviewFirstYearScheduleImport(input(), admin);
    expect(review).toMatchObject({
      sourceFilename,
      memberCount: 4,
      academicYearStart: 2095,
      laboratory: { date: "2095-09-22", locationName: "Iloilo Mission Hospital" },
      firstPhysicalExamCandidate: "2095-09-29",
      physicalExamMaximumCapacity: 3,
      allocations: [
        { date: "2095-09-29", studentCount: 3, capacity: 3 },
        { date: "2095-09-30", studentCount: 1, capacity: 3 },
      ],
      canPublish: true,
    });
    const before = await pool.query<{ imports: number; students: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$1) AS imports,
         (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $2) AS students`,
      [sourceFilename, studentPattern],
    );
    expect(before.rows[0]).toEqual({ imports: 0, students: 0 });

    const published = await acceptAndScheduleImport(input(), admin);
    expect(published).toMatchObject({
      outcome: "PUBLISHED",
      status: "PUBLISHED",
      totalRows: 4,
      laboratoryItemCount: 4,
      physicalExaminationItemCount: 4,
      publishedAppointmentCount: 8,
      displacementTotal: 0,
      firstYearSummary: {
        firstPhysicalExamCandidate: "2095-09-29",
        allocations: [
          { date: "2095-09-29", studentCount: 3, capacity: 3 },
          { date: "2095-09-30", studentCount: 1, capacity: 3 },
        ],
      },
    });

    const state = await pool.query(
      `SELECT import_group.import_mode,import_group.student_category,
              import_group.first_year_laboratory_date::text,
              batch.status AS ovpsa_status,revision.status AS revision_status,
              (SELECT COUNT(*)::int FROM schedule_batches child
                WHERE child.import_group_id=import_group.id AND child.status='PUBLISHED') AS child_batches,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations reservation
                WHERE reservation.batch_id=batch.id AND reservation.schedule_type='PHYSICAL_EXAM') AS pe_reservations,
              (SELECT ARRAY_AGG(snapshot.student_number ORDER BY snapshot.allocation_position)
                 FROM ovpsa_first_year_membership_snapshots snapshot
                WHERE snapshot.batch_id=batch.id) AS ordered_members,
              (SELECT COUNT(DISTINCT snapshot.college_id)::int
                 FROM ovpsa_first_year_membership_snapshots snapshot
                WHERE snapshot.batch_id=batch.id) AS membership_colleges
         FROM schedule_import_groups import_group
         JOIN ovpsa_first_year_batches batch ON batch.source_import_group_id=import_group.id
         JOIN ovpsa_first_year_batch_revisions revision ON revision.id=batch.current_revision_id
        WHERE import_group.id=$1`,
      [published.importId],
    );
    expect(state.rows).toEqual([{
      import_mode: "FIRST_YEAR_OVPSA",
      student_category: "REGULAR",
      first_year_laboratory_date: "2095-09-22",
      ovpsa_status: "PUBLISHED",
      revision_status: "PUBLISHED",
      child_batches: 2,
      pe_reservations: 2,
      ordered_members: ["95-8101-01", "95-8102-01", "95-8103-01", "95-8104-01"],
      membership_colleges: 2,
    }]);

    const detail = await getScheduleImport(published.importId, admin);
    expect(detail).toMatchObject({
      importMode: "FIRST_YEAR_OVPSA",
      studentCategory: "REGULAR",
      firstYearLaboratoryDate: "2095-09-22",
      status: "PUBLISHED",
      firstYearSummary: {
        laboratory: { date: "2095-09-22", locationName: "Iloilo Mission Hospital" },
        appointmentCount: 8,
        batchId: expect.any(String),
        revisionId: expect.any(String),
        allocations: [
          { date: "2095-09-29", studentCount: 3, capacity: 3 },
          { date: "2095-09-30", studentCount: 1, capacity: 3 },
        ],
      },
    });
    expect(detail.childBatches).toHaveLength(2);

    const sideEffects = await pool.query<{ notifications: number; audits: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number LIKE $1) AS notifications,
         (SELECT COUNT(*)::int FROM audit_logs WHERE metadata->>'importId'=$2) AS audits`,
      [studentPattern, published.importId],
    );
    expect(sideEffects.rows[0]).toEqual({ notifications: 4, audits: 3 });

    const importedPair = await pool.query<{ id: string; schedule_type: string }>(
      `SELECT id::text,schedule_type FROM appointments
        WHERE ovpsa_batch_id IS NOT NULL AND student_number='95-8101-01'
        ORDER BY schedule_type`,
    );
    const appointmentByType = new Map(
      importedPair.rows.map((appointment) => [appointment.schedule_type, appointment.id]),
    );
    await expect(updateAppointment(
      appointmentByType.get("PHYSICAL_EXAM")!,
      { quickStatusAction: "MARK_COMPLETED", expectedStatus: "PENDING" },
      admin,
    )).rejects.toMatchObject({
      code: "OVPSA_PHYSICAL_EXAM_REQUIRES_LAB_VERIFICATION",
    });
  });

  it("rejects a non-Year-1 row before review or publication", async () => {
    await expect(reviewFirstYearScheduleImport(input(csvRows(2)), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { "rows.2.Year": ["First Year imports require Year 1 for every row."] },
    });
  });

  it("allows only one concurrent owner and rolls the losing publication back completely", async () => {
    const attempts = await Promise.allSettled([
      acceptAndScheduleImport(input(), admin),
      acceptAndScheduleImport(input(), admin),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: expect.stringMatching(/^FIRST_YEAR_IMPORT_/) },
    });

    const residue = await pool.query<{ imports: number; batches: number; appointments: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$1) AS imports,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_batches batch
           JOIN schedule_import_groups import_group ON import_group.id=batch.source_import_group_id
          WHERE import_group.source_filename=$1) AS batches,
         (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE $2) AS appointments`,
      [sourceFilename, studentPattern],
    );
    expect(residue.rows[0]).toEqual({ imports: 1, batches: 1, appointments: 8 });
  });
});
