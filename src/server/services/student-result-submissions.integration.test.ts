// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  deletePendingResultPlaceholder,
  getAppointmentResultCorrectionState,
  invalidateFinalizedSubmissionMetadata,
  loadAppointmentResultProtectionStates,
  lockCurrentFinalizedSubmissionForInvalidation,
  lockExpectedStudentResultDraft,
  lockFinalizedSubmissionForInvalidation,
  lockOrCreateStudentResultDraft,
} from "@/server/repositories/student-result-submissions.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { getCurrentEffectiveAppointmentsForStudent } from "@/server/repositories/current-effective-appointments.repository";
import { publishBatch } from "@/server/repositories/appointments.repository";
import { LocalResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";
import {
  addStudentResultFiles,
  beginStudentResultEdit,
  cancelStudentResultEdit,
  createAdminSubmissionZip,
  createAdminSubmissionZipStream,
  finalizeStudentResultSubmission as finalizeExpectedStudentResultSubmission,
  getAdminStudentResultProfile,
  getAdminStudentResultFile,
  getAdminSubmissionResultFile,
  getAdminSubmissionStudentNumber,
  getStudentResultFile,
  getStudentResultSubmission,
  invalidateStudentResultSubmission,
  listAdminStudentResultProfiles,
  removeStudentResultFile as removeExpectedStudentResultFile,
  submitStudentResultChanges,
} from "./student-result-submissions.service";
import { cleanupExpiredResultDrafts } from "@/server/workers/result-draft-cleanup.worker";

const studentPattern = "99-94%";
let storageRoot = "";
let storage: LocalResultStorage;

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
};
const coordinator: SessionUser = {
  userId: "00000000-0000-4000-8000-000000000003",
  fullName: "Schedule Coordinator",
  email: "coordinator@medclinic.local",
  role: "COORDINATOR",
};

async function cleanup() {
  await pool.query("DELETE FROM student_result_storage_cleanup_intents");
  await cleanupTestFixtures(studentPattern, "TEST-RESULT-DRAFT%", "TEST-RESULT-DRAFT%");
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), "medclinic-result-drafts-"));
    storage = new LocalResultStorage(storageRoot);
  }
}

