// @vitest-environment node
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { deleteAcademicYear } from "@/server/services/academic-years.service";
import { pool } from "@/server/db/pool";
import { insertTestScheduleImportGroup, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { ensureStudentAcademicSnapshotsWithClient } from "./student-academic-snapshots.repository";
import {
  createAcademicYearWithClient,
  deleteAcademicYearWithClient,
  listAcademicYearRecords,
  lockAcademicYearSchedulingBoundary,
  lockAcademicYearWithSnapshotCount,
  updateAcademicYearClosingDateWithClient,
} from "./academic-years.repository";

afterAll(async () => {
  await pool.end();
});

const concurrentYear = 2096;
const reverseConcurrentYear = 2095;
const shareLockYear = 2094;
const concurrentImportGroupId = "b8600000-0000-4000-8000-000000000001";
const reverseImportGroupId = "b8600000-0000-4000-8000-000000000002";

async function waitForAcademicYearOperationToBlock(
  observer: PoolClient,
  blockerTransactionId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const waiting = await observer.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM pg_locks
        WHERE pid<>pg_backend_pid()
          AND locktype='transactionid'
          AND transactionid=$1::xid
          AND granted=FALSE`,
      [blockerTransactionId],
    );
    if (waiting.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const locks = await observer.query<{
    pid: number;
    locktype: string;
    mode: string;
    granted: boolean;
  }>(
    `SELECT pid,locktype,mode,granted
       FROM pg_locks
      WHERE transactionid=$1::xid
      ORDER BY pid,granted`,
    [blockerTransactionId],
  );
  throw new Error(
    `Timed out waiting for academic-year operation to block: ${JSON.stringify(locks.rows)}`,
  );
}

async function cleanupConcurrentYear() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query(
      "DELETE FROM student_academic_snapshots WHERE academic_year_start=$1",
      [concurrentYear],
    );
    await client.query(
      "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query("DELETE FROM schedule_import_groups WHERE id=$1", [concurrentImportGroupId]);
    await client.query(
      `DELETE FROM audit_logs
        WHERE entity_type='academic_year' AND entity_id=$1`,
      [String(concurrentYear)],
    );
    await client.query("DELETE FROM academic_years WHERE start_year=$1", [concurrentYear]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupReverseConcurrentYear() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query(
      `DELETE FROM student_academic_snapshots
        WHERE student_number='95-RACE-0001' AND academic_year_start=$1`,
      [reverseConcurrentYear],
    );
    await client.query(
      "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query("DELETE FROM schedule_import_groups WHERE id=$1", [reverseImportGroupId]);
    await client.query(
      `DELETE FROM audit_logs
        WHERE entity_type IN ('academic_year','student_academic_snapshot')
          AND (entity_id=$1 OR metadata->>'academicYearStart'=$1)`,
      [String(reverseConcurrentYear)],
    );
    await client.query("DELETE FROM academic_years WHERE start_year=$1", [reverseConcurrentYear]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupShareLockYear() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM audit_logs
        WHERE entity_type='academic_year' AND entity_id=$1`,
      [String(shareLockYear)],
    );
    await client.query("DELETE FROM academic_years WHERE start_year=$1", [shareLockYear]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("academic-years repository", () => {
  it("returns the configured-year domain conflict when deletion locks and commits first", async () => {
    await cleanupReverseConcurrentYear();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,'2096-07-31',$2,$2)`,
      [reverseConcurrentYear, TEST_REFERENCE_IDS.adminUser],
    );
    const importGroupClient = await pool.connect();
    try {
      await insertTestScheduleImportGroup(importGroupClient, {
        id: reverseImportGroupId,
        name: "Academic-year reverse-delete fixture",
        sourceFilename: "academic-year-reverse-delete.csv",
        academicYearStart: reverseConcurrentYear,
        importMode: "STANDARD",
        actor: TEST_REFERENCE_IDS.adminUser,
      });
    } finally {
      importGroupClient.release();
    }
    const deleter = await pool.connect();
    const importer = await pool.connect();
    let deleterCommitted = false;
    let importerSettled = false;
    try {
      await deleter.query("BEGIN");
      await deleter.query(
        "SELECT start_year FROM academic_years WHERE start_year=$1 FOR UPDATE",
        [reverseConcurrentYear],
      );
      const blocker = await deleter.query<{ transaction_id: string }>(
        "SELECT txid_current()::text AS transaction_id",
      );

      await importer.query("BEGIN");
      const snapshotAttempt = ensureStudentAcademicSnapshotsWithClient(importer, {
        actorUserId: TEST_REFERENCE_IDS.adminUser,
        candidates: [{
          studentNumber: "95-RACE-0001",
          academicYearStart: reverseConcurrentYear,
          studentName: "Race, Reverse Order",
          collegeId: null,
          collegeName: "Historical College",
          programId: null,
          programCode: null,
          programName: "Historical Program",
          yearLevel: 3,
          sourceImportGroupId: reverseImportGroupId,
        }],
      }).then(
        async (value) => {
          await importer.query("COMMIT");
          importerSettled = true;
          return { outcome: "resolved" as const, value };
        },
        async (error: unknown) => {
          await importer.query("ROLLBACK");
          importerSettled = true;
          return { outcome: "rejected" as const, error };
        },
      );

      await waitForAcademicYearOperationToBlock(
        deleter,
        blocker.rows[0].transaction_id,
      );
      await deleteAcademicYearWithClient(deleter, reverseConcurrentYear);
      await deleter.query("COMMIT");
      deleterCommitted = true;

      await expect(snapshotAttempt).resolves.toEqual({
        outcome: "rejected",
        error: expect.objectContaining({
          name: "AppError",
          code: "ACADEMIC_YEAR_NOT_CONFIGURED",
          status: 409,
          details: { academicYearStart: [reverseConcurrentYear] },
        }),
      });
      const writes = await pool.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM academic_years WHERE start_year=$1) AS years,
           (SELECT COUNT(*)::integer FROM student_academic_snapshots
             WHERE student_number='95-RACE-0001' AND academic_year_start=$1) AS snapshots,
           (SELECT COUNT(*)::integer FROM students WHERE student_number='95-RACE-0001') AS students,
           (SELECT COUNT(*)::integer FROM appointments WHERE student_number='95-RACE-0001') AS appointments,
           (SELECT COUNT(*)::integer FROM audit_logs
             WHERE entity_id='95-RACE-0001:2095'
                OR metadata->>'academicYearStart'=$1::text) AS audits`,
        [reverseConcurrentYear],
      );
      expect(writes.rows[0]).toEqual({
        years: 0,
        snapshots: 0,
        students: 0,
        appointments: 0,
        audits: 0,
      });
    } finally {
      if (!deleterCommitted) await deleter.query("ROLLBACK");
      if (!importerSettled) await importer.query("ROLLBACK");
      deleter.release();
      importer.release();
      await cleanupReverseConcurrentYear();
    }
  });

  it("returns an in-use conflict when a snapshot commits while deletion waits for the parent row", async () => {
    await cleanupConcurrentYear();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,$2,$3,$3)`,
      [concurrentYear, "2097-07-31", TEST_REFERENCE_IDS.adminUser],
    );
    const inserter = await pool.connect();
    let inserterCommitted = false;
    try {
      await inserter.query("BEGIN");
      await inserter.query(
        "SELECT start_year FROM academic_years WHERE start_year=$1 FOR NO KEY UPDATE",
        [concurrentYear],
      );
      const blocker = await inserter.query<{ transaction_id: string }>(
        "SELECT txid_current()::text AS transaction_id",
      );

      const deletion = deleteAcademicYear(
        { startYear: concurrentYear },
        TEST_REFERENCE_IDS.adminUser,
      ).then(
        (value) => ({ outcome: "resolved" as const, value }),
        (error: unknown) => ({ outcome: "rejected" as const, error }),
      );
      await waitForAcademicYearOperationToBlock(
        inserter,
        blocker.rows[0].transaction_id,
      );
      await insertTestScheduleImportGroup(inserter, {
        id: concurrentImportGroupId,
        name: "Academic-year concurrent-delete fixture",
        sourceFilename: "academic-year-concurrent-delete.csv",
        academicYearStart: concurrentYear,
        importMode: "STANDARD",
        actor: TEST_REFERENCE_IDS.adminUser,
      });
      await inserter.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,
           program_name,source_import_group_id
         ) VALUES ('96-0001-01',$1,'Racing, Student','Historical College',
                   'Historical Program',$2)`,
        [concurrentYear, concurrentImportGroupId],
      );
      await inserter.query("COMMIT");
      inserterCommitted = true;

      await expect(deletion).resolves.toEqual({
        outcome: "rejected",
        error: expect.objectContaining({
          name: "AppError",
          code: "ACADEMIC_YEAR_IN_USE",
          status: 409,
          details: { linkedSnapshotCount: 1 },
        }),
      });
      const stored = await pool.query<{ year_count: number; snapshot_count: number }>(
        `SELECT (SELECT COUNT(*)::integer FROM academic_years WHERE start_year=$1) AS year_count,
                (SELECT COUNT(*)::integer FROM student_academic_snapshots
                  WHERE academic_year_start=$1) AS snapshot_count`,
        [concurrentYear],
      );
      expect(stored.rows[0]).toEqual({ year_count: 1, snapshot_count: 1 });
    } finally {
      if (!inserterCommitted) await inserter.query("ROLLBACK");
      inserter.release();
      await cleanupConcurrentYear();
    }
  });

  it("keeps a closing-date update waiting while the scheduling boundary is share locked", async () => {
    await cleanupShareLockYear();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,'2095-07-31',$2,$2)`,
      [shareLockYear, TEST_REFERENCE_IDS.adminUser],
    );
    const scheduler = await pool.connect();
    const updater = await pool.connect();
    let schedulerCommitted = false;
    let updateSettled = false;
    let update: ReturnType<typeof updateAcademicYearClosingDateWithClient> | undefined;
    try {
      await scheduler.query("BEGIN");
      await expect(lockAcademicYearSchedulingBoundary(scheduler, shareLockYear)).resolves.toEqual({
        startYear: shareLockYear,
        closingDate: "2095-07-31",
      });
      const blocker = await scheduler.query<{ transaction_id: string }>(
        "SELECT txid_current()::text AS transaction_id",
      );
      update = updateAcademicYearClosingDateWithClient(updater, {
        startYear: shareLockYear,
        closingDate: "2095-07-15",
        actorUserId: TEST_REFERENCE_IDS.clinicStaffUser,
      }).then(
        (value) => {
          updateSettled = true;
          return value;
        },
        (error: unknown) => {
          updateSettled = true;
          throw error;
        },
      );

      await waitForAcademicYearOperationToBlock(
        scheduler,
        blocker.rows[0].transaction_id,
      );
      expect(updateSettled).toBe(false);
      await scheduler.query("COMMIT");
      schedulerCommitted = true;

      await expect(update).resolves.toMatchObject({
        startYear: shareLockYear,
        closingDate: "2095-07-15",
        updatedBy: TEST_REFERENCE_IDS.clinicStaffUser,
      });
    } finally {
      if (!schedulerCommitted) await scheduler.query("ROLLBACK");
      scheduler.release();
      if (update && !updateSettled) await update.catch(() => undefined);
      updater.release();
      await cleanupShareLockYear();
    }
  });

  it("returns linked counts and preserves the creator when the closing date changes", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await createAcademicYearWithClient(client, {
        startYear: 2097,
        closingDate: "2098-07-31",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
      });
      await client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,
           program_name,source_import_group_id
         ) VALUES ('97-0001-01',2097,'Historical, Student','Historical College',
                   'Historical Program',$1)`,
        [await insertTestScheduleImportGroup(client, {
          name: "Academic-year linked-count fixture",
          sourceFilename: "academic-year-linked-count.csv",
          academicYearStart: 2097,
          importMode: "STANDARD",
          actor: TEST_REFERENCE_IDS.adminUser,
        })],
      );

      const listed = await listAcademicYearRecords(client);
      expect(listed.find((year) => year.startYear === 2097)).toMatchObject({
        closingDate: "2098-07-31",
        createdBy: TEST_REFERENCE_IDS.adminUser,
        updatedBy: TEST_REFERENCE_IDS.adminUser,
        linkedSnapshotCount: 1,
      });
      await expect(lockAcademicYearWithSnapshotCount(client, 2097)).resolves.toMatchObject({
        linkedSnapshotCount: 1,
      });

      const updated = await updateAcademicYearClosingDateWithClient(client, {
        startYear: 2097,
        closingDate: "2098-07-15",
        actorUserId: TEST_REFERENCE_IDS.clinicStaffUser,
      });
      expect(updated).toMatchObject({
        closingDate: "2098-07-15",
        createdBy: TEST_REFERENCE_IDS.adminUser,
        updatedBy: TEST_REFERENCE_IDS.clinicStaffUser,
        linkedSnapshotCount: 1,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("deletes an unlinked year and returns the deleted metadata", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await createAcademicYearWithClient(client, {
        startYear: 2098,
        closingDate: "2099-07-31",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
      });

      await expect(deleteAcademicYearWithClient(client, 2098)).resolves.toMatchObject({
        startYear: 2098,
        closingDate: "2099-07-31",
        linkedSnapshotCount: 0,
      });
      await expect(lockAcademicYearWithSnapshotCount(client, 2098)).resolves.toBeUndefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
