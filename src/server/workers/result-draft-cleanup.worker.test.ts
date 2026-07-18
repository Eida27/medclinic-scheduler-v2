// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/server/db/pool";
import {
  addStudentResultFile,
  finalizeStudentResultSubmission,
  invalidateStudentResultSubmission,
  removeStudentResultFile,
} from "@/server/services/student-result-submissions.service";
import { LocalResultStorage } from "@/server/storage/local-result-storage";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  cleanupExpiredResultDrafts,
  RESULT_DRAFT_CLEANUP_INTERVAL_MS,
  startResultDraftCleanupWorker,
} from "./result-draft-cleanup.worker";

const studentPattern = "99-93%";
let storageRoot = "";
let storage: LocalResultStorage;

type CleanupGlobal = typeof globalThis & { __medclinicResultDraftCleanupWorkerStarted?: boolean };
const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-DRAFT-CLEANUP%", "TEST-DRAFT-CLEANUP%");
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), "medclinic-draft-cleanup-"));
    storage = new LocalResultStorage(storageRoot);
  }
}

async function draft(studentNumber: string, filename = "draft.pdf") {
  await insertTestStudent({ studentNumber, firstName: "Cleanup", lastName: "Student", yearLevel: 3 });
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by
     ) VALUES ($1,$2,'LABORATORY','2027-08-02','COMPLETED',TRUE,$3) RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, TEST_REFERENCE_IDS.adminUser],
  );
  const file = await addStudentResultFile(studentNumber, appointment.rows[0].id, {
    filename,
    declaredMimeType: "application/pdf",
    bytes: Buffer.from("%PDF-1.7\ncleanup"),
  }, storage);
  return { appointmentId: appointment.rows[0].id, file };
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "medclinic-draft-cleanup-"));
  storage = new LocalResultStorage(storageRoot);
  await cleanup();
});
beforeEach(() => {
  delete (globalThis as CleanupGlobal).__medclinicResultDraftCleanupWorkerStarted;
});
afterEach(cleanup);
afterAll(async () => {
  await cleanupTestFixtures(studentPattern, "TEST-DRAFT-CLEANUP%", "TEST-DRAFT-CLEANUP%");
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe("result draft cleanup", () => {
  it("expires exactly seven inactive days, deletes private bytes, audits aggregates, and is idempotent", async () => {
    const fixture = await draft("99-9301-01");
    const now = new Date("2027-09-08T00:00:00.000Z");
    await pool.query(
      "UPDATE student_result_submissions SET last_activity_at=$2 WHERE id=$1",
      [fixture.file.submissionId, new Date("2027-09-01T00:00:00.000Z")],
    );
    await expect(cleanupExpiredResultDrafts(now, storage)).resolves.toEqual({ expiredDraftCount: 1, deletionFailureCount: 0 });
    await expect(storage.read(fixture.file.storageKey)).rejects.toThrow();
    expect((await pool.query("SELECT id FROM student_result_submissions WHERE id=$1", [fixture.file.submissionId])).rows).toEqual([]);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE action='STUDENT_RESULT_DRAFT_EXPIRED' AND entity_id=$1",
      [fixture.file.submissionId],
    );
    expect(audit.rows[0].metadata).toEqual({ fileCount: 1, totalBytes: fixture.file.byteSize });
    await expect(cleanupExpiredResultDrafts(now, storage)).resolves.toEqual({ expiredDraftCount: 0, deletionFailureCount: 0 });
  });

  it("retains active and finalized submissions", async () => {
    const active = await draft("99-9302-02", "active.pdf");
    const finalized = await draft("99-9303-03", "final.pdf");
    await finalizeStudentResultSubmission("99-9303-03", finalized.appointmentId, storage);
    const now = new Date("2027-09-08T00:00:00.000Z");
    await pool.query(
      `UPDATE student_result_submissions
          SET last_activity_at=CASE WHEN id=$1 THEN $3::timestamptz ELSE $4::timestamptz END
        WHERE id = ANY($2::uuid[])`,
      [
        active.file.submissionId,
        [active.file.submissionId, finalized.file.submissionId],
        new Date("2027-09-01T00:00:01.000Z"),
        new Date("2027-08-01T00:00:00.000Z"),
      ],
    );
    await expect(cleanupExpiredResultDrafts(now, storage)).resolves.toEqual({ expiredDraftCount: 0, deletionFailureCount: 0 });
    const remaining = await pool.query("SELECT status FROM student_result_submissions ORDER BY status");
    expect(remaining.rows).toEqual([{ status: "DRAFT" }, { status: "FINALIZED" }]);
  });

  it("leaves failed deletions retryable and succeeds on a later idempotent pass", async () => {
    const fixture = await draft("99-9304-04", "retry.pdf");
    const now = new Date("2027-09-08T00:00:00.000Z");
    await pool.query(
      "UPDATE student_result_submissions SET last_activity_at='2027-09-01T00:00:00Z' WHERE id=$1",
      [fixture.file.submissionId],
    );
    const failingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async () => { throw new Error("synthetic cleanup failure"); },
    };
    await expect(cleanupExpiredResultDrafts(now, failingStorage)).resolves.toEqual({ expiredDraftCount: 0, deletionFailureCount: 1 });
    const pending = await pool.query(
      "SELECT storage_delete_pending, delete_error FROM student_result_files WHERE id=$1",
      [fixture.file.id],
    );
    expect(pending.rows).toEqual([{ storage_delete_pending: true, delete_error: "synthetic cleanup failure" }]);
    await expect(cleanupExpiredResultDrafts(now, storage)).resolves.toEqual({ expiredDraftCount: 1, deletionFailureCount: 0 });
  });

  it("retries physical deletion markers left by invalidation", async () => {
    const fixture = await draft("99-9305-05", "invalidated.pdf");
    const finalized = await finalizeStudentResultSubmission("99-9305-05", fixture.appointmentId, storage);
    const failingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async () => { throw new Error("invalidation delete failed"); },
    };
    await invalidateStudentResultSubmission(finalized.id, "Wrong document", admin, failingStorage);
    await cleanupExpiredResultDrafts(new Date(), storage);
    const fileState = await pool.query(
      "SELECT storage_delete_pending, deleted_at IS NOT NULL AS deleted FROM student_result_files WHERE id=$1",
      [fixture.file.id],
    );
    expect(fileState.rows).toEqual([{ storage_delete_pending: false, deleted: true }]);
    await expect(storage.read(fixture.file.storageKey)).rejects.toThrow();
  });

  it("retries a removed file while its parent draft remains active", async () => {
    const fixture = await draft("99-9306-06", "removed.pdf");
    const failingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async () => { throw new Error("draft removal delete failed"); },
    };
    await removeStudentResultFile(
      "99-9306-06",
      fixture.appointmentId,
      fixture.file.id,
      failingStorage,
    );

    await cleanupExpiredResultDrafts(new Date(), storage);
    const state = await pool.query(
      `SELECT file.storage_delete_pending, file.deleted_at IS NOT NULL AS deleted,
              submission.status
         FROM student_result_files file
         JOIN student_result_submissions submission ON submission.id=file.submission_id
        WHERE file.id=$1`,
      [fixture.file.id],
    );
    expect(state.rows).toEqual([{
      storage_delete_pending: false,
      deleted: true,
      status: "DRAFT",
    }]);
    await expect(storage.read(fixture.file.storageKey)).rejects.toThrow();
  });
});

describe("startResultDraftCleanupWorker", () => {
  it("runs at startup, schedules daily, and unreferences the timer", async () => {
    const cleanupDrafts = vi.fn().mockResolvedValue({ expiredDraftCount: 0, deletionFailureCount: 0 });
    const schedule = vi.fn(() => ({ unref: vi.fn() }));
    expect(startResultDraftCleanupWorker({ cleanupDrafts, schedule })).toBe(true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), RESULT_DRAFT_CLEANUP_INTERVAL_MS);
    expect(schedule.mock.results[0].value.unref).toHaveBeenCalledOnce();
    expect(startResultDraftCleanupWorker({ cleanupDrafts, schedule })).toBe(false);
  });
});