async function appointment(
  studentNumber: string,
  status: "PENDING" | "COMPLETED" = "COMPLETED",
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM" = "LABORATORY",
  appointmentDate = "2027-08-02",
) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by
     ) VALUES ($1,$2,$3,$4,$5,TRUE,$6)
     RETURNING id`,
    [
      scheduleType === "LABORATORY"
        ? TEST_REFERENCE_IDS.laboratoryClinic
        : TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      scheduleType,
      appointmentDate,
      status,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

function file(filename = "result.pdf", body = "%PDF-1.7\nsynthetic result") {
  return { filename, declaredMimeType: "application/pdf", bytes: Buffer.from(body) };
}

function textFile(filename = "notes.txt") {
  return { filename, declaredMimeType: "text/plain", bytes: Buffer.from("synthetic notes") };
}

function pdfOfSize(filename: string, byteSize: number) {
  const bytes = Buffer.alloc(byteSize, 0x78);
  bytes.write("%PDF-", 0, "ascii");
  return { filename, declaredMimeType: "application/pdf", bytes };
}

async function addStudentResultFile(
  studentNumber: string,
  appointmentId: string,
  upload: ReturnType<typeof file>,
  targetStorage: ResultStorage = storage,
) {
  const before = await getStudentResultSubmission(studentNumber, appointmentId);
  const knownFileIds = new Set(before.files.map((existing) => existing.id));
  const refreshed = await addStudentResultFiles(
    studentNumber,
    appointmentId,
    before.id,
    [upload],
    targetStorage,
  );
  const added = refreshed.files.find((candidate) => !knownFileIds.has(candidate.id));
  if (!added) throw new Error("Expected the single-file test helper to add one result file.");
  return added;
}

async function removeStudentResultFile(
  studentNumber: string,
  appointmentId: string,
  fileId: string,
  targetStorage: ResultStorage = storage,
) {
  const current = await getStudentResultSubmission(studentNumber, appointmentId);
  return removeExpectedStudentResultFile(
    studentNumber,
    appointmentId,
    current.id,
    fileId,
    targetStorage,
  );
}

async function finalizeStudentResultSubmission(
  studentNumber: string,
  appointmentId: string,
  targetStorage: ResultStorage = storage,
) {
  const current = await getStudentResultSubmission(studentNumber, appointmentId);
  return finalizeExpectedStudentResultSubmission(
    studentNumber,
    appointmentId,
    current.id,
    targetStorage,
  );
}

async function finalizedResultFixture(
  studentNumber: string,
  filenames: string[],
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM" = "LABORATORY",
) {
  await insertTestStudent({
    studentNumber,
    firstName: "Editing",
    lastName: "Student",
    yearLevel: 3,
  });
  const appointmentId = await appointment(studentNumber, "COMPLETED", scheduleType);
  const draft = await getStudentResultSubmission(studentNumber, appointmentId);
  const uploads = filenames.map((filename, index) => (
    file(filename, `%PDF-1.7\n${filename}-${index}`)
  ));
  const withFiles = await addStudentResultFiles(
    studentNumber,
    appointmentId,
    draft.id,
    uploads,
    storage,
  );
  const official = await finalizeExpectedStudentResultSubmission(
    studentNumber,
    appointmentId,
    withFiles.id,
    storage,
  );
  return { appointmentId, official, uploads };
}

async function invalidationSnapshot(submissionId: string) {
  const result = await pool.query(
    `SELECT submission.status,
            submission.invalidated_at::text AS "invalidatedAt",
            submission.invalidation_reason AS "invalidationReason",
            result.result_status AS "resultStatus",
            result.completed_at::text AS "completedAt",
            result.encoded_by::text AS "encodedBy",
            file.storage_delete_pending AS "storageDeletePending",
            file.deleted_at::text AS "deletedAt",
            file.delete_error AS "deleteError",
            (SELECT COUNT(*)::int
               FROM student_portal_notifications notification
              WHERE notification.student_number=submission.student_number
                AND notification.notification_type='RESULT_INVALIDATED') AS notifications,
            (SELECT COUNT(*)::int
              FROM audit_logs audit
              WHERE audit.action='STUDENT_RESULT_SUBMISSION_INVALIDATED'
                AND audit.entity_id=submission.id::text) AS audits
       FROM student_result_submissions submission
       JOIN laboratory_results result ON result.appointment_id=submission.appointment_id
       JOIN student_result_files file ON file.submission_id=submission.id
      WHERE submission.id=$1`,
    [submissionId],
  );
  return result.rows;
}

async function waitForClientLock(observer: PoolClient, clientPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const activity = await observer.query<{ waitEventType: string | null }>(
      `SELECT wait_event_type AS "waitEventType"
         FROM pg_stat_activity
        WHERE pid=$1`,
      [clientPid],
    );
    if (activity.rows[0]?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the concurrent transaction to block on a database lock.");
}

async function waitForAdvisoryLockWaiter(
  observer: PoolClient,
  taskSettled: () => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const locks = await observer.query<{ waiting: number }>(
      `SELECT COUNT(*)::int AS waiting
         FROM pg_locks
        WHERE locktype='advisory' AND granted=FALSE`,
    );
    if (locks.rows[0].waiting > 0) return;
    if (taskSettled()) {
      throw new Error("The concurrent operation completed without waiting on the appointment-scope advisory lock.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the appointment-scope advisory lock.");
}

async function runWithAfterNextTransactionCommit<T>(
  work: () => Promise<T>,
  afterCommit: () => Promise<void>,
) {
  const originalConnectMethod = pool.connect;
  const originalConnect = pool.connect.bind(pool);
  const client = await originalConnect();
  let commitObserved = false;
  const commitHookClient = new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (!commitObserved && args[0] === "COMMIT") {
            commitObserved = true;
            await afterCommit();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
  let providedCommitHookClient = false;
  pool.connect = ((...args: unknown[]) => {
    if (args.length) return Reflect.apply(originalConnectMethod, pool, args);
    if (!providedCommitHookClient) {
      providedCommitHookClient = true;
      pool.connect = originalConnectMethod;
      return Promise.resolve(commitHookClient);
    }
    return originalConnect();
  }) as typeof pool.connect;

  try {
    const result = await work();
    if (!commitObserved) throw new Error("Expected the service transaction to commit.");
    return result;
  } finally {
    pool.connect = originalConnectMethod;
    if (!providedCommitHookClient) client.release();
  }
}

async function generatedDraftAppointment(studentNumber: string, suffix: string) {
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO schedule_batches (clinic_id, batch_name, status, created_by)
     VALUES ($1,$2,'GENERATED',$3)
     RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, `TEST-RESULT-DRAFT-${suffix}`, TEST_REFERENCE_IDS.adminUser],
  );
  const draft = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       batch_id, clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by
     ) VALUES ($1,$2,$3,'LABORATORY','2027-08-03','DRAFT',FALSE,$4)
     RETURNING id`,
    [batch.rows[0].id, TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, TEST_REFERENCE_IDS.adminUser],
  );
  return { batchId: batch.rows[0].id, appointmentId: draft.rows[0].id };
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "medclinic-result-drafts-"));
  storage = new LocalResultStorage(storageRoot);
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanupTestFixtures(studentPattern, "TEST-RESULT-DRAFT%", "TEST-RESULT-DRAFT%");
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe("student result edit creation", () => {
  it("copies every verified official file into one idempotent edit draft", async () => {
    const studentNumber = "99-9440-40";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["official-first.pdf", "official-second.pdf"],
    );

    const first = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const repeated = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);

    expect(repeated.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "DRAFT",
      basedOnSubmissionId: fixture.official.id,
      fileCount: 2,
      administratorReplacementReason: null,
      officialSubmission: {
        id: fixture.official.id,
        fileCount: 2,
        files: fixture.official.files.map((officialFile) => ({
          id: officialFile.id,
          originalFilename: officialFile.originalFilename,
        })),
      },
    });
    expect(first.files.map((copied) => copied.originalFilename).sort()).toEqual([
      "official-first.pdf",
      "official-second.pdf",
    ].sort());
    expect(first.files.map((copied) => copied.storageKey)).not.toEqual(
      fixture.official.files.map((official) => official.storageKey),
    );
    await expect(getStudentResultFile(
      studentNumber,
      fixture.official.files[0].id,
      storage,
    )).resolves.toMatchObject({ filename: fixture.official.files[0].originalFilename });
    await expect(getStudentResultFile(studentNumber, first.files[0].id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    const rows = await pool.query<{ draftCount: number; finalizedCount: number }>(
      `SELECT COUNT(*) FILTER (
                WHERE status='DRAFT' AND discarded_at IS NULL
              )::int AS "draftCount",
              COUNT(*) FILTER (WHERE status='FINALIZED')::int AS "finalizedCount"
         FROM student_result_submissions
        WHERE appointment_id=$1`,
      [fixture.appointmentId],
    );
    expect(rows.rows).toEqual([{ draftCount: 1, finalizedCount: 1 }]);
    const audits = await pool.query<{
      actorUserId: string | null;
      entityId: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id::text AS "actorUserId", entity_id AS "entityId", metadata
         FROM audit_logs
        WHERE action='STUDENT_RESULT_EDIT_STARTED' AND entity_id=$1`,
      [first.id],
    );
    expect(audits.rows).toEqual([{
      actorUserId: null,
      entityId: first.id,
      metadata: {
        appointmentId: fixture.appointmentId,
        basedOnSubmissionId: fixture.official.id,
        resultType: "LABORATORY",
        fileCount: first.fileCount,
        totalBytes: first.totalBytes,
      },
    }]);
    expect(JSON.stringify(audits.rows[0].metadata)).not.toMatch(/filename|checksum|content/i);
  });

  it("arms every copy key before the first write and disarms them atomically on success", async () => {
    const studentNumber = "99-9464-64";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["intent-first.pdf", "intent-second.pdf"],
    );
    const writeKeys: string[] = [];
    const cleanupDeleteKeys: string[] = [];
    let visibleBeforeFirstWrite: Array<{
      storageKey: string;
      notBefore: Date;
      claimToken: string | null;
    }> = [];
    let inFlightCleanupResult: {
      expiredDraftCount: number;
      deletionFailureCount: number;
    } | null = null;
    const cleanupStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: storage.write.bind(storage),
      delete: async (storageKey) => {
        cleanupDeleteKeys.push(storageKey);
        await storage.delete(storageKey);
      },
    };
    const trackingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === 1) {
          const draftPrefix = storageKey.slice(0, storageKey.indexOf("/"));
          const visible = await pool.query<{
            storageKey: string;
            notBefore: Date;
            claimToken: string | null;
          }>(
            `SELECT storage_key AS "storageKey", not_before AS "notBefore",
                    claim_token::text AS "claimToken"
               FROM student_result_storage_cleanup_intents
              WHERE storage_key LIKE $1
              ORDER BY storage_key`,
            [`${draftPrefix}/%`],
          );
          visibleBeforeFirstWrite = visible.rows;
          if (visibleBeforeFirstWrite.length) {
            inFlightCleanupResult = await cleanupExpiredResultDrafts(
              new Date(Math.max(
                ...visibleBeforeFirstWrite.map((intent) => intent.notBefore.getTime()),
              ) + 1),
              cleanupStorage,
            );
          }
        }
        await storage.write(storageKey, bytes);
      },
      delete: storage.delete.bind(storage),
    };

    const edit = await beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      trackingStorage,
    );

    expect(writeKeys).toHaveLength(2);
    expect(writeKeys.every((storageKey) => (
      visibleBeforeFirstWrite.some((intent) => intent.storageKey === storageKey)
    ))).toBe(true);
    expect(visibleBeforeFirstWrite.length).toBeGreaterThanOrEqual(writeKeys.length);
    expect(visibleBeforeFirstWrite.every((intent) => (
      intent.notBefore.getTime() > Date.now() && intent.claimToken === null
    ))).toBe(true);
    expect(inFlightCleanupResult).toEqual({ expiredDraftCount: 0, deletionFailureCount: 0 });
    expect(cleanupDeleteKeys).toEqual([]);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key = ANY($1::text[])",
      [visibleBeforeFirstWrite.map((intent) => intent.storageKey)],
    )).resolves.toMatchObject({ rowCount: 0 });

    const afterIntentBecomesDue = new Date(
      Math.max(...visibleBeforeFirstWrite.map((intent) => intent.notBefore.getTime())) + 1,
    );
    await cleanupExpiredResultDrafts(afterIntentBecomesDue, cleanupStorage);
    expect(cleanupDeleteKeys).toEqual([]);
    const copiedBodies = await Promise.all(edit.files.map(async (copied) => (
      (await storage.read(copied.storageKey)).toString("utf8")
    )));
    expect(copiedBodies.sort()).toEqual(
      fixture.uploads.map((upload) => upload.bytes.toString("utf8")).sort(),
    );
  });

  it("preserves committed edit files when the COMMIT response is lost", async () => {
    const studentNumber = "99-9465-65";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["commit-first.pdf", "commit-second.pdf"],
    );
    const originalConnectMethod = pool.connect;
    const originalConnect = pool.connect.bind(pool);
    const client = await originalConnect();
    const ambiguousClient = new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.query, target, args);
            if (args[0] === "COMMIT") {
              throw new Error("synthetic COMMIT response lost");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
    let providedAmbiguousClient = false;
    pool.connect = ((...args: unknown[]) => {
      if (args.length) {
        return Reflect.apply(originalConnectMethod, pool, args);
      }
      if (!providedAmbiguousClient) {
        providedAmbiguousClient = true;
        pool.connect = originalConnectMethod;
        return Promise.resolve(ambiguousClient);
      }
      return originalConnect();
    }) as typeof pool.connect;

    try {
      await expect(beginStudentResultEdit(
        studentNumber,
        fixture.appointmentId,
        storage,
      )).rejects.toThrow("synthetic COMMIT response lost");
    } finally {
      pool.connect = originalConnectMethod;
    }

    const committed = await pool.query<{
      id: string;
      storageKey: string;
      deletedAt: Date | null;
    }>(
      `SELECT submission.id, file.storage_key AS "storageKey",
              file.deleted_at AS "deletedAt"
         FROM student_result_submissions submission
         JOIN student_result_files file ON file.submission_id=submission.id
        WHERE submission.appointment_id=$1
          AND submission.status='DRAFT'
          AND submission.discarded_at IS NULL
        ORDER BY file.uploaded_at, file.id`,
      [fixture.appointmentId],
    );
    expect(committed.rows).toHaveLength(2);
    expect(committed.rows.every((row) => row.deletedAt === null)).toBe(true);
    await expect(Promise.all(
      committed.rows.map((row) => storage.read(row.storageKey)),
    )).resolves.toHaveLength(2);
    await expect(pool.query(
      `SELECT storage_key
         FROM student_result_storage_cleanup_intents
        WHERE storage_key = ANY($1::text[])`,
      [committed.rows.map((row) => row.storageKey)],
    )).resolves.toMatchObject({ rowCount: 0 });
  }, 15_000);

  it("rolls back the edit draft and every generated key after a partial copy write failure", async () => {
    const studentNumber = "99-9441-41";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["copy-first.pdf", "copy-second.pdf", "copy-third.pdf"],
    );
    const writeKeys: string[] = [];
    const deleteKeys: string[] = [];
    const failingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === 2) throw new Error("synthetic edit copy failure");
        await storage.write(storageKey, bytes);
      },
      delete: async (storageKey) => {
        deleteKeys.push(storageKey);
        await storage.delete(storageKey);
      },
    };

    await expect(beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      failingStorage,
    )).rejects.toThrow("synthetic edit copy failure");

    expect(writeKeys).toHaveLength(2);
    expect(deleteKeys).toEqual(expect.arrayContaining(writeKeys));
    for (const storageKey of writeKeys) {
      await expect(storage.read(storageKey)).rejects.toThrow();
    }
    const draftRows = await pool.query(
      `SELECT submission.id
         FROM student_result_submissions submission
        WHERE submission.appointment_id=$1
          AND submission.status='DRAFT'`,
      [fixture.appointmentId],
    );
    expect(draftRows.rows).toEqual([]);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key = ANY($1::text[])",
      [deleteKeys],
    )).resolves.toMatchObject({ rowCount: 0 });
    const preservedOfficialBodies = await Promise.all(
      fixture.official.files.map(async (officialFile) => (
        (await storage.read(officialFile.storageKey)).toString("utf8")
      )),
    );
    expect(preservedOfficialBodies.sort()).toEqual(
      fixture.uploads.map((upload) => upload.bytes.toString("utf8")).sort(),
    );
  });

  it("durably retries a copied key when rollback deletion fails", async () => {
    const studentNumber = "99-9449-49";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["rollback-first.pdf", "rollback-second.pdf"],
    );
    const writeKeys: string[] = [];
    let failRollbackDelete = true;
    const failingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === 2) throw new Error("synthetic edit copy failure");
        await storage.write(storageKey, bytes);
      },
      delete: async (storageKey) => {
        if (failRollbackDelete && storageKey === writeKeys[0]) {
          throw new Error("synthetic rollback delete failure");
        }
        await storage.delete(storageKey);
      },
    };

    await expect(beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      failingStorage,
    )).rejects.toThrow("synthetic edit copy failure");

    const cleanupIntent = await pool.query<{
      storageKey: string;
      notBefore: Date;
      claimToken: string | null;
      deleteError: string | null;
    }>(
      `SELECT storage_key AS "storageKey", not_before AS "notBefore",
              claim_token::text AS "claimToken", delete_error AS "deleteError"
         FROM student_result_storage_cleanup_intents
        WHERE storage_key = ANY($1::text[])`,
      [writeKeys],
    );
    expect(cleanupIntent.rows).toEqual([{
      storageKey: writeKeys[0],
      notBefore: expect.any(Date),
      claimToken: null,
      deleteError: "synthetic rollback delete failure",
    }]);
    const activeDrafts = await pool.query(
      `SELECT id FROM student_result_submissions
        WHERE appointment_id=$1 AND status='DRAFT'`,
      [fixture.appointmentId],
    );
    expect(activeDrafts.rows).toEqual([]);
    const strandedBody = await storage.read(writeKeys[0]);
    expect(fixture.uploads.map((upload) => upload.bytes.toString("utf8"))).toContain(
      strandedBody.toString("utf8"),
    );

    failRollbackDelete = false;
    await expect(cleanupExpiredResultDrafts(
      new Date(cleanupIntent.rows[0].notBefore.getTime() + 1),
      failingStorage,
    )).resolves.toEqual({
      expiredDraftCount: 0,
      deletionFailureCount: 0,
    });
    await expect(storage.read(writeKeys[0])).rejects.toThrow();
    const afterRetry = await pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key=$1",
      [writeKeys[0]],
    );
    expect(afterRetry.rows).toEqual([]);
    const preservedOfficialBodies = await Promise.all(
      fixture.official.files.map(async (officialFile) => (
        (await storage.read(officialFile.storageKey)).toString("utf8")
      )),
    );
    expect(preservedOfficialBodies.sort()).toEqual(
      fixture.uploads.map((upload) => upload.bytes.toString("utf8")).sort(),
    );
  });

  it("rejects an edit when an official object checksum no longer matches without copying anything", async () => {
    const studentNumber = "99-9442-42";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["checksum-first.pdf", "checksum-second.pdf"],
    );
    await storage.write(
      fixture.official.files[1].storageKey,
      Buffer.from("%PDF-1.7\nchanged official bytes"),
    );
    const writeKeys: string[] = [];
    const deleteKeys: string[] = [];
    const trackingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        await storage.write(storageKey, bytes);
      },
      delete: async (storageKey) => {
        deleteKeys.push(storageKey);
        await storage.delete(storageKey);
      },
    };

    await expect(beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_INTEGRITY_ERROR", status: 500 });

    expect(writeKeys).toHaveLength(1);
    expect(deleteKeys).toEqual(expect.arrayContaining(writeKeys));
    await expect(storage.read(writeKeys[0])).rejects.toThrow();
    const drafts = await pool.query(
      `SELECT id FROM student_result_submissions
        WHERE appointment_id=$1 AND status='DRAFT'`,
      [fixture.appointmentId],
    );
    expect(drafts.rows).toEqual([]);
  });

  it("rejects a repeated edit request whose draft is based on a replaced official", async () => {
    const studentNumber = "99-9443-43";
    const fixture = await finalizedResultFixture(studentNumber, ["old-official.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const replacement = await transaction(async (client) => {
      await client.query(
        `UPDATE student_result_submissions
            SET status='SUPERSEDED', superseded_at=NOW(), superseded_by_submission_id=$2
          WHERE id=$1`,
        [fixture.official.id, edit.id],
      );
      return client.query<{ id: string }>(
        `INSERT INTO student_result_submissions (
           appointment_id, student_number, result_type, status, finalized_at
         ) VALUES ($1,$2,'LABORATORY','FINALIZED',NOW())
         RETURNING id`,
        [fixture.appointmentId, studentNumber],
      );
    });

    await expect(beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(cancelStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });

    const active = await pool.query(
      `SELECT id, based_on_submission_id::text AS "basedOnSubmissionId"
         FROM student_result_submissions
        WHERE appointment_id=$1 AND status='DRAFT' AND discarded_at IS NULL`,
      [fixture.appointmentId],
    );
    expect(active.rows).toEqual([{
      id: edit.id,
      basedOnSubmissionId: fixture.official.id,
    }]);
    expect(replacement.rows[0].id).not.toBe(fixture.official.id);
  });

  it("denies an edit request for another student's appointment before storage access", async () => {
    const studentNumber = "99-9444-44";
    const otherStudentNumber = "99-9445-45";
    const fixture = await finalizedResultFixture(studentNumber, ["owned.pdf"]);
    await insertTestStudent({
      studentNumber: otherStudentNumber,
      firstName: "Other",
      lastName: "Student",
      yearLevel: 3,
    });
    let storageCalls = 0;
    const trackingStorage: ResultStorage = {
      read: async () => {
        storageCalls += 1;
        throw new Error("unexpected read");
      },
      write: async () => { storageCalls += 1; },
      delete: async () => { storageCalls += 1; },
    };

    await expect(beginStudentResultEdit(
      otherStudentNumber,
      fixture.appointmentId,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    expect(storageCalls).toBe(0);
  });

  it("rejects a conflicting normal draft before edit storage access", async () => {
    const studentNumber = "99-9461-61";
    await insertTestStudent({
      studentNumber,
      firstName: "Normal",
      lastName: "Draft",
      yearLevel: 3,
    });
    const appointmentId = await appointment(studentNumber);
    const normalDraft = await getStudentResultSubmission(studentNumber, appointmentId);
    let storageCalls = 0;
    const trackingStorage: ResultStorage = {
      read: async () => {
        storageCalls += 1;
        throw new Error("unexpected read");
      },
      write: async () => { storageCalls += 1; },
      delete: async () => { storageCalls += 1; },
    };

    await expect(beginStudentResultEdit(
      studentNumber,
      appointmentId,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    expect(storageCalls).toBe(0);
    await expect(getStudentResultSubmission(studentNumber, appointmentId)).resolves.toEqual(normalDraft);
  });

  it("normalizes an invalidation racing with a stale Edit click to RESULT_EDIT_STALE", async () => {
    const studentNumber = "99-9487-87";
    const fixture = await finalizedResultFixture(studentNumber, ["invalidated-before-edit.pdf"]);
    await invalidateStudentResultSubmission(
      fixture.official.id,
      "Replacement required",
      admin,
      storage,
    );
    let storageCalls = 0;
    const trackingStorage: ResultStorage = {
      read: async () => {
        storageCalls += 1;
        throw new Error("unexpected read");
      },
      write: async () => { storageCalls += 1; },
      delete: async () => { storageCalls += 1; },
    };

    await expect(beginStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    expect(storageCalls).toBe(0);
    await expect(pool.query(
      `SELECT status FROM student_result_submissions
        WHERE appointment_id=$1
        ORDER BY created_at, id`,
      [fixture.appointmentId],
    )).resolves.toMatchObject({ rows: [{ status: "INVALIDATED" }] });
  });

  it("serializes simultaneous edit creation into one copied draft", async () => {
    const studentNumber = "99-9446-46";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["concurrent-first.pdf", "concurrent-second.pdf"],
    );
    let writeCalls = 0;
    const trackingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeCalls += 1;
        await storage.write(storageKey, bytes);
      },
      delete: storage.delete.bind(storage),
    };

    const [first, second] = await Promise.all([
      beginStudentResultEdit(studentNumber, fixture.appointmentId, trackingStorage),
      beginStudentResultEdit(studentNumber, fixture.appointmentId, trackingStorage),
    ]);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ fileCount: 2, basedOnSubmissionId: fixture.official.id });
    expect(writeCalls).toBe(2);
    const drafts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM student_result_submissions
        WHERE appointment_id=$1 AND status='DRAFT' AND discarded_at IS NULL`,
      [fixture.appointmentId],
    );
    expect(drafts.rows).toEqual([{ count: 1 }]);
  });
});

