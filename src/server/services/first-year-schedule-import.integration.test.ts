// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import {
  cancelOvpsaFirstYearBatch,
  getOvpsaFirstYearBatch,
  listOvpsaFirstYearBatches,
  rescheduleOvpsaFirstYearBatch,
} from "../ovpsa/ovpsa-first-year.service";
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
    await client.query("DELETE FROM clinic_closure_groups WHERE reason='TEST First Year lifecycle closure'");
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
    await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM student_academic_snapshots WHERE student_number LIKE $1", [studentPattern]);
    await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM first_year_test_imports)");
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
                WHERE snapshot.batch_id=batch.id) AS membership_colleges,
              (SELECT COUNT(*)::int FROM student_academic_snapshots snapshot
                WHERE snapshot.academic_year_start=import_group.academic_year_start
                  AND snapshot.source_import_group_id=import_group.id) AS canonical_snapshot_count
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
      canonical_snapshot_count: 4,
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

    const sideEffects = await pool.query<{ notifications: number; typed: number; mission: number; audits: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number LIKE $1) AS notifications,
         (SELECT COUNT(*)::int FROM student_portal_notifications
           WHERE student_number LIKE $1
             AND notification_type='SCHEDULE_INITIAL_PUBLICATION'
             AND metadata->>'sourceType'='SCHEDULE_IMPORT_GROUP'
             AND metadata->>'sourceId'=$2) AS typed,
         (SELECT COUNT(*)::int FROM student_portal_notifications
           WHERE student_number LIKE $1 AND message LIKE '%Iloilo Mission Hospital%') AS mission,
         (SELECT COUNT(*)::int FROM audit_logs WHERE metadata->>'importId'=$2) AS audits`,
      [studentPattern, published.importId],
    );
    expect(sideEffects.rows[0]).toEqual({ notifications: 4, typed: 4, mission: 4, audits: 3 });

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

  it("rejects mixed First Year rows before review or publication", async () => {
    await expect(reviewFirstYearScheduleImport(input(csvRows(2)), admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: {
        file: [
          "Mixed year levels detected. Each CSV import must contain students from only one year level. Please separate the students into different CSV files before importing.",
        ],
      },
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

  it("reschedules and cancels a published atomic First Year import with complete history", async () => {
    const contents = [
      header,
      "95-8101-01,Alpha,Ana,Maria,,College of Computer Studies,BSIT,1,2006-01-01",
    ].join("\n");
    const published = await acceptAndScheduleImport(input(contents), admin);
    const original = await pool.query<{
      batch_id: string;
      revision_id: string;
      optimistic_token: string;
      laboratory_reservation_id: string;
    }>(
      `SELECT batch.id::text AS batch_id,
              batch.current_revision_id::text AS revision_id,
              batch.optimistic_token::text,
              reservation.id::text AS laboratory_reservation_id
         FROM ovpsa_first_year_batches batch
         JOIN ovpsa_first_year_service_reservations reservation
           ON reservation.batch_id=batch.id
          AND reservation.revision_id=batch.current_revision_id
          AND reservation.schedule_type='LABORATORY'
          AND reservation.status='ACTIVE'
        WHERE batch.source_import_group_id=$1`,
      [published.importId],
    );
    expect(original.rowCount).toBe(1);
    const batchId = original.rows[0].batch_id;

    const closure = await pool.query<{ id: string }>(
      `INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id,
         recovery_mode,policy_effective_date
       ) VALUES ('2095-09-22','2095-09-22','CLOSURE',$1,$2,gen_random_uuid(),
                 'AUTO_ELIGIBLE','2095-09-01')
       RETURNING id::text`,
      ["TEST First Year lifecycle closure", TEST_REFERENCE_IDS.adminUser],
    );
    await pool.query(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='INVALIDATED',invalidated_by_closure_group_id=$2,
              invalidated_at=clock_timestamp()
        WHERE id=$1`,
      [original.rows[0].laboratory_reservation_id, closure.rows[0].id],
    );
    await pool.query(
      `UPDATE appointments
          SET status='AWAITING_RESCHEDULE'
        WHERE ovpsa_batch_id=$1 AND schedule_type='LABORATORY'
          AND status='PENDING' AND is_published=TRUE`,
      [batchId],
    );
    await pool.query(
      `UPDATE ovpsa_first_year_batches
          SET status='RESCHEDULE_REQUIRED',optimistic_token=gen_random_uuid(),
              updated_by=$2
        WHERE id=$1`,
      [batchId, TEST_REFERENCE_IDS.adminUser],
    );

    const invalidated = await getOvpsaFirstYearBatch(batchId);
    expect(invalidated).toMatchObject({
      batchId,
      status: "RESCHEDULE_REQUIRED",
      revisionNumber: 1,
      revisionStatus: "PUBLISHED",
      laboratoryDate: "2095-09-22",
      physicalExamDate: "2095-09-29",
    });

    const replacement = await rescheduleOvpsaFirstYearBatch(
      batchId,
      {
        optimisticToken: invalidated.optimisticToken,
        laboratoryDate: "2095-10-06",
        physicalExamDateOverride: null,
        physicalExamExceptionReason: null,
        reason: "Official Laboratory closure replacement",
      },
      TEST_REFERENCE_IDS.adminUser,
    );
    expect(replacement).toMatchObject({
      batchId,
      revisionNumber: 2,
      status: "PUBLISHED",
      memberCount: 1,
    });

    const afterReplacement = await pool.query<{
      revision_statuses: string[];
      appointment_states: string[];
      active_memberships: number;
      active_reservations: number;
      reschedule_events: number;
      reschedule_notifications: number;
      reschedule_audits: number;
    }>(
      `SELECT
         (SELECT ARRAY_AGG(revision.status ORDER BY revision.revision_number)
            FROM ovpsa_first_year_batch_revisions revision
           WHERE revision.batch_id=$1) AS revision_statuses,
         (SELECT ARRAY_AGG(
                   appointment.schedule_type || ':' || appointment.status || ':' ||
                   appointment.is_published::text || ':' || appointment.appointment_date::text
                   ORDER BY appointment.created_at,appointment.schedule_type
                 )
            FROM appointments appointment WHERE appointment.ovpsa_batch_id=$1) AS appointment_states,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_active_memberships membership
           WHERE membership.batch_id=$1 AND membership.released_at IS NULL) AS active_memberships,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations reservation
           WHERE reservation.batch_id=$1 AND reservation.status='ACTIVE') AS active_reservations,
         (SELECT COUNT(*)::int FROM appointment_reschedule_events event
           WHERE event.ovpsa_batch_id=$1 AND event.cause='OVPSA_RESCHEDULE') AS reschedule_events,
         (SELECT COUNT(*)::int FROM student_portal_notifications notification
           WHERE notification.student_number='95-8101-01'
             AND notification.notification_type='SCHEDULE_ADMINISTRATOR_RESCHEDULED') AS reschedule_notifications,
         (SELECT COUNT(*)::int FROM audit_logs audit
           WHERE audit.entity_id=$1::text
             AND audit.action='OVPSA_FIRST_YEAR_BATCH_RESCHEDULED') AS reschedule_audits`,
      [batchId],
    );
    expect(afterReplacement.rows[0]).toEqual({
      revision_statuses: ["SUPERSEDED", "PUBLISHED"],
      appointment_states: [
        "LABORATORY:RESCHEDULED:false:2095-09-22",
        "PHYSICAL_EXAM:RESCHEDULED:false:2095-09-29",
        "LABORATORY:PENDING:true:2095-10-06",
        "PHYSICAL_EXAM:PENDING:true:2095-10-13",
      ],
      active_memberships: 1,
      active_reservations: 2,
      reschedule_events: 1,
      reschedule_notifications: 1,
      reschedule_audits: 1,
    });

    const cancelled = await cancelOvpsaFirstYearBatch(
      batchId,
      {
        optimisticToken: replacement.optimisticToken,
        reason: "OVPSA cancelled the replacement batch",
      },
      TEST_REFERENCE_IDS.adminUser,
    );
    expect(cancelled).toMatchObject({
      batchId,
      status: "CANCELLED",
      cancelledAppointmentCount: 2,
    });

    const detail = await getOvpsaFirstYearBatch(batchId);
    expect(detail).toMatchObject({
      batchId,
      status: "CANCELLED",
      revisionNumber: 2,
      revisionStatus: "CANCELLED",
      cancellationReason: "OVPSA cancelled the replacement batch",
    });
    const listed = await listOvpsaFirstYearBatches();
    expect(listed.items).toContainEqual(expect.objectContaining({
      batchId,
      status: "CANCELLED",
      revisionNumber: 2,
      revisionStatus: "CANCELLED",
    }));

    const finalState = await pool.query<{
      appointment_states: string[];
      active_memberships: number;
      unreleased_reservations: number;
      cancellation_notifications: number;
      cancellation_audits: number;
    }>(
      `SELECT
         (SELECT ARRAY_AGG(appointment.status ORDER BY appointment.created_at,appointment.schedule_type)
            FROM appointments appointment WHERE appointment.ovpsa_batch_id=$1) AS appointment_states,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_active_memberships membership
           WHERE membership.batch_id=$1 AND membership.released_at IS NULL) AS active_memberships,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations reservation
           WHERE reservation.batch_id=$1 AND reservation.status<>'RELEASED') AS unreleased_reservations,
         (SELECT COUNT(*)::int FROM student_portal_notifications notification
           WHERE notification.student_number='95-8101-01'
             AND notification.notification_type='SCHEDULE_CANCELLED') AS cancellation_notifications,
         (SELECT COUNT(*)::int FROM audit_logs audit
           WHERE audit.entity_id=$1::text
             AND audit.action='OVPSA_FIRST_YEAR_BATCH_CANCELLED') AS cancellation_audits`,
      [batchId],
    );
    expect(finalState.rows[0]).toEqual({
      appointment_states: [
        "RESCHEDULED",
        "RESCHEDULED",
        "CANCELLED",
        "CANCELLED",
      ],
      active_memberships: 0,
      unreleased_reservations: 0,
      cancellation_notifications: 1,
      cancellation_audits: 1,
    });

  });
});
