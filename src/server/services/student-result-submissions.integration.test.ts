// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  deletePendingResultPlaceholder,
  getAppointmentResultCorrectionState,
  invalidateFinalizedSubmissionMetadata,
  lockFinalizedSubmissionForInvalidation,
} from "@/server/repositories/student-result-submissions.repository";
import { LocalResultStorage } from "@/server/storage/local-result-storage";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";
import {
  addStudentResultFile,
  createAdminSubmissionZip,
  createAdminSubmissionZipStream,
  finalizeStudentResultSubmission,
  getAdminStudentResultProfile,
  getAdminStudentResultFile,
  getAdminSubmissionStudentNumber,
  getStudentResultFile,
  getStudentResultSubmission,
  invalidateStudentResultSubmission,
  listAdminStudentResultProfiles,
  removeStudentResultFile,
} from "./student-result-submissions.service";

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
) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by
     ) VALUES ($1,$2,$3,'2027-08-02',$4,TRUE,$5)
     RETURNING id`,
    [
      scheduleType === "LABORATORY"
        ? TEST_REFERENCE_IDS.laboratoryClinic
        : TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      scheduleType,
      status,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

function file(filename = "result.pdf", body = "%PDF-1.7\nsynthetic result") {
  return { filename, declaredMimeType: "application/pdf", bytes: Buffer.from(body) };
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

describe("student result drafts", () => {
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
    const completedId = await appointment("99-9402-02", "COMPLETED");
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
      .rejects.toMatchObject({ code: "RESULT_SUBMISSION_FINALIZED", status: 409 });
    await expect(removeStudentResultFile("99-9408-08", appointmentId, first.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
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

  it("protects finalized submissions and any non-deleted uploaded file", async () => {
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
    }))).resolves.toEqual({ type: "PROTECTED", reason: "UPLOADED_FILES" });
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