describe("student result edit retirement", () => {
  it("cancels only the edit draft and removes its copied objects after successful cleanup", async () => {
    const studentNumber = "99-9447-47";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["cancel-first.pdf", "cancel-second.pdf"],
    );
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const copiedKeys = edit.files.map((copied) => copied.storageKey);
    const officialBodies = await Promise.all(fixture.official.files.map(async (officialFile) => (
      storage.read(officialFile.storageKey)
    )));

    await expect(cancelStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).resolves.toEqual({ success: true });

    const submissions = await pool.query(
      `SELECT id, status, discarded_at::text AS "discardedAt"
         FROM student_result_submissions
        WHERE appointment_id=$1
        ORDER BY status, id`,
      [fixture.appointmentId],
    );
    expect(submissions.rows).toEqual([{
      id: fixture.official.id,
      status: "FINALIZED",
      discardedAt: null,
    }]);
    for (const copiedKey of copiedKeys) {
      await expect(storage.read(copiedKey)).rejects.toThrow();
    }
    for (const [index, officialFile] of fixture.official.files.entries()) {
      await expect(storage.read(officialFile.storageKey)).resolves.toEqual(officialBodies[index]);
    }
    const audit = await pool.query<{ actorUserId: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id::text AS "actorUserId", metadata
         FROM audit_logs
        WHERE action='STUDENT_RESULT_EDIT_CANCELLED' AND entity_id=$1`,
      [edit.id],
    );
    expect(audit.rows).toEqual([{
      actorUserId: null,
      metadata: {
        appointmentId: fixture.appointmentId,
        basedOnSubmissionId: fixture.official.id,
        resultType: "LABORATORY",
        fileCount: edit.fileCount,
        totalBytes: edit.totalBytes,
      },
    }]);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/filename|checksum|content/i);
  });

  it("tombstones a cancelled edit with retryable file cleanup and rejects its stale tab", async () => {
    const studentNumber = "99-9448-48";
    const fixture = await finalizedResultFixture(studentNumber, ["cancel-retry.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const failingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: storage.write.bind(storage),
      delete: async () => { throw new Error("synthetic edit cancellation delete failure"); },
    };

    await expect(cancelStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      failingStorage,
    )).resolves.toEqual({ success: true });

    const retired = await pool.query(
      `SELECT submission.discarded_at IS NOT NULL AS discarded,
              file.storage_delete_pending AS "storageDeletePending",
              file.deleted_at::text AS "deletedAt",
              file.delete_error AS "deleteError"
         FROM student_result_submissions submission
         JOIN student_result_files file ON file.submission_id=submission.id
        WHERE submission.id=$1`,
      [edit.id],
    );
    expect(retired.rows).toEqual([{
      discarded: true,
      storageDeletePending: true,
      deletedAt: null,
      deleteError: "synthetic edit cancellation delete failure",
    }]);
    await expect(getStudentResultSubmission(studentNumber, fixture.appointmentId)).resolves.toMatchObject({
      id: fixture.official.id,
      status: "FINALIZED",
    });

    const replacementEdit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await expect(cancelStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(getStudentResultSubmission(studentNumber, fixture.appointmentId)).resolves.toMatchObject({
      id: replacementEdit.id,
      basedOnSubmissionId: fixture.official.id,
      fileCount: 1,
    });

    await cleanupExpiredResultDrafts(new Date(), storage);
    await expect(pool.query(
      "SELECT id FROM student_result_submissions WHERE id=$1",
      [edit.id],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(storage.read(edit.files[0].storageKey)).rejects.toThrow();
    await expect(storage.read(replacementEdit.files[0].storageKey)).resolves.toEqual(
      fixture.uploads[0].bytes,
    );
  });

  it("retires the related edit when an administrator invalidates its official submission", async () => {
    const studentNumber = "99-9449-49";
    const fixture = await finalizedResultFixture(studentNumber, ["invalidation-official.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);

    await expect(invalidateStudentResultSubmission(
      fixture.official.id,
      "Document belongs to another student",
      admin,
      storage,
    )).resolves.toMatchObject({ id: fixture.official.id, status: "INVALIDATED" });

    const lifecycle = await pool.query(
      `SELECT id, status, discarded_at::text AS "discardedAt"
         FROM student_result_submissions
        WHERE appointment_id=$1
        ORDER BY status, id`,
      [fixture.appointmentId],
    );
    expect(lifecycle.rows).toEqual([{
      id: fixture.official.id,
      status: "INVALIDATED",
      discardedAt: null,
    }]);
    await expect(storage.read(edit.files[0].storageKey)).rejects.toThrow();

    const replacement = await getStudentResultSubmission(studentNumber, fixture.appointmentId);
    expect(replacement).toMatchObject({
      status: "DRAFT",
      basedOnSubmissionId: null,
      fileCount: 0,
      administratorReplacementReason: "Document belongs to another student",
    });
    await expect(cancelStudentResultEdit(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(getStudentResultSubmission(studentNumber, fixture.appointmentId)).resolves.toEqual(replacement);
    const audit = await pool.query<{
      actorUserId: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id::text AS "actorUserId", metadata
         FROM audit_logs
        WHERE action='STUDENT_RESULT_EDIT_CANCELLED_BY_INVALIDATION' AND entity_id=$1`,
      [edit.id],
    );
    expect(audit.rows).toEqual([{
      actorUserId: admin.userId,
      metadata: {
        appointmentId: fixture.appointmentId,
        basedOnSubmissionId: fixture.official.id,
        resultType: "LABORATORY",
        fileCount: edit.fileCount,
        totalBytes: edit.totalBytes,
      },
    }]);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/filename|checksum|content/i);
  });
});

