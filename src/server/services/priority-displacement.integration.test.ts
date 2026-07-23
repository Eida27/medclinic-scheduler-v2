// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { publishBatch } from "@/server/repositories/appointments.repository";
import { getCurrentEffectiveAppointmentsForStudent } from "@/server/repositories/current-effective-appointments.repository";
import {
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";
import { invalidateStudentResultSubmission } from "./student-result-submissions.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-94%";
const importPattern = "% 2026-2027 - TEST-DISPLACE%";
let capacityFixture: CapacityFixtureLock | null = null;

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function input(
  fileName: string,
  category: "REGULAR" | "OJT",
  studentNumbers: string[],
) {
  const contents = [
    header,
    ...studentNumbers.map((studentNumber, index) => (
      `${studentNumber},Displace,Student${index + 1},,,College of Computer Studies,BSIT,3,05-06-2003`
    )),
  ].join("\n");
  return {
    fileName,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: category,
    academicYearStart: 2026,
    preferredMonth: category === "REGULAR" ? null : 8,
  };
}

async function insertEndOfMonthClosures() {
  await pool.query(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by
     ) VALUES
       ($1,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE laboratory',$3),
       ($2,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE physical',$3)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-DISPLACE%'");
}

async function waitForCoordinatorItemInsertWaiter() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiter = await pool.query<{ pid: number }>(
      `SELECT lock.pid
         FROM pg_locks lock
        WHERE lock.relation='coordinator_schedule_items'::regclass
          AND lock.granted=FALSE
        ORDER BY lock.pid
        LIMIT 1`,
    );
    if (waiter.rows[0]) return waiter.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for atomic import to reach coordinator item insertion.");
}

async function waitForClientLock(clientPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const activity = await pool.query<{ waitEventType: string | null }>(
      `SELECT wait_event_type AS "waitEventType"
         FROM pg_stat_activity
        WHERE pid=$1`,
      [clientPid],
    );
    if (activity.rows[0]?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for batch publication to block on the shared scope lock.");
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
});

afterEach(cleanup);
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("priority displacement", () => {
  it("acquires one canonical atomic-import scope union before concurrent batch publication", async () => {
    const importedStudent = "99-9426-26";
    const unaffectedRegularStudent = "99-9427-27";
    const displacedStudent = "99-9428-28";
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await insertTestStudent({
      studentNumber: importedStudent,
      firstName: "Imported",
      lastName: "LockOrder",
      yearLevel: 3,
    });
    const oldAppointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, schedule_cycle_start
       ) VALUES ($1,$2,'LABORATORY','2025-07-01','COMPLETED',TRUE,$3,2024)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, importedStudent, TEST_REFERENCE_IDS.adminUser],
    );
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ($1,$2,'COMPLETED','2025-07-01',$3)`,
      [importedStudent, oldAppointment.rows[0].id, TEST_REFERENCE_IDS.adminUser],
    );
    const oldSubmission = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, status, finalized_at
       ) VALUES ($1,$2,'LABORATORY','FINALIZED',NOW())
       RETURNING id`,
      [oldAppointment.rows[0].id, importedStudent],
    );
    await pool.query(
      `INSERT INTO student_result_files (
         submission_id, storage_key, original_filename, detected_mime_type,
         extension, byte_size, checksum_sha256
       ) VALUES ($1,'TEST-DISPLACE/stale.pdf','stale.pdf','application/pdf',
                 'pdf',32,$2)`,
      [oldSubmission.rows[0].id, "a".repeat(64)],
    );

    await acceptAndScheduleImport(
      input(
        "TEST-DISPLACE-lock-order-regular.csv",
        "REGULAR",
        [unaffectedRegularStudent, displacedStudent],
      ),
      admin,
    );
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO schedule_batches (clinic_id, batch_name, status, created_by)
       VALUES ($1,'REGULAR 2026-2027 - TEST-DISPLACE lock-order batch','GENERATED',$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    await pool.query(
      `INSERT INTO appointments (
         batch_id, clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, schedule_cycle_start
       ) VALUES
         ($1,$2,$3,'LABORATORY','2026-07-15','DRAFT',FALSE,$5,2025),
         ($1,$2,$4,'LABORATORY','2026-07-16','DRAFT',FALSE,$5,2025)`,
      [
        batch.rows[0].id,
        TEST_REFERENCE_IDS.laboratoryClinic,
        importedStudent,
        displacedStudent,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );

    const blocker = await pool.connect();
    const publisher = await pool.connect();
    let blockerCommitted = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE coordinator_schedule_items IN SHARE MODE");
      const importTask = acceptAndScheduleImport(
        input("TEST-DISPLACE-lock-order-priority.csv", "OJT", [importedStudent]),
        admin,
      );
      const importPid = await waitForCoordinatorItemInsertWaiter();
      const importAdvisoryLocks = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_locks
          WHERE pid=$1 AND locktype='advisory' AND granted=TRUE`,
        [importPid],
      );
      expect(importAdvisoryLocks.rows[0].count).toBe(5);

      await publisher.query("BEGIN");
      await publisher.query("SET LOCAL deadlock_timeout='100ms'");
      const publisherPid = await publisher.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const publicationTask = publishBatch(
        batch.rows[0].id,
        admin.userId,
        publisher,
      ).then(async (result) => {
        await publisher.query("COMMIT");
        return result;
      }).catch(async (error) => {
        await publisher.query("ROLLBACK").catch(() => undefined);
        throw error;
      });
      await waitForClientLock(publisherPid.rows[0].pid);

      await blocker.query("COMMIT");
      blockerCommitted = true;
      const [importOutcome, publicationOutcome] = await Promise.allSettled([
        importTask,
        publicationTask,
      ]);

      if (importOutcome.status === "rejected") throw importOutcome.reason;
      if (publicationOutcome.status === "rejected") throw publicationOutcome.reason;
      expect(importOutcome.value).toMatchObject({ displacementTotal: 1 });
      expect(publicationOutcome.value).toEqual({ count: 2 });

      const current = await getCurrentEffectiveAppointmentsForStudent(importedStudent);
      expect(current.laboratory).toMatchObject({
        studentNumber: importedStudent,
        scheduleType: "LABORATORY",
      });
      expect(current.laboratory?.id).not.toBe(oldAppointment.rows[0].id);
      let deleteCalls = 0;
      await expect(invalidateStudentResultSubmission(
        oldSubmission.rows[0].id,
        "Reject stale concurrent submission",
        admin,
        {
          write: async () => { throw new Error("Unexpected storage write."); },
          read: async () => { throw new Error("Unexpected storage read."); },
          delete: async () => { deleteCalls += 1; },
        },
      )).rejects.toMatchObject({ code: "RESULT_SUBMISSION_CONFLICT", status: 409 });
      expect(deleteCalls).toBe(0);
      const staleState = await pool.query<{
        status: string;
        storageDeletePending: boolean;
      }>(
        `SELECT submission.status,
                file.storage_delete_pending AS "storageDeletePending"
           FROM student_result_submissions submission
           JOIN student_result_files file ON file.submission_id=submission.id
          WHERE submission.id=$1`,
        [oldSubmission.rows[0].id],
      );
      expect(staleState.rows).toEqual([{
        status: "FINALIZED",
        storageDeletePending: false,
      }]);
    } finally {
      if (!blockerCommitted) await blocker.query("ROLLBACK").catch(() => undefined);
      await publisher.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      publisher.release();
    }
  }, 30000);

  it("keeps a priority candidate date eligible until maximum capacity is reached", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=2, max_daily_capacity=2
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-maximum-regular.csv", "REGULAR", ["99-9413-13"]),
      admin,
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-maximum-priority.csv", "OJT", ["99-9414-14"]),
      admin,
    );

    expect(priority.displacementTotal).toBe(0);
    const laboratoryDates = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number IN ('99-9413-13','99-9414-14')
          AND schedule_type='LABORATORY'
          AND status='PENDING'
        ORDER BY student_number`,
    );
    expect(laboratoryDates.rows).toEqual([
      { appointment_date: laboratoryDates.rows[0].appointment_date },
      { appointment_date: laboratoryDates.rows[0].appointment_date },
    ]);
  });

  it("moves only the later eligible Regular pair and keeps linked history", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular.csv", "REGULAR", ["99-9401-01", "99-9402-02"]),
      admin,
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority.csv", "OJT", ["99-9403-03"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);

    const regularAppointments = await pool.query(
      `SELECT student_number, status, appointment_date::text, rescheduled_from::text
         FROM appointments WHERE student_number IN ('99-9401-01','99-9402-02')
        ORDER BY student_number, created_at, schedule_type`,
    );
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9401-01"))
      .toHaveLength(2);
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9401-01"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "PENDING" })]));
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9402-02" && row.status === "RESCHEDULED"))
      .toHaveLength(2);
    const replacements = regularAppointments.rows.filter(
      (row) => row.student_number === "99-9402-02" && row.status === "PENDING",
    );
    expect(replacements).toHaveLength(2);
    expect(replacements.every((row) => row.rescheduled_from)).toBe(true);

    const history = await pool.query(
      `SELECT cause, student_number FROM appointment_reschedule_events
        WHERE student_number='99-9402-02'`,
    );
    expect(history.rows).toEqual([{
      cause: "PRIORITY_DISPLACEMENT",
      student_number: "99-9402-02",
    }]);
    const notifications = await pool.query(
      `SELECT notification_type FROM student_portal_notifications
        WHERE student_number='99-9402-02'`,
    );
    expect(notifications.rows).toEqual([{ notification_type: "SCHEDULE_RESCHEDULED" }]);
  });

  it("never moves manually locked Regular appointments", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-locked.csv", "REGULAR", ["99-9404-04", "99-9405-05"]),
      admin,
    );
    await pool.query(
      `UPDATE appointments
          SET is_manually_locked=TRUE, locked_by=$2, locked_at=NOW(), lock_reason='TEST protected'
        WHERE student_number=$1`,
      ["99-9405-05", TEST_REFERENCE_IDS.adminUser],
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-locked.csv", "OJT", ["99-9406-06"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const protectedAppointments = await pool.query(
      "SELECT DISTINCT status FROM appointments WHERE student_number='99-9405-05'",
    );
    expect(protectedAppointments.rows).toEqual([{ status: "PENDING" }]);
  });

  it("moves only Regular PE when Laboratory fits but PE exceeds the priority window", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END,
              max_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES ($1,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE physical-only',$2)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
    );
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-pe.csv", "REGULAR", ["99-9407-07"]),
      admin,
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-pe.csv", "OJT", ["99-9408-08"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const regular = await pool.query<{
      schedule_type: string;
      status: string;
      rescheduled_from: string | null;
      schedule_pair_id: string;
    }>(
      `SELECT schedule_type, status, rescheduled_from::text, schedule_pair_id::text
         FROM appointments WHERE student_number='99-9407-07'
        ORDER BY schedule_type, created_at`,
    );
    expect(regular.rows.filter((row) => row.schedule_type === "LABORATORY"))
      .toEqual([expect.objectContaining({ status: "PENDING", rescheduled_from: null })]);
    const physical = regular.rows.filter((row) => row.schedule_type === "PHYSICAL_EXAM");
    expect(physical).toEqual([
      expect.objectContaining({ status: "RESCHEDULED", rescheduled_from: null }),
      expect.objectContaining({ status: "PENDING", rescheduled_from: expect.any(String) }),
    ]);
    expect(new Set(regular.rows.map((row) => row.schedule_pair_id)).size).toBe(1);
  });

  it("moves only PE slots usable after each priority Laboratory date", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END,
              max_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-matched-pe.csv", "REGULAR", ["99-9409-09", "99-9410-10"]),
      admin,
    );
    await pool.query(
      `UPDATE appointments SET appointment_date='2026-07-31'
        WHERE student_number IN ('99-9409-09','99-9410-10')
          AND schedule_type='LABORATORY'`,
    );
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE schedule_type='LABORATORY'`,
    );
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES
         ($1,'2026-08-04','2026-08-14','CLOSURE','TEST-DISPLACE laboratory gap',$3),
         ($2,'2026-08-06','2026-08-31','CLOSURE','TEST-DISPLACE physical gap',$3)`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-matched-pe.csv", "OJT", ["99-9411-11", "99-9412-12"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const regularPhysical = await pool.query(
      `SELECT student_number, status
         FROM appointments
        WHERE student_number IN ('99-9409-09','99-9410-10')
          AND schedule_type='PHYSICAL_EXAM'
        ORDER BY student_number, created_at`,
    );
    expect(regularPhysical.rows.filter((row) => row.status === "RESCHEDULED")).toHaveLength(1);
    const priorityDates = await pool.query<{ student_number: string; laboratory_date: string; physical_date: string }>(
      `SELECT laboratory.student_number,
              laboratory.appointment_date::text AS laboratory_date,
              physical.appointment_date::text AS physical_date
         FROM appointments laboratory
         JOIN appointments physical ON physical.schedule_pair_id=laboratory.schedule_pair_id
          AND physical.schedule_type='PHYSICAL_EXAM' AND physical.status='PENDING'
        WHERE laboratory.student_number IN ('99-9411-11','99-9412-12')
          AND laboratory.schedule_type='LABORATORY' AND laboratory.status='PENDING'
        ORDER BY laboratory.appointment_date`,
    );
    expect(priorityDates.rows.filter((row) => row.physical_date <= "2026-08-31")).toHaveLength(1);
    expect(priorityDates.rows.every((row) => row.physical_date > row.laboratory_date)).toBe(true);
  });
});