describe("student result edit promotion", () => {
  it("rejects cross-student cancel and submit attempts before storage access", async () => {
    const studentNumber = "99-9462-62";
    const otherStudentNumber = "99-9463-63";
    const fixture = await finalizedResultFixture(studentNumber, ["owner-only.pdf"]);
    await insertTestStudent({
      studentNumber: otherStudentNumber,
      firstName: "Other",
      lastName: "Editor",
      yearLevel: 3,
    });
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    let storageCalls = 0;
    const trackingStorage: ResultStorage = {
      read: async () => {
        storageCalls += 1;
        throw new Error("unexpected read");
      },
      write: async () => { storageCalls += 1; },
      delete: async () => { storageCalls += 1; },
    };

    await expect(cancelStudentResultEdit(
      otherStudentNumber,
      fixture.appointmentId,
      edit.id,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    await expect(submitStudentResultChanges(
      otherStudentNumber,
      fixture.appointmentId,
      edit.id,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });

    expect(storageCalls).toBe(0);
    await expect(getStudentResultSubmission(studentNumber, fixture.appointmentId)).resolves.toMatchObject({
      id: edit.id,
      basedOnSubmissionId: fixture.official.id,
    });
  });

  it("atomically supersedes the official and promotes the complete edit on submit changes", async () => {
    const studentNumber = "99-9450-50";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["promote-first.pdf", "promote-second.pdf"],
    );
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const officialBodies = await Promise.all(fixture.official.files.map(async (officialFile) => (
      storage.read(officialFile.storageKey)
    )));

    const promoted = await submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    );

    expect(promoted).toMatchObject({
      id: edit.id,
      status: "FINALIZED",
      basedOnSubmissionId: null,
      fileCount: 2,
    });
    const lifecycle = await pool.query(
      `SELECT id, status, based_on_submission_id::text AS "basedOnSubmissionId",
              superseded_at IS NOT NULL AS superseded,
              superseded_by_submission_id::text AS "supersededBySubmissionId"
         FROM student_result_submissions
        WHERE appointment_id=$1
        ORDER BY status, id`,
      [fixture.appointmentId],
    );
    expect(lifecycle.rows).toEqual(expect.arrayContaining([
      {
        id: promoted.id,
        status: "FINALIZED",
        basedOnSubmissionId: null,
        superseded: false,
        supersededBySubmissionId: null,
      },
      {
        id: fixture.official.id,
        status: "SUPERSEDED",
        basedOnSubmissionId: null,
        superseded: true,
        supersededBySubmissionId: promoted.id,
      },
    ]));
    for (const [index, officialFile] of fixture.official.files.entries()) {
      await expect(storage.read(officialFile.storageKey)).resolves.toEqual(officialBodies[index]);
      await expect(getStudentResultFile(studentNumber, officialFile.id, storage))
        .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    }
    await expect(getStudentResultFile(studentNumber, promoted.files[0].id, storage))
      .resolves.toMatchObject({ filename: promoted.files[0].originalFilename });
    const result = await pool.query(
      `SELECT result_status, completed_at::text AS "completedAt"
         FROM laboratory_results WHERE appointment_id=$1`,
      [fixture.appointmentId],
    );
    expect(result.rows).toEqual([{
      result_status: "COMPLETED",
      completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }]);
    const audit = await pool.query<{ actorUserId: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id::text AS "actorUserId", metadata
         FROM audit_logs
        WHERE action='STUDENT_RESULT_SUBMISSION_REPLACED' AND entity_id=$1`,
      [promoted.id],
    );
    expect(audit.rows).toEqual([{
      actorUserId: null,
      metadata: {
        appointmentId: fixture.appointmentId,
        previousSubmissionId: fixture.official.id,
        resultType: "LABORATORY",
        fileCount: promoted.fileCount,
        totalBytes: promoted.totalBytes,
      },
    }]);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/filename|checksum|content/i);
  });

  it("rejects an edit draft through the initial finalize operation", async () => {
    const studentNumber = "99-9451-51";
    const fixture = await finalizedResultFixture(studentNumber, ["wrong-finalize-path.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);

    await expect(finalizeExpectedStudentResultSubmission(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });

    await expect(getStudentResultSubmission(studentNumber, fixture.appointmentId)).resolves.toMatchObject({
      id: edit.id,
      status: "DRAFT",
      basedOnSubmissionId: fixture.official.id,
    });
  });

  it("rejects submit changes when the edit contains zero active files", async () => {
    const studentNumber = "99-9452-52";
    const fixture = await finalizedResultFixture(studentNumber, ["remove-before-submit.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await removeExpectedStudentResultFile(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      edit.files[0].id,
      storage,
    );

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_FILES_REQUIRED", status: 422 });

    const statuses = await pool.query(
      "SELECT status FROM student_result_submissions WHERE appointment_id=$1 ORDER BY status",
      [fixture.appointmentId],
    );
    expect(statuses.rows).toEqual([{ status: "DRAFT" }, { status: "FINALIZED" }]);
  });

  it("rejects submit changes when a stored edit object is missing", async () => {
    const studentNumber = "99-9453-53";
    const fixture = await finalizedResultFixture(studentNumber, ["missing-edit-object.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await storage.delete(edit.files[0].storageKey);

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_INTEGRITY_ERROR", status: 500 });

    const statuses = await pool.query(
      "SELECT status FROM student_result_submissions WHERE appointment_id=$1 ORDER BY status",
      [fixture.appointmentId],
    );
    expect(statuses.rows).toEqual([{ status: "DRAFT" }, { status: "FINALIZED" }]);
  });

  it("rejects submit changes when an edit object checksum no longer matches", async () => {
    const studentNumber = "99-9454-54";
    const fixture = await finalizedResultFixture(studentNumber, ["changed-edit-object.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await storage.write(
      edit.files[0].storageKey,
      Buffer.from("%PDF-1.7\nchanged after edit creation"),
    );

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_INTEGRITY_ERROR", status: 500 });
  });

  it("rejects submit changes when locked edit metadata disagrees with the file signature", async () => {
    const studentNumber = "99-9455-55";
    const fixture = await finalizedResultFixture(studentNumber, ["metadata-edit-object.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await pool.query(
      "UPDATE student_result_files SET detected_mime_type='image/png' WHERE id=$1",
      [edit.files[0].id],
    );

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_INTEGRITY_ERROR", status: 500 });
  });

  it("rejects submit changes when locked edit rows exceed the file-count limit before storage reads", async () => {
    const studentNumber = "99-9456-56";
    const fixture = await finalizedResultFixture(studentNumber, ["count-limit-edit.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await pool.query(
      `INSERT INTO student_result_files (
         submission_id, storage_key, original_filename, detected_mime_type,
         extension, byte_size, checksum_sha256
       )
       SELECT $1::uuid, $1::uuid::text || '/synthetic-count-' || value::text || '.pdf',
              'synthetic-count.pdf', 'application/pdf', 'pdf', 1, $2
         FROM GENERATE_SERIES(1, 10) value`,
      [edit.id, "a".repeat(64)],
    );
    let readCalls = 0;
    const trackingStorage: ResultStorage = {
      write: storage.write.bind(storage),
      read: async (storageKey) => {
        readCalls += 1;
        return storage.read(storageKey);
      },
      delete: storage.delete.bind(storage),
    };

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_DRAFT_LIMIT_INVALID", status: 422 });
    expect(readCalls).toBe(0);
  });

  it("rejects submit changes when locked edit rows exceed the total-byte limit before storage reads", async () => {
    const studentNumber = "99-9457-57";
    const fixture = await finalizedResultFixture(studentNumber, ["byte-limit-edit.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await pool.query(
      "UPDATE student_result_files SET byte_size=$2 WHERE id=$1",
      [edit.files[0].id, 50 * 1024 * 1024 + 1],
    );
    let readCalls = 0;
    const trackingStorage: ResultStorage = {
      write: storage.write.bind(storage),
      read: async (storageKey) => {
        readCalls += 1;
        return storage.read(storageKey);
      },
      delete: storage.delete.bind(storage),
    };

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_DRAFT_LIMIT_INVALID", status: 422 });
    expect(readCalls).toBe(0);
  });

  it("rejects submit changes when the edit base is no longer the current official", async () => {
    const studentNumber = "99-9458-58";
    const fixture = await finalizedResultFixture(studentNumber, ["stale-base-edit.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    const replacement = await transaction(async (client) => {
      await client.query(
        `UPDATE student_result_submissions
            SET status='SUPERSEDED', superseded_at=NOW(), superseded_by_submission_id=$2
          WHERE id=$1`,
        [fixture.official.id, edit.id],
      );
      return client.query<{ id: string }>(
        `INSERT INTO student_result_submissions (
           appointment_id, student_number, result_type, status, finalized_at
         ) VALUES ($1,$2,'LABORATORY','FINALIZED',NOW())
         RETURNING id`,
        [fixture.appointmentId, studentNumber],
      );
    });

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });

    const unchanged = await pool.query(
      `SELECT id, status, based_on_submission_id::text AS "basedOnSubmissionId"
         FROM student_result_submissions
        WHERE appointment_id=$1
        ORDER BY status, id`,
      [fixture.appointmentId],
    );
    expect(unchanged.rows).toEqual(expect.arrayContaining([
      { id: edit.id, status: "DRAFT", basedOnSubmissionId: fixture.official.id },
      { id: replacement.rows[0].id, status: "FINALIZED", basedOnSubmissionId: null },
    ]));
  });

  it("rejects submit changes after administrator invalidation retired the edit", async () => {
    const studentNumber = "99-9459-59";
    const fixture = await finalizedResultFixture(studentNumber, ["invalidated-base-edit.pdf"]);
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await invalidateStudentResultSubmission(
      fixture.official.id,
      "Invalid document",
      admin,
      storage,
    );

    await expect(submitStudentResultChanges(
      studentNumber,
      fixture.appointmentId,
      edit.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    const state = await pool.query(
      "SELECT status FROM student_result_submissions WHERE appointment_id=$1 ORDER BY status",
      [fixture.appointmentId],
    );
    expect(state.rows).toEqual([{ status: "INVALIDATED" }]);
  });

  it("allows exactly one of two competing submit changes promotions", async () => {
    const studentNumber = "99-9460-60";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["competing-first.pdf", "competing-second.pdf"],
    );
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);

    const outcomes = await Promise.allSettled([
      submitStudentResultChanges(studentNumber, fixture.appointmentId, edit.id, storage),
      submitStudentResultChanges(studentNumber, fixture.appointmentId, edit.id, storage),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => (
      outcome.status === "rejected"
      && outcome.reason?.code === "RESULT_EDIT_STALE"
      && outcome.reason?.status === 409
    ))).toHaveLength(1);
    const counts = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='FINALIZED')::int AS finalized,
              COUNT(*) FILTER (WHERE status='SUPERSEDED')::int AS superseded
         FROM student_result_submissions
        WHERE appointment_id=$1`,
      [fixture.appointmentId],
    );
    expect(counts.rows).toEqual([{ finalized: 1, superseded: 1 }]);
    const audits = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE action='STUDENT_RESULT_SUBMISSION_REPLACED'
          AND entity_id=$1`,
      [edit.id],
    );
    expect(audits.rows).toEqual([{ count: 1 }]);
  });
});

describe("student result drafts", () => {
  it("returns a newly created draft when a replacement publishes immediately after COMMIT", async () => {
    const studentNumber = "99-9488-88";
    await insertTestStudent({ studentNumber, firstName: "Create", lastName: "Race", yearLevel: 3 });
    const appointmentId = await appointment(
      studentNumber,
      "COMPLETED",
      "LABORATORY",
      "2027-08-02",
    );
    let replacementAppointmentId = "";

    const created = await runWithAfterNextTransactionCommit(
      () => getStudentResultSubmission(studentNumber, appointmentId),
      async () => {
        replacementAppointmentId = await appointment(
          studentNumber,
          "PENDING",
          "LABORATORY",
          "2027-08-03",
        );
      },
    );

    expect(created).toMatchObject({ appointmentId, status: "DRAFT" });
    await expect(getCurrentEffectiveAppointmentsForStudent(studentNumber)).resolves.toMatchObject({
      laboratory: { id: replacementAppointmentId, status: "PENDING" },
    });
  });

  it("returns the committed finalization when a replacement publishes immediately after COMMIT", async () => {
    const studentNumber = "99-9489-89";
    await insertTestStudent({ studentNumber, firstName: "Finalize", lastName: "Race", yearLevel: 3 });
    const appointmentId = await appointment(
      studentNumber,
      "COMPLETED",
      "LABORATORY",
      "2027-08-02",
    );
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const populated = await addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [file("finalize-race.pdf")],
      storage,
    );
    let replacementAppointmentId = "";

    const finalized = await runWithAfterNextTransactionCommit(
      () => finalizeExpectedStudentResultSubmission(
        studentNumber,
        appointmentId,
        populated.id,
        storage,
      ),
      async () => {
        replacementAppointmentId = await appointment(
          studentNumber,
          "PENDING",
          "LABORATORY",
          "2027-08-03",
        );
      },
    );

    expect(finalized).toMatchObject({ id: populated.id, appointmentId, status: "FINALIZED" });
    await expect(getCurrentEffectiveAppointmentsForStudent(studentNumber)).resolves.toMatchObject({
      laboratory: { id: replacementAppointmentId, status: "PENDING" },
    });
  });

  it("keeps result scope-to-appointment ordering compatible with a concurrent reschedule", async () => {
    const studentNumber = "99-9490-90";
    await insertTestStudent({ studentNumber, firstName: "Lock", lastName: "Order", yearLevel: 3 });
    const appointmentId = await appointment(
      studentNumber,
      "PENDING",
      "LABORATORY",
      "2027-08-02",
    );
    const resultClient = await pool.connect();
    const observer = await pool.connect();
    let resultTransactionOpen = false;
    let rescheduleTask: Promise<Awaited<ReturnType<typeof updateAppointment>>> | null = null;

    try {
      await resultClient.query("BEGIN");
      resultTransactionOpen = true;
      await resultClient.query("SET LOCAL deadlock_timeout='100ms'");
      await lockEffectiveAppointmentScopes(resultClient, [{
        studentNumber,
        scheduleType: "LABORATORY",
      }]);

      let rescheduleSettled = false;
      rescheduleTask = updateAppointment(appointmentId, {
        appointmentDate: "2027-08-03",
      }, admin).finally(() => { rescheduleSettled = true; });
      await waitForAdvisoryLockWaiter(observer, () => rescheduleSettled);

      await expect(lockOrCreateStudentResultDraft(
        resultClient,
        studentNumber,
        appointmentId,
      )).resolves.toMatchObject({ type: "unavailable" });
      await resultClient.query("COMMIT");
      resultTransactionOpen = false;

      await expect(rescheduleTask).resolves.toMatchObject({
        appointmentDate: "2027-08-03",
        status: "PENDING",
        rescheduledFrom: appointmentId,
      });
    } finally {
      if (resultTransactionOpen) await resultClient.query("ROLLBACK").catch(() => undefined);
      resultClient.release();
      observer.release();
      await rescheduleTask?.catch(() => undefined);
    }
  });

  it("lists and loads only the current effective Laboratory and Physical Examination appointments", async () => {
    const studentNumber = "99-9473-73";
    await insertTestStudent({ studentNumber, firstName: "Current", lastName: "Results", yearLevel: 3 });
    const olderLaboratoryId = await appointment(
      studentNumber,
      "COMPLETED",
      "LABORATORY",
      "2027-08-02",
    );
    const olderPhysicalId = await appointment(
      studentNumber,
      "COMPLETED",
      "PHYSICAL_EXAM",
      "2027-08-02",
    );
    const newerLaboratoryId = await appointment(
      studentNumber,
      "COMPLETED",
      "LABORATORY",
      "2027-08-03",
    );
    const newerPhysicalId = await appointment(
      studentNumber,
      "COMPLETED",
      "PHYSICAL_EXAM",
      "2027-08-03",
    );

    await expect(getCurrentEffectiveAppointmentsForStudent(studentNumber)).resolves.toMatchObject({
      laboratory: { id: newerLaboratoryId, status: "COMPLETED" },
      physicalExam: { id: newerPhysicalId, status: "COMPLETED" },
    });
    await expect(getStudentResultSubmission(studentNumber, olderLaboratoryId))
      .rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    await expect(getStudentResultSubmission(studentNumber, olderPhysicalId))
      .rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    await expect(getStudentResultSubmission(studentNumber, newerLaboratoryId)).resolves.toMatchObject({
      appointmentId: newerLaboratoryId,
      resultType: "LABORATORY",
      status: "DRAFT",
    });
    await expect(getStudentResultSubmission(studentNumber, newerPhysicalId)).resolves.toMatchObject({
      appointmentId: newerPhysicalId,
      resultType: "PHYSICAL_EXAM",
      status: "DRAFT",
    });
  });

  it.each([
    { label: "upload", studentNumber: "99-9474-74", edit: false },
    { label: "remove", studentNumber: "99-9475-75", edit: false },
    { label: "finalize", studentNumber: "99-9476-76", edit: false },
    { label: "cancel", studentNumber: "99-9477-77", edit: true },
    { label: "submit changes", studentNumber: "99-9478-78", edit: true },
  ])("rejects $label against an older appointment without mutating its draft", async ({
    label,
    studentNumber,
    edit,
  }) => {
    await insertTestStudent({ studentNumber, firstName: "Stale", lastName: "Mutation", yearLevel: 3 });
    const olderAppointmentId = await appointment(
      studentNumber,
      "COMPLETED",
      "LABORATORY",
      "2027-08-02",
    );
    const initialDraft = await getStudentResultSubmission(studentNumber, olderAppointmentId);
    const populated = await addStudentResultFiles(
      studentNumber,
      olderAppointmentId,
      initialDraft.id,
      [file("preserved-old.pdf")],
      storage,
    );
    if (edit) {
      await finalizeExpectedStudentResultSubmission(
        studentNumber,
        olderAppointmentId,
        populated.id,
        storage,
      );
    }
    const target = edit
      ? await beginStudentResultEdit(studentNumber, olderAppointmentId, storage)
      : populated;
    const targetFile = target.files[0];
    await appointment(studentNumber, "COMPLETED", "LABORATORY", "2027-08-03");

    const mutation = label === "upload"
      ? addStudentResultFiles(
        studentNumber,
        olderAppointmentId,
        target.id,
        [file("must-not-upload.pdf")],
        storage,
      )
      : label === "remove"
        ? removeExpectedStudentResultFile(
          studentNumber,
          olderAppointmentId,
          target.id,
          targetFile.id,
          storage,
        )
        : label === "finalize"
          ? finalizeExpectedStudentResultSubmission(
            studentNumber,
            olderAppointmentId,
            target.id,
            storage,
          )
          : label === "cancel"
            ? cancelStudentResultEdit(
              studentNumber,
              olderAppointmentId,
              target.id,
              storage,
            )
            : submitStudentResultChanges(
              studentNumber,
              olderAppointmentId,
              target.id,
              storage,
            );

    await expect(mutation).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    const unchanged = await pool.query<{
      status: string;
      discardedAt: Date | null;
      fileCount: number;
      pendingCount: number;
    }>(
      `SELECT submission.status, submission.discarded_at AS "discardedAt",
              COUNT(file.id) FILTER (WHERE file.deleted_at IS NULL)::int AS "fileCount",
              COUNT(file.id) FILTER (WHERE file.storage_delete_pending=TRUE)::int AS "pendingCount"
         FROM student_result_submissions submission
         LEFT JOIN student_result_files file ON file.submission_id=submission.id
        WHERE submission.id=$1
        GROUP BY submission.id`,
      [target.id],
    );
    expect(unchanged.rows).toEqual([{
      status: "DRAFT",
      discardedAt: null,
      fileCount: 1,
      pendingCount: 0,
    }]);
    await expect(storage.read(targetFile.storageKey)).resolves.toBeInstanceOf(Buffer);
  });

  it("rejects beginning an edit on an older finalized appointment without copying files", async () => {
    const studentNumber = "99-9479-79";
    const fixture = await finalizedResultFixture(
      studentNumber,
      ["older-physical-official.pdf"],
      "PHYSICAL_EXAM",
    );
    await appointment(studentNumber, "COMPLETED", "PHYSICAL_EXAM", "2027-08-03");

    await expect(beginStudentResultEdit(studentNumber, fixture.appointmentId, storage))
      .rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    const drafts = await pool.query(
      `SELECT id FROM student_result_submissions
        WHERE appointment_id=$1 AND status='DRAFT' AND discarded_at IS NULL`,
      [fixture.appointmentId],
    );
    expect(drafts.rows).toEqual([]);
    await expect(storage.read(fixture.official.files[0].storageKey)).resolves.toEqual(
      fixture.uploads[0].bytes,
    );
  });

  it("arms every batch upload key before the first storage write", async () => {
    const studentNumber = "99-9470-70";
    await insertTestStudent({ studentNumber, firstName: "Intent", lastName: "Upload", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const writeKeys: string[] = [];
    let visibleBeforeFirstWrite: Array<{
      storageKey: string;
      notBefore: Date;
      claimToken: string | null;
    }> = [];
    const trackingStorage: ResultStorage = {
      read: storage.read.bind(storage),
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === 1) {
          const visible = await pool.query<{
            storageKey: string;
            notBefore: Date;
            claimToken: string | null;
          }>(
            `SELECT storage_key AS "storageKey", not_before AS "notBefore",
                    claim_token::text AS "claimToken"
               FROM student_result_storage_cleanup_intents
              WHERE storage_key LIKE $1
              ORDER BY storage_key`,
            [`${draft.id}/%`],
          );
          visibleBeforeFirstWrite = visible.rows;
        }
        await storage.write(storageKey, bytes);
      },
      delete: storage.delete.bind(storage),
    };

    const uploaded = await addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [file("intent-first.pdf"), file("intent-second.pdf")],
      trackingStorage,
    );

    expect(writeKeys).toHaveLength(2);
    expect(visibleBeforeFirstWrite).toHaveLength(2);
    expect(writeKeys.every((storageKey) => (
      visibleBeforeFirstWrite.some((intent) => intent.storageKey === storageKey)
    ))).toBe(true);
    expect(visibleBeforeFirstWrite.every((intent) => (
      intent.notBefore.getTime() > Date.now() && intent.claimToken === null
    ))).toBe(true);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key = ANY($1::text[])",
      [writeKeys],
    )).resolves.toMatchObject({ rowCount: 0 });
    expect(uploaded.files.map((uploadedFile) => uploadedFile.originalFilename).sort()).toEqual([
      "intent-first.pdf",
      "intent-second.pdf",
    ]);
  });

  it("keeps pre-write cleanup intents future-dated by the database clock", async () => {
    const studentNumber = "99-9491-91";
    await insertTestStudent({ studentNumber, firstName: "Clock", lastName: "Intent", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const databaseClock = await pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const databaseNow = databaseClock.rows[0].now;
    const cleanupAt = new Date(databaseNow.getTime() + 60_000);
    const originalConnectMethod = pool.connect;
    const originalConnect = pool.connect.bind(pool);
    const client = await originalConnect();
    const observation: {
      intentNotBefore: Date | null;
      cleanupResult: Awaited<ReturnType<typeof cleanupExpiredResultDrafts>> | null;
    } = {
      intentNotBefore: null,
      cleanupResult: null,
    };
    const beginHookClient = new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.query, target, args);
            if (args[0] === "BEGIN") {
              const visible = await pool.query<{ notBefore: Date }>(
                `SELECT not_before AS "notBefore"
                   FROM student_result_storage_cleanup_intents
                  WHERE storage_key LIKE $1
                  ORDER BY storage_key
                  LIMIT 1`,
                [`${draft.id}/%`],
              );
              observation.intentNotBefore = visible.rows[0]?.notBefore ?? null;
              observation.cleanupResult = await cleanupExpiredResultDrafts(cleanupAt, storage);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
    let providedBeginHookClient = false;
    pool.connect = ((...args: unknown[]) => {
      if (args.length) return Reflect.apply(originalConnectMethod, pool, args);
      if (!providedBeginHookClient) {
        providedBeginHookClient = true;
        pool.connect = originalConnectMethod;
        return Promise.resolve(beginHookClient);
      }
      return originalConnect();
    }) as typeof pool.connect;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(databaseNow.getTime() - 24 * 60 * 60 * 1000));

    try {
      await expect(addStudentResultFiles(
        studentNumber,
        appointmentId,
        draft.id,
        [file("database-clock.pdf")],
        storage,
      )).resolves.toMatchObject({ id: draft.id, fileCount: 1 });
      expect(observation.intentNotBefore?.getTime()).toBeGreaterThan(
        databaseNow.getTime() + 14 * 60 * 1000,
      );
      expect(observation.cleanupResult).toEqual({ expiredDraftCount: 0, deletionFailureCount: 0 });
    } finally {
      pool.connect = originalConnectMethod;
      if (!providedBeginHookClient) client.release();
      vi.useRealTimers();
    }
  });

  it("preserves committed batch upload files when the COMMIT response is lost", async () => {
    const studentNumber = "99-9471-71";
    await insertTestStudent({ studentNumber, firstName: "Commit", lastName: "Upload", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const originalConnectMethod = pool.connect;
    const originalConnect = pool.connect.bind(pool);
    const client = await originalConnect();
    const ambiguousClient = new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.query, target, args);
            if (args[0] === "COMMIT") throw new Error("synthetic upload COMMIT response lost");
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
    let providedAmbiguousClient = false;
    pool.connect = ((...args: unknown[]) => {
      if (args.length) return Reflect.apply(originalConnectMethod, pool, args);
      if (!providedAmbiguousClient) {
        providedAmbiguousClient = true;
        pool.connect = originalConnectMethod;
        return Promise.resolve(ambiguousClient);
      }
      return originalConnect();
    }) as typeof pool.connect;

    try {
      await expect(addStudentResultFiles(
        studentNumber,
        appointmentId,
        draft.id,
        [file("commit-upload-first.pdf"), file("commit-upload-second.pdf")],
        storage,
      )).rejects.toThrow("synthetic upload COMMIT response lost");
    } finally {
      pool.connect = originalConnectMethod;
    }

    const committed = await pool.query<{ storageKey: string }>(
      `SELECT file.storage_key AS "storageKey"
         FROM student_result_files file
        WHERE file.submission_id=$1 AND file.deleted_at IS NULL
        ORDER BY file.uploaded_at, file.id`,
      [draft.id],
    );
    expect(committed.rows).toHaveLength(2);
    await expect(Promise.all(
      committed.rows.map((row) => storage.read(row.storageKey)),
    )).resolves.toHaveLength(2);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key = ANY($1::text[])",
      [committed.rows.map((row) => row.storageKey)],
    )).resolves.toMatchObject({ rowCount: 0 });
  }, 15_000);

  it("keeps a failed batch rollback delete worker-retryable", async () => {
    const studentNumber = "99-9472-72";
    await insertTestStudent({ studentNumber, firstName: "Retry", lastName: "Upload", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const objects = new Map<string, Buffer>();
    const writeKeys: string[] = [];
    let failRollbackDelete = true;
    const failingStorage: ResultStorage = {
      write: async (storageKey, bytes) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === 2) throw new Error("synthetic upload write failure");
        objects.set(storageKey, bytes);
      },
      read: async (storageKey) => {
        const bytes = objects.get(storageKey);
        if (!bytes) throw new Error("missing synthetic object");
        return bytes;
      },
      delete: async (storageKey) => {
        if (failRollbackDelete && storageKey === writeKeys[0]) {
          throw new Error("synthetic upload rollback delete failure");
        }
        objects.delete(storageKey);
      },
    };

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [file("retry-upload-first.pdf"), file("retry-upload-second.pdf")],
      failingStorage,
    )).rejects.toThrow("synthetic upload write failure");

    const intent = await pool.query<{
      storageKey: string;
      notBefore: Date;
      claimToken: string | null;
      deleteError: string | null;
    }>(
      `SELECT storage_key AS "storageKey", not_before AS "notBefore",
              claim_token::text AS "claimToken", delete_error AS "deleteError"
         FROM student_result_storage_cleanup_intents
        WHERE storage_key = ANY($1::text[])`,
      [writeKeys],
    );
    expect(intent.rows).toEqual([{
      storageKey: writeKeys[0],
      notBefore: expect.any(Date),
      claimToken: null,
      deleteError: "synthetic upload rollback delete failure",
    }]);
    expect(objects.has(writeKeys[0])).toBe(true);
    await expect(getStudentResultSubmission(studentNumber, appointmentId)).resolves.toMatchObject({
      id: draft.id,
      files: [],
    });

    failRollbackDelete = false;
    await expect(cleanupExpiredResultDrafts(
      new Date(intent.rows[0].notBefore.getTime() + 1),
      failingStorage,
    )).resolves.toEqual({ expiredDraftCount: 0, deletionFailureCount: 0 });
    expect(objects.has(writeKeys[0])).toBe(false);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key=$1",
      [writeKeys[0]],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects a mixed-invalid batch without file rows or storage residue", async () => {
    const studentNumber = "99-9430-30";
    await insertTestStudent({ studentNumber, firstName: "Mixed", lastName: "Batch", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const before = await getStudentResultSubmission(studentNumber, appointmentId);
    let writeCalls = 0;
    const trackingStorage = {
      write: async () => { writeCalls += 1; },
      read: storage.read.bind(storage),
      delete: storage.delete.bind(storage),
    };

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      before.id,
      [file("valid.pdf"), textFile()],
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_TYPE_NOT_ALLOWED", status: 422 });

    expect(writeCalls).toBe(0);
    expect((await getStudentResultSubmission(studentNumber, appointmentId)).files).toEqual([]);
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("rejects a batch whose resulting file count exceeds ten before writing storage", async () => {
    const studentNumber = "99-9431-31";
    await insertTestStudent({ studentNumber, firstName: "Count", lastName: "Batch", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    let writeCalls = 0;
    const trackingStorage = {
      write: async () => { writeCalls += 1; },
      read: storage.read.bind(storage),
      delete: storage.delete.bind(storage),
    };

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      Array.from({ length: 11 }, (_, index) => file(`count-${index}.pdf`)),
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_FILE_COUNT_LIMIT", status: 422 });

    expect(writeCalls).toBe(0);
    expect((await getStudentResultSubmission(studentNumber, appointmentId)).files).toEqual([]);
  });

  it("rejects a batch whose resulting bytes exceed 50 MB before writing storage", async () => {
    const studentNumber = "99-9432-32";
    await insertTestStudent({ studentNumber, firstName: "Bytes", lastName: "Batch", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    let writeCalls = 0;
    const trackingStorage = {
      write: async () => { writeCalls += 1; },
      read: storage.read.bind(storage),
      delete: storage.delete.bind(storage),
    };

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [
        pdfOfSize("large-1.pdf", 18 * 1024 * 1024),
        pdfOfSize("large-2.pdf", 18 * 1024 * 1024),
        pdfOfSize("large-3.pdf", 18 * 1024 * 1024),
      ],
      trackingStorage,
    )).rejects.toMatchObject({ code: "RESULT_TOTAL_SIZE_LIMIT", status: 422 });

    expect(writeCalls).toBe(0);
    expect((await getStudentResultSubmission(studentNumber, appointmentId)).files).toEqual([]);
  }, 30000);

  it("cleans every generated batch key after a partial storage failure without deleting existing files", async () => {
    const studentNumber = "99-9433-33";
    await insertTestStudent({ studentNumber, firstName: "Rollback", lastName: "Batch", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const objects = new Map<string, Buffer>();
    const writeKeys: string[] = [];
    const deleteKeys: string[] = [];
    let failOnWrite = Number.POSITIVE_INFINITY;
    const trackingStorage = {
      write: async (storageKey: string, bytes: Buffer) => {
        writeKeys.push(storageKey);
        if (writeKeys.length === failOnWrite) throw new Error("synthetic batch write failure");
        objects.set(storageKey, bytes);
      },
      read: async (storageKey: string) => {
        const bytes = objects.get(storageKey);
        if (!bytes) throw new Error("missing synthetic object");
        return bytes;
      },
      delete: async (storageKey: string) => {
        deleteKeys.push(storageKey);
        objects.delete(storageKey);
      },
    };
    const initial = await addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [file("existing.pdf")],
      trackingStorage,
    );
    const existingKey = initial.files[0].storageKey;
    failOnWrite = writeKeys.length + 2;

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      [file("batch-1.pdf"), file("batch-2.pdf"), file("batch-3.pdf")],
      trackingStorage,
    )).rejects.toThrow("synthetic batch write failure");

    const generatedBatchKeys = deleteKeys.filter((storageKey) => storageKey !== existingKey);
    expect(generatedBatchKeys.sort()).toEqual(writeKeys.slice(-2).sort());
    expect(generatedBatchKeys).not.toContain(existingKey);
    expect([...objects.keys()]).toEqual([existingKey]);
    await expect(pool.query(
      "SELECT storage_key FROM student_result_storage_cleanup_intents WHERE storage_key = ANY($1::text[])",
      [writeKeys.slice(-2)],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(getStudentResultSubmission(studentNumber, appointmentId)).resolves.toMatchObject({
      id: draft.id,
      fileCount: 1,
      files: [{ originalFilename: "existing.pdf" }],
    });
  });

  it("serializes concurrent batches so only one batch can consume the remaining file limit", async () => {
    const studentNumber = "99-9434-34";
    await insertTestStudent({ studentNumber, firstName: "Concurrent", lastName: "Batch", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const draft = await getStudentResultSubmission(studentNumber, appointmentId);
    const batches = ["first", "second"].map((prefix) => addStudentResultFiles(
      studentNumber,
      appointmentId,
      draft.id,
      Array.from({ length: 6 }, (_, index) => file(`${prefix}-${index}.pdf`)),
      storage,
    ));

    const outcomes = await Promise.allSettled(batches);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => (
      outcome.status === "rejected" && outcome.reason?.code === "RESULT_FILE_COUNT_LIMIT"
    ))).toHaveLength(1);
    await expect(getStudentResultSubmission(studentNumber, appointmentId)).resolves.toMatchObject({
      id: draft.id,
      fileCount: 6,
    });
  });

  it("does not deadlock invalidation against an expected-draft mutation lock", async () => {
    const studentNumber = "99-9436-36";
    await insertTestStudent({ studentNumber, firstName: "Lock", lastName: "Order", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    await addStudentResultFile(studentNumber, appointmentId, file("official.pdf"), storage);
    const official = await finalizeStudentResultSubmission(studentNumber, appointmentId, storage);
    const edit = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, based_on_submission_id
       ) VALUES ($1,$2,'LABORATORY',$3)
       RETURNING id`,
      [appointmentId, studentNumber, official.id],
    );
    const mutationClient = await pool.connect();
    const invalidationClient = await pool.connect();
    const observer = await pool.connect();
    let invalidationSettled = false;

    try {
      await Promise.all([
        mutationClient.query("BEGIN"),
        invalidationClient.query("BEGIN"),
      ]);
      await Promise.all([
        mutationClient.query("SET LOCAL deadlock_timeout='100ms'"),
        invalidationClient.query("SET LOCAL deadlock_timeout='100ms'"),
      ]);
      await lockEffectiveAppointmentScopes(mutationClient, [{
        studentNumber,
        scheduleType: "LABORATORY",
      }]);
      await mutationClient.query("SELECT id FROM appointments WHERE id=$1 FOR UPDATE", [appointmentId]);

      const invalidationTask = lockCurrentFinalizedSubmissionForInvalidation(
        invalidationClient,
        official.id,
      ).then(async (lock) => {
        await invalidationClient.query("COMMIT");
        return lock;
      }).finally(() => { invalidationSettled = true; });
      await waitForAdvisoryLockWaiter(observer, () => invalidationSettled);

      const mutationTask = lockExpectedStudentResultDraft(
        mutationClient,
        studentNumber,
        appointmentId,
        edit.rows[0].id,
      ).then(async (lock) => {
        await mutationClient.query("COMMIT");
        return lock;
      });
      const [mutationOutcome, invalidationOutcome] = await Promise.allSettled([
        mutationTask,
        invalidationTask,
      ]);

      if (mutationOutcome.status === "rejected") throw mutationOutcome.reason;
      if (invalidationOutcome.status === "rejected") throw invalidationOutcome.reason;

      expect(mutationOutcome).toMatchObject({
        status: "fulfilled",
        value: { type: "draft", draft: { id: edit.rows[0].id } },
      });
      expect(invalidationOutcome).toMatchObject({
        status: "fulfilled",
        value: { type: "ready", submission: { id: official.id } },
      });
    } finally {
      await mutationClient.query("ROLLBACK").catch(() => undefined);
      await invalidationClient.query("ROLLBACK").catch(() => undefined);
      mutationClient.release();
      invalidationClient.release();
      observer.release();
    }
  });

  it("does not let a stale tab upload, remove, or finalize a replacement draft", async () => {
    const studentNumber = "99-9435-35";
    await insertTestStudent({ studentNumber, firstName: "Stale", lastName: "Tab", yearLevel: 3 });
    const appointmentId = await appointment(studentNumber);
    const retired = await getStudentResultSubmission(studentNumber, appointmentId);
    await pool.query(
      "UPDATE student_result_submissions SET discarded_at=NOW() WHERE id=$1",
      [retired.id],
    );
    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (appointment_id, student_number, result_type)
       VALUES ($1,$2,'LABORATORY') RETURNING id`,
      [appointmentId, studentNumber],
    );
    const current = await addStudentResultFiles(
      studentNumber,
      appointmentId,
      replacement.rows[0].id,
      [file("replacement.pdf")],
      storage,
    );
    const replacementFileId = current.files[0].id;

    await expect(addStudentResultFiles(
      studentNumber,
      appointmentId,
      retired.id,
      [file("stale-upload.pdf")],
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(removeExpectedStudentResultFile(
      studentNumber,
      appointmentId,
      retired.id,
      replacementFileId,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(finalizeExpectedStudentResultSubmission(
      studentNumber,
      appointmentId,
      retired.id,
      storage,
    )).rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(getStudentResultSubmission(studentNumber, appointmentId)).resolves.toEqual(current);
  });

  it("resumes a draft, adds/removes files, and never uses original names in storage keys", async () => {
    await insertTestStudent({ studentNumber: "99-9401-01", firstName: "Draft", lastName: "Owner", yearLevel: 3 });
    const appointmentId = await appointment("99-9401-01");
    const added = await addStudentResultFile("99-9401-01", appointmentId, file("My Medical Result.pdf"), storage);
    expect(added.storageKey).toMatch(new RegExp(`^${added.submissionId}/[0-9a-f-]+\\.pdf$`));
    expect(added.storageKey).not.toContain("My Medical Result");
    const resumed = await getStudentResultSubmission("99-9401-01", appointmentId);
    expect(resumed).toMatchObject({ status: "DRAFT", fileCount: 1, totalBytes: file().bytes.byteLength });
    expect(resumed.files[0]).toMatchObject({ originalFilename: "My Medical Result.pdf" });
    await removeStudentResultFile("99-9401-01", appointmentId, added.id, storage);
    expect((await getStudentResultSubmission("99-9401-01", appointmentId)).files).toEqual([]);
  });

  it("requires an owned, published, completed matching appointment before writing storage", async () => {
    for (const studentNumber of ["99-9402-02", "99-9403-03"]) {
      await insertTestStudent({ studentNumber, firstName: "Access", lastName: "Student", yearLevel: 3 });
    }
    const pendingId = await appointment("99-9402-02", "PENDING");
    const completedId = await appointment("99-9402-02", "COMPLETED", "PHYSICAL_EXAM");
    await expect(addStudentResultFile("99-9402-02", pendingId, file(), storage))
      .rejects.toMatchObject({ code: "RESULT_UPLOAD_NOT_AVAILABLE", status: 409 });
    await expect(addStudentResultFile("99-9403-03", completedId, file(), storage))
      .rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("enforces ten files and 50 MB aggregate limits while leaving rejected bytes unwritten", async () => {
    await insertTestStudent({ studentNumber: "99-9404-04", firstName: "Limit", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9404-04");
    for (let index = 0; index < 10; index += 1) {
      await addStudentResultFile("99-9404-04", appointmentId, file(`result-${index}.pdf`), storage);
    }
    await expect(addStudentResultFile("99-9404-04", appointmentId, file("eleven.pdf"), storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_COUNT_LIMIT", status: 422 });
    expect((await getStudentResultSubmission("99-9404-04", appointmentId)).fileCount).toBe(10);

    await insertTestStudent({ studentNumber: "99-9405-05", firstName: "Total", lastName: "Student", yearLevel: 3 });
    const totalAppointmentId = await appointment("99-9405-05");
    const large = (name: string) => file(name, `%PDF-${"x".repeat(18 * 1024 * 1024)}`);
    await addStudentResultFile("99-9405-05", totalAppointmentId, large("one.pdf"), storage);
    await addStudentResultFile("99-9405-05", totalAppointmentId, large("two.pdf"), storage);
    await expect(addStudentResultFile("99-9405-05", totalAppointmentId, large("three.pdf"), storage))
      .rejects.toMatchObject({ code: "RESULT_TOTAL_SIZE_LIMIT", status: 422 });
    expect((await getStudentResultSubmission("99-9405-05", totalAppointmentId)).fileCount).toBe(2);
  }, 30000);

  it("creates a pending upload result on completion without overwriting a manually recorded status", async () => {
    await insertTestStudent({ studentNumber: "99-9406-06", firstName: "Complete", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9406-06", "PENDING");
    await updateAppointment(appointmentId, { status: "COMPLETED" }, clinicStaff);
    const pendingResult = await pool.query(
      `SELECT result_status, encoded_by FROM laboratory_results WHERE appointment_id=$1`,
      [appointmentId],
    );
    expect(pendingResult.rows).toEqual([{ result_status: "PENDING_UPLOAD", encoded_by: null }]);

    await insertTestStudent({ studentNumber: "99-9407-07", firstName: "Manual", lastName: "Student", yearLevel: 3 });
    const manualAppointmentId = await appointment("99-9407-07", "PENDING");
    await pool.query(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status, remarks, encoded_by)
       VALUES ('99-9407-07',$1,'REQUIRES_FOLLOW_UP','Recorded by clinic',$2)`,
      [manualAppointmentId, TEST_REFERENCE_IDS.clinicStaffUser],
    );
    await updateAppointment(manualAppointmentId, { status: "COMPLETED" }, clinicStaff);
    const manualResult = await pool.query(
      `SELECT result_status, remarks, encoded_by::text FROM laboratory_results WHERE appointment_id=$1`,
      [manualAppointmentId],
    );
    expect(manualResult.rows).toEqual([{
      result_status: "REQUIRES_FOLLOW_UP",
      remarks: "Recorded by clinic",
      encoded_by: TEST_REFERENCE_IDS.clinicStaffUser,
    }]);
  });

  it("refuses finalization when stored bytes no longer match validated metadata", async () => {
    await insertTestStudent({ studentNumber: "99-9413-13", firstName: "Integrity", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9413-13");
    const added = await addStudentResultFile("99-9413-13", appointmentId, file("integrity.pdf"), storage);
    await storage.write(added.storageKey, Buffer.from("%PDF-1.7\ncorrupted after upload"));

    await expect(finalizeStudentResultSubmission("99-9413-13", appointmentId, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_INTEGRITY_ERROR", status: 500 });
    await expect(getStudentResultSubmission("99-9413-13", appointmentId))
      .resolves.toMatchObject({ status: "DRAFT", fileCount: 1 });
  });

  it("revokes a removed draft file before retryable physical deletion", async () => {
    await insertTestStudent({ studentNumber: "99-9414-14", firstName: "Delete", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9414-14");
    const added = await addStudentResultFile("99-9414-14", appointmentId, file("delete.pdf"), storage);
    const failingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async () => { throw new Error("synthetic draft delete failure"); },
    };

    await expect(removeStudentResultFile("99-9414-14", appointmentId, added.id, failingStorage))
      .resolves.toEqual({ success: true });
    await expect(getStudentResultSubmission("99-9414-14", appointmentId))
      .resolves.toMatchObject({ status: "DRAFT", fileCount: 0 });
    const state = await pool.query(
      `SELECT storage_delete_pending, deleted_at, delete_error
         FROM student_result_files WHERE id=$1`,
      [added.id],
    );
    expect(state.rows).toEqual([{
      storage_delete_pending: true,
      deleted_at: null,
      delete_error: "synthetic draft delete failure",
    }]);
  });

  it("finalizes atomically, completes the matching result, and locks student mutation", async () => {
    await insertTestStudent({ studentNumber: "99-9408-08", firstName: "Finalize", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9408-08");
    const first = await addStudentResultFile("99-9408-08", appointmentId, file("lab.pdf"), storage);
    await addStudentResultFile("99-9408-08", appointmentId, file("lab-copy.pdf", "%PDF-1.7\nsecond"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9408-08", appointmentId, storage);
    expect(finalized).toMatchObject({ status: "FINALIZED", fileCount: 2 });
    const result = await pool.query(
      `SELECT result_status, completed_at::text, encoded_by FROM laboratory_results WHERE appointment_id=$1`,
      [appointmentId],
    );
    expect(result.rows[0]).toMatchObject({ result_status: "COMPLETED", encoded_by: null });
    expect(result.rows[0].completed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action='STUDENT_RESULT_SUBMISSION_FINALIZED' AND entity_id=$1`,
      [finalized.id],
    );
    expect(audit.rows[0].metadata).toEqual({
      appointmentId,
      fileCount: 2,
      totalBytes: first.byteSize + file("lab-copy.pdf", "%PDF-1.7\nsecond").bytes.byteLength,
    });
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/filename|birth|content/i);
    await expect(addStudentResultFile("99-9408-08", appointmentId, file("late.pdf"), storage))
      .rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
    await expect(removeStudentResultFile("99-9408-08", appointmentId, first.id, storage))
      .rejects.toMatchObject({ code: "RESULT_EDIT_STALE", status: 409 });
  });

  it("enforces student ownership and admin-only individual/ZIP access", async () => {
    for (const studentNumber of ["99-9409-09", "99-9410-10"]) {
      await insertTestStudent({ studentNumber, firstName: "Download", lastName: "Student", yearLevel: 3 });
    }
    const appointmentId = await appointment("99-9409-09");
    const added = await addStudentResultFile("99-9409-09", appointmentId, file("shared-name.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9409-09", appointmentId, storage);
    await expect(getStudentResultFile("99-9409-09", added.id, storage))
      .resolves.toMatchObject({ filename: "shared-name.pdf", bytes: file().bytes });
    await expect(getStudentResultFile("99-9410-10", added.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    await expect(getAdminStudentResultFile(added.id, coordinator, storage))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(getAdminStudentResultFile(added.id, clinicStaff, storage))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(listAdminStudentResultProfiles(coordinator, { page: 1, limit: 50, offset: 0 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(getAdminStudentResultProfile("99-9409-09", clinicStaff))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(getAdminSubmissionStudentNumber(finalized.id, admin))
      .resolves.toBe("99-9409-09");
    await expect(getAdminStudentResultFile(added.id, admin, storage))
      .resolves.toMatchObject({ filename: "shared-name.pdf", bytes: file().bytes });
    const zip = await createAdminSubmissionZip(finalized.id, admin, storage);
    expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(zip.toString("latin1")).toContain("01-shared-name.pdf");
    const zipStream = await createAdminSubmissionZipStream(finalized.id, admin, storage);
    const streamedChunks: Buffer[] = [];
    for await (const chunk of zipStream) streamedChunks.push(Buffer.from(chunk));
    const streamedZip = Buffer.concat(streamedChunks);
    expect(streamedZip.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(streamedZip.toString("latin1")).toContain("01-shared-name.pdf");
  });

  it("keeps an older finalized appointment file private from its student owner after a newer appointment becomes current", async () => {
    const studentNumber = "99-9468-68";
    await insertTestStudent({
      studentNumber,
      firstName: "Historical",
      lastName: "Finalized",
      yearLevel: 3,
    });
    const oldAppointmentId = await appointment(studentNumber);
    const oldFile = await addStudentResultFile(
      studentNumber,
      oldAppointmentId,
      file("historical-finalized.pdf"),
      storage,
    );
    const oldSubmission = await finalizeStudentResultSubmission(
      studentNumber,
      oldAppointmentId,
      storage,
    );
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by
       ) VALUES ($1,$2,'LABORATORY','2027-08-03','PENDING',TRUE,$3)`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, TEST_REFERENCE_IDS.adminUser],
    );

    await expect(getStudentResultFile(studentNumber, oldFile.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    await expect(getAdminSubmissionResultFile(
      oldSubmission.id,
      oldFile.id,
      admin,
      storage,
    )).resolves.toMatchObject({
      filename: "historical-finalized.pdf",
      bytes: file().bytes,
    });
  });

  it("keeps superseded official files downloadable only through administrator file and ZIP access", async () => {
    const studentNumber = "99-9466-66";
    const unrelatedStudentNumber = "99-9467-67";
    const fixture = await finalizedResultFixture(studentNumber, ["superseded-history.pdf"]);
    await insertTestStudent({
      studentNumber: unrelatedStudentNumber,
      firstName: "Unrelated",
      lastName: "Student",
      yearLevel: 3,
    });
    const originalFile = fixture.official.files[0];
    const edit = await beginStudentResultEdit(studentNumber, fixture.appointmentId, storage);
    await submitStudentResultChanges(studentNumber, fixture.appointmentId, edit.id, storage);

    const lifecycle = await pool.query<{ status: string }>(
      "SELECT status FROM student_result_submissions WHERE id=$1",
      [fixture.official.id],
    );
    expect(lifecycle.rows).toEqual([{ status: "SUPERSEDED" }]);
    await expect(getAdminSubmissionResultFile(
      fixture.official.id,
      originalFile.id,
      admin,
      storage,
    )).resolves.toMatchObject({
      filename: "superseded-history.pdf",
      bytes: fixture.uploads[0].bytes,
    });
    await expect(getAdminSubmissionResultFile(
      fixture.official.id,
      originalFile.id,
      coordinator,
      storage,
    )).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(getAdminSubmissionResultFile(
      fixture.official.id,
      originalFile.id,
      clinicStaff,
      storage,
    )).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(getStudentResultFile(studentNumber, originalFile.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    await expect(getStudentResultFile(unrelatedStudentNumber, originalFile.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });

    const zip = await createAdminSubmissionZip(fixture.official.id, admin, storage);
    expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(zip.toString("latin1")).toContain("01-superseded-history.pdf");
  });

  it("invalidates metadata first, resets the result, notifies, and opens a replacement draft", async () => {
    await insertTestStudent({ studentNumber: "99-9411-11", firstName: "Replace", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9411-11");
    const added = await addStudentResultFile("99-9411-11", appointmentId, file("invalid.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9411-11", appointmentId, storage);
    await expect(invalidateStudentResultSubmission(finalized.id, " ", admin, storage)).rejects.toThrow();
    await expect(invalidateStudentResultSubmission(finalized.id, "Wrong student document", coordinator, storage))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(invalidateStudentResultSubmission(
      finalized.id,
      "Wrong student document",
      admin,
      storage,
    )).resolves.toEqual({
      id: finalized.id,
      status: "INVALIDATED",
      studentNumber: "99-9411-11",
    });
    await expect(getStudentResultFile("99-9411-11", added.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    const state = await pool.query(
      `SELECT submission.status, result.result_status, appointment.status AS appointment_status,
              file.deleted_at IS NOT NULL AS deleted, notification.notification_type
         FROM student_result_submissions submission
         JOIN appointments appointment ON appointment.id=submission.appointment_id
         JOIN laboratory_results result ON result.appointment_id=appointment.id
         JOIN student_result_files file ON file.submission_id=submission.id
         JOIN student_portal_notifications notification ON notification.student_number=submission.student_number
        WHERE submission.id=$1`,
      [finalized.id],
    );
    expect(state.rows).toEqual([{
      status: "INVALIDATED",
      result_status: "PENDING_UPLOAD",
      appointment_status: "COMPLETED",
      deleted: true,
      notification_type: "RESULT_INVALIDATED",
    }]);
    const audit = await pool.query<{
      actorUserId: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id::text AS "actorUserId", metadata
         FROM audit_logs
        WHERE action='STUDENT_RESULT_SUBMISSION_INVALIDATED' AND entity_id=$1`,
      [finalized.id],
    );
    expect(audit.rows).toEqual([{
      actorUserId: admin.userId,
      metadata: {
        appointmentId,
        fileCount: 1,
      },
    }]);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("Wrong student document");
    const replacement = await getStudentResultSubmission("99-9411-11", appointmentId);
    expect(replacement).toMatchObject({ status: "DRAFT", fileCount: 0 });
    await expect(addStudentResultFile("99-9411-11", appointmentId, file("replacement.pdf"), storage))
      .resolves.toMatchObject({ submissionId: replacement.id });
  });

  it("rejects a repeated invalidation as a conflict without any further mutation or cleanup", async () => {
    await insertTestStudent({ studentNumber: "99-9422-22", firstName: "Repeated", lastName: "Invalidation", yearLevel: 3 });
    const appointmentId = await appointment("99-9422-22");
    await addStudentResultFile("99-9422-22", appointmentId, file("repeated.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9422-22", appointmentId, storage);
    await invalidateStudentResultSubmission(finalized.id, "First invalidation", admin, storage);
    const before = await invalidationSnapshot(finalized.id);
    let deleteCalls = 0;
    const trackingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async (storageKey: string) => {
        deleteCalls += 1;
        await storage.delete(storageKey);
      },
    };

    await expect(invalidateStudentResultSubmission(
      finalized.id,
      "Repeated invalidation",
      admin,
      trackingStorage,
    )).rejects.toMatchObject({
      code: "RESULT_SUBMISSION_CONFLICT",
      status: 409,
      message: "This result submission is stale and can no longer be invalidated. Refresh the student profile and try again.",
    });

    expect(await invalidationSnapshot(finalized.id)).toEqual(before);
    expect(deleteCalls).toBe(0);
  });

  it("rejects an older finalized submission after a newer published appointment without mutation or cleanup", async () => {
    await insertTestStudent({ studentNumber: "99-9423-23", firstName: "Stale", lastName: "Appointment", yearLevel: 3 });
    const oldAppointmentId = await appointment("99-9423-23");
    const added = await addStudentResultFile("99-9423-23", oldAppointmentId, file("stale.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9423-23", oldAppointmentId, storage);
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by
       ) VALUES ($1,'99-9423-23','LABORATORY','2027-08-03','PENDING',TRUE,$2)`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await invalidationSnapshot(finalized.id);
    const storedBytes = await storage.read(added.storageKey);
    let deleteCalls = 0;
    const trackingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async (storageKey: string) => {
        deleteCalls += 1;
        await storage.delete(storageKey);
      },
    };

    await expect(invalidateStudentResultSubmission(
      finalized.id,
      "Invalid stale submission",
      admin,
      trackingStorage,
    )).rejects.toMatchObject({
      code: "RESULT_SUBMISSION_CONFLICT",
      status: 409,
      message: "This result submission is stale and can no longer be invalidated. Refresh the student profile and try again.",
    });

    expect(await invalidationSnapshot(finalized.id)).toEqual(before);
    await expect(storage.read(added.storageKey)).resolves.toEqual(storedBytes);
    expect(deleteCalls).toBe(0);
  });

  it("waits for concurrent publication, then rejects stale invalidation without deleting files", async () => {
    const studentNumber = "99-9424-24";
    await insertTestStudent({ studentNumber, firstName: "Publish", lastName: "First", yearLevel: 3 });
    const oldAppointmentId = await appointment(studentNumber);
    const added = await addStudentResultFile(studentNumber, oldAppointmentId, file("publication-race.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission(studentNumber, oldAppointmentId, storage);
    const draft = await generatedDraftAppointment(studentNumber, "publication-first");
    const publicationClient = await pool.connect();
    const observer = await pool.connect();
    let invalidationSettled = false;
    let deleteCalls = 0;
    const trackingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async (storageKey: string) => {
        deleteCalls += 1;
        await storage.delete(storageKey);
      },
    };

    try {
      await publicationClient.query("BEGIN");
      await publishBatch(draft.batchId, admin.userId, publicationClient);
      const invalidationTask = invalidateStudentResultSubmission(
        finalized.id,
        "Concurrent publication fixture",
        admin,
        trackingStorage,
      ).finally(() => { invalidationSettled = true; });

      await waitForAdvisoryLockWaiter(observer, () => invalidationSettled);
      await publicationClient.query("COMMIT");

      await expect(invalidationTask).rejects.toMatchObject({
        code: "RESULT_SUBMISSION_CONFLICT",
        status: 409,
      });
      await expect(storage.read(added.storageKey)).resolves.toEqual(file("publication-race.pdf").bytes);
      expect(deleteCalls).toBe(0);
      expect((await invalidationSnapshot(finalized.id))[0]).toMatchObject({ status: "FINALIZED" });
    } finally {
      await publicationClient.query("ROLLBACK").catch(() => undefined);
      publicationClient.release();
      observer.release();
    }
  });

  it("holds publication until an in-flight invalidation commits for the same appointment scope", async () => {
    const studentNumber = "99-9425-25";
    await insertTestStudent({ studentNumber, firstName: "Invalidate", lastName: "First", yearLevel: 3 });
    const oldAppointmentId = await appointment(studentNumber);
    await addStudentResultFile(studentNumber, oldAppointmentId, file("invalidation-race.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission(studentNumber, oldAppointmentId, storage);
    const draft = await generatedDraftAppointment(studentNumber, "invalidation-first");
    const invalidationClient = await pool.connect();
    const publicationClient = await pool.connect();
    const observer = await pool.connect();
    let publicationSettled = false;

    try {
      await Promise.all([
        invalidationClient.query("BEGIN"),
        publicationClient.query("BEGIN"),
      ]);
      const locked = await lockCurrentFinalizedSubmissionForInvalidation(
        invalidationClient,
        finalized.id,
      );
      if (locked.type !== "ready") throw new Error("Expected a current finalized submission fixture.");
      await invalidateFinalizedSubmissionMetadata(
        invalidationClient,
        locked.submission,
        admin.userId,
        "Concurrent invalidation fixture",
      );

      const publicationTask = publishBatch(
        draft.batchId,
        admin.userId,
        publicationClient,
      ).finally(() => { publicationSettled = true; });
      await waitForAdvisoryLockWaiter(observer, () => publicationSettled);
      await invalidationClient.query("COMMIT");
      await expect(publicationTask).resolves.toEqual({ count: 1 });
      await publicationClient.query("COMMIT");

      expect((await invalidationSnapshot(finalized.id))[0]).toMatchObject({ status: "INVALIDATED" });
      const effective = await pool.query<{ id: string }>(
        `SELECT id
           FROM appointments
          WHERE student_number=$1 AND schedule_type='LABORATORY'
            AND is_published=TRUE AND status NOT IN ('RESCHEDULED','CANCELLED')
          ORDER BY appointment_date DESC, created_at DESC, id DESC
          LIMIT 1`,
        [studentNumber],
      );
      expect(effective.rows[0].id).toBe(draft.appointmentId);
    } finally {
      await invalidationClient.query("ROLLBACK").catch(() => undefined);
      await publicationClient.query("ROLLBACK").catch(() => undefined);
      invalidationClient.release();
      publicationClient.release();
      observer.release();
    }
  });

  it("keeps an unknown invalidation target as RESULT_SUBMISSION_NOT_FOUND", async () => {
    await expect(invalidateStudentResultSubmission(
      "00000000-0000-4000-8000-ffffffffffff",
      "Unknown submission",
      admin,
      storage,
    )).rejects.toMatchObject({
      code: "RESULT_SUBMISSION_NOT_FOUND",
      status: 404,
    });
  });

  it("marks physical deletion for retry without reopening invalidated metadata", async () => {
    await insertTestStudent({ studentNumber: "99-9412-12", firstName: "Retry", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9412-12");
    await addStudentResultFile("99-9412-12", appointmentId, file("retry.pdf"), storage);
    const finalized = await finalizeStudentResultSubmission("99-9412-12", appointmentId, storage);
    const failingStorage = {
      write: storage.write.bind(storage),
      read: storage.read.bind(storage),
      delete: async () => { throw new Error("synthetic delete failure"); },
    };
    await invalidateStudentResultSubmission(finalized.id, "Unreadable result", admin, failingStorage);
    const fileState = await pool.query(
      `SELECT storage_delete_pending, deleted_at, delete_error
         FROM student_result_files WHERE submission_id=$1`,
      [finalized.id],
    );
    expect(fileState.rows).toEqual([{
      storage_delete_pending: true,
      deleted_at: null,
      delete_error: "synthetic delete failure",
    }]);
  });
});

describe("appointment result correction protection", () => {
  it("bulk-loads clear, placeholder, finalized, verified, active-draft, and harmless-file states", async () => {
    const fixtures = [
      ["99-9422-22", "Clear"],
      ["99-9423-23", "Placeholder"],
      ["99-9424-24", "Finalized"],
      ["99-9425-25", "Verified"],
      ["99-9426-26", "Active"],
      ["99-9427-27", "Deleted"],
      ["99-9428-28", "PendingDelete"],
      ["99-9429-29", "Retired"],
    ] as const;
    for (const [studentNumber, firstName] of fixtures) {
      await insertTestStudent({ studentNumber, firstName, lastName: "Protection", yearLevel: 3 });
    }
    const ids = new Map<string, string>();
    for (const [studentNumber] of fixtures) {
      ids.set(studentNumber, await appointment(studentNumber));
    }

    await pool.query(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status, completed_at, encoded_by)
       VALUES
         ('99-9423-23',$1,'PENDING_UPLOAD',NULL,NULL),
         ('99-9425-25',$2,'COMPLETED','2027-08-02',$3)`,
      [ids.get("99-9423-23"), ids.get("99-9425-25"), TEST_REFERENCE_IDS.clinicStaffUser],
    );
    await pool.query(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, status, finalized_at
       ) VALUES ($1,'99-9424-24','LABORATORY','FINALIZED',NOW())`,
      [ids.get("99-9424-24")],
    );

    for (const [studentNumber, storageKey, deleted, storageDeletePending] of [
      ["99-9426-26", "active.pdf", false, false],
      ["99-9427-27", "deleted.pdf", true, false],
      ["99-9428-28", "pending-delete.pdf", false, true],
    ] as const) {
      const submission = await pool.query<{ id: string }>(
        `INSERT INTO student_result_submissions (appointment_id, student_number, result_type)
         VALUES ($1,$2,'LABORATORY') RETURNING id`,
        [ids.get(studentNumber), studentNumber],
      );
      await pool.query(
        `INSERT INTO student_result_files (
           submission_id, storage_key, original_filename, detected_mime_type,
           extension, byte_size, checksum_sha256, deleted_at, storage_delete_pending
         ) VALUES ($1,$2,$3,'application/pdf','pdf',32,$4,
                   CASE WHEN $5 THEN NOW() ELSE NULL END,$6)`,
        [
          submission.rows[0].id,
          storageKey,
          storageKey,
          "b".repeat(64),
          deleted,
          storageDeletePending,
        ],
      );
    }
    const retired = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, discarded_at
       ) VALUES ($1,'99-9429-29','LABORATORY',NOW()) RETURNING id`,
      [ids.get("99-9429-29")],
    );
    await pool.query(
      `INSERT INTO student_result_files (
         submission_id, storage_key, original_filename, detected_mime_type,
         extension, byte_size, checksum_sha256
       ) VALUES ($1,'retired.pdf','retired.pdf','application/pdf','pdf',32,$2)`,
      [retired.rows[0].id, "b".repeat(64)],
    );

    const states = await transaction((client) =>
      loadAppointmentResultProtectionStates(client, [...ids.values()]),
    );

    expect(states.get(ids.get("99-9422-22")!)).toEqual({ type: "CLEAR" });
    expect(states.get(ids.get("99-9423-23")!)).toMatchObject({
      type: "PENDING_PLACEHOLDER",
      resultTable: "laboratory_results",
    });
    expect(states.get(ids.get("99-9424-24")!)).toMatchObject({
      type: "PROTECTED",
      reason: "FINALIZED_RESULT_SUBMISSION",
    });
    expect(states.get(ids.get("99-9425-25")!)).toEqual({
      type: "PROTECTED",
      reason: "VERIFIED_RESULT",
      message: "A verified result exists for this appointment.",
    });
    expect(states.get(ids.get("99-9426-26")!)).toMatchObject({
      type: "PROTECTED",
      reason: "DRAFT_RESULT_FILES_EXIST",
      activeFileCount: 1,
    });
    expect(states.get(ids.get("99-9427-27")!)).toEqual({ type: "CLEAR" });
    expect(states.get(ids.get("99-9428-28")!)).toEqual({ type: "CLEAR" });
    expect(states.get(ids.get("99-9429-29")!)).toEqual({ type: "CLEAR" });
  });

  it("returns clear when the completed appointment has no result row", async () => {
    await insertTestStudent({ studentNumber: "99-9415-15", firstName: "Clear", lastName: "Result", yearLevel: 3 });
    const appointmentId = await appointment("99-9415-15");

    await expect(transaction((client) => getAppointmentResultCorrectionState(client, {
      id: appointmentId,
      scheduleType: "LABORATORY",
    }))).resolves.toEqual({ type: "CLEAR" });
  });

  it("returns and deletes a pending-upload placeholder", async () => {
    await insertTestStudent({ studentNumber: "99-9416-16", firstName: "Pending", lastName: "Placeholder", yearLevel: 3 });
    const appointmentId = await appointment("99-9416-16");
    const placeholder = await pool.query<{ id: string }>(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status, encoded_by)
       VALUES ('99-9416-16',$1,'PENDING_UPLOAD',NULL)
       RETURNING id`,
      [appointmentId],
    );

    await transaction(async (client) => {
      const state = await getAppointmentResultCorrectionState(client, {
        id: appointmentId,
        scheduleType: "LABORATORY",
      });
      expect(state).toEqual({
        type: "PENDING_PLACEHOLDER",
        resultId: placeholder.rows[0].id,
        table: "laboratory_results",
      });
      if (state.type !== "PENDING_PLACEHOLDER") throw new Error("Expected a pending result placeholder.");
      await deletePendingResultPlaceholder(client, state);
    });

    await expect(pool.query(
      "SELECT id FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("protects any verified result in the schedule-type-specific table", async () => {
    await insertTestStudent({ studentNumber: "99-9417-17", firstName: "Verified", lastName: "Result", yearLevel: 3 });
    const appointmentId = await appointment("99-9417-17", "COMPLETED", "PHYSICAL_EXAM");
    await pool.query(
      `INSERT INTO exam_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ('99-9417-17',$1,'COMPLETED','2027-08-02',$2)`,
      [appointmentId, TEST_REFERENCE_IDS.clinicStaffUser],
    );

    await expect(transaction((client) => getAppointmentResultCorrectionState(client, {
      id: appointmentId,
      scheduleType: "PHYSICAL_EXAM",
    }))).resolves.toEqual({ type: "PROTECTED", reason: "VERIFIED_RESULT" });
  });

  it("protects finalized submissions while ignoring storage-delete-pending files", async () => {
    for (const studentNumber of ["99-9418-18", "99-9419-19"]) {
      await insertTestStudent({ studentNumber, firstName: "Protected", lastName: "Submission", yearLevel: 3 });
    }
    const finalizedAppointmentId = await appointment("99-9418-18");
    const fileAppointmentId = await appointment("99-9419-19");
    for (const [studentNumber, appointmentId] of [
      ["99-9418-18", finalizedAppointmentId],
      ["99-9419-19", fileAppointmentId],
    ]) {
      await pool.query(
        `INSERT INTO laboratory_results (student_number, appointment_id, result_status, encoded_by)
         VALUES ($1,$2,'PENDING_UPLOAD',NULL)`,
        [studentNumber, appointmentId],
      );
    }
    await pool.query(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, status, finalized_at
       ) VALUES ($1,'99-9418-18','LABORATORY','FINALIZED',NOW())`,
      [finalizedAppointmentId],
    );
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (appointment_id, student_number, result_type)
       VALUES ($1,'99-9419-19','LABORATORY')
       RETURNING id`,
      [fileAppointmentId],
    );
    await pool.query(
      `INSERT INTO student_result_files (
         submission_id, storage_key, original_filename, detected_mime_type,
         extension, byte_size, checksum_sha256, storage_delete_pending
       ) VALUES ($1,'task-5/active-file.pdf','active-file.pdf','application/pdf',
                 'pdf',32,$2,TRUE)`,
      [draft.rows[0].id, "a".repeat(64)],
    );

    await expect(transaction((client) => getAppointmentResultCorrectionState(client, {
      id: finalizedAppointmentId,
      scheduleType: "LABORATORY",
    }))).resolves.toEqual({ type: "PROTECTED", reason: "FINALIZED_SUBMISSION" });
    await expect(transaction((client) => getAppointmentResultCorrectionState(client, {
      id: fileAppointmentId,
      scheduleType: "LABORATORY",
    }))).resolves.toMatchObject({
      type: "PENDING_PLACEHOLDER",
      table: "laboratory_results",
    });
  });

  it("rejects placeholder deletion when the result is no longer pending upload", async () => {
    await insertTestStudent({ studentNumber: "99-9420-20", firstName: "Changed", lastName: "Placeholder", yearLevel: 3 });
    const appointmentId = await appointment("99-9420-20");
    await pool.query(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status, encoded_by)
       VALUES ('99-9420-20',$1,'PENDING_UPLOAD',NULL)`,
      [appointmentId],
    );

    await transaction(async (client) => {
      const state = await getAppointmentResultCorrectionState(client, {
        id: appointmentId,
        scheduleType: "LABORATORY",
      });
      if (state.type !== "PENDING_PLACEHOLDER") throw new Error("Expected a pending result placeholder.");
      await client.query(
        `UPDATE laboratory_results
            SET result_status='COMPLETED', completed_at='2027-08-02'
          WHERE id=$1`,
        [state.resultId],
      );
      await expect(deletePendingResultPlaceholder(client, state)).rejects.toMatchObject({
        code: "APPOINTMENT_RESULT_CONFLICT",
        status: 409,
      });
    });
  });

  it("uses invalidation-compatible lock order during concurrent correction inspection", async () => {
    await insertTestStudent({ studentNumber: "99-9421-21", firstName: "Concurrent", lastName: "Correction", yearLevel: 3 });
    const appointmentId = await appointment("99-9421-21");
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ('99-9421-21',$1,'COMPLETED','2027-08-02',$2)`,
      [appointmentId, TEST_REFERENCE_IDS.clinicStaffUser],
    );
    const submission = await pool.query<{ id: string }>(
      `INSERT INTO student_result_submissions (
         appointment_id, student_number, result_type, status, finalized_at
       ) VALUES ($1,'99-9421-21','LABORATORY','FINALIZED',NOW())
       RETURNING id`,
      [appointmentId],
    );
    const correctionClient = await pool.connect();
    const invalidationClient = await pool.connect();

    try {
      await Promise.all([
        correctionClient.query("BEGIN"),
        invalidationClient.query("BEGIN"),
      ]);
      await Promise.all([
        correctionClient.query("SET LOCAL deadlock_timeout='100ms'"),
        invalidationClient.query("SET LOCAL deadlock_timeout='100ms'"),
      ]);
      const correctionPid = await correctionClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const lockedSubmission = await lockFinalizedSubmissionForInvalidation(
        invalidationClient,
        submission.rows[0].id,
      );
      if (!lockedSubmission) throw new Error("Expected a finalized submission fixture.");

      const correctionTask = getAppointmentResultCorrectionState(correctionClient, {
        id: appointmentId,
        scheduleType: "LABORATORY",
      }).then(async (state) => {
        await correctionClient.query("COMMIT");
        return state;
      });
      await waitForClientLock(invalidationClient, correctionPid.rows[0].pid);
      const invalidationTask = invalidateFinalizedSubmissionMetadata(
        invalidationClient,
        lockedSubmission,
        TEST_REFERENCE_IDS.adminUser,
        "Concurrent invalidation fixture",
      ).then(() => invalidationClient.query("COMMIT"));

      const [correctionOutcome, invalidationOutcome] = await Promise.allSettled([
        correctionTask,
        invalidationTask,
      ]);
      expect(invalidationOutcome).toMatchObject({ status: "fulfilled" });
      expect(correctionOutcome).toMatchObject({
        status: "fulfilled",
        value: {
          type: "PENDING_PLACEHOLDER",
          table: "laboratory_results",
        },
      });
    } finally {
      await correctionClient.query("ROLLBACK").catch(() => undefined);
      await invalidationClient.query("ROLLBACK").catch(() => undefined);
      correctionClient.release();
      invalidationClient.release();
    }
  });
});
