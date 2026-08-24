// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import {
  createStudentNotification,
  createStudentNotificationIsolated,
  createStudentNotifications,
  listStudentNotifications,
  markStudentNotificationRead,
} from "./student-notifications.service";
import {
  getStudentEmailVerificationStatus,
  requestStudentEmailVerification,
  verifyStudentEmail,
} from "./student-email.service";
import { publishScheduleBatchWithClient } from "./appointments.service";
import { decryptVerificationEmailBody } from "@/server/email/verification-body-encryption";
import { queueFirstVerificationCurrentStateCatchUp } from "./student-verification-catch-up.service";

const studentPattern = "99-95%";
const encryptionKey = Buffer.alloc(32, 11).toString("base64");
const originalEncryptionKey = process.env.EMAIL_OUTBOX_ENCRYPTION_KEY;

async function cleanup() {
  await pool.query(
    `DELETE FROM audit_logs
      WHERE entity_type='student_email_verification' AND entity_id LIKE $1`,
    [studentPattern],
  );
  await cleanupTestFixtures(studentPattern, "TEST-STUDENT-EMAIL%", "TEST-STUDENT-EMAIL%");
}

async function waitForStudentLockWaiters(expected: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock'
          AND query ILIKE '%FROM students%' AND query ILIKE '%FOR UPDATE%'`,
    );
    if (result.rows[0].count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${expected} student-row lock waiter(s).`);
}

async function waitForBackendLockWaiter(pid: number, taskSettled: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT state='active' AND wait_event_type='Lock' AS waiting
         FROM pg_stat_activity
        WHERE pid=$1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    if (taskSettled()) {
      throw new Error("Schedule publication completed before waiting on verification serialization.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for schedule publication to block on verification serialization.");
}

beforeAll(async () => {
  process.env.EMAIL_OUTBOX_ENCRYPTION_KEY = encryptionKey;
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
  if (originalEncryptionKey === undefined) delete process.env.EMAIL_OUTBOX_ENCRYPTION_KEY;
  else process.env.EMAIL_OUTBOX_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("student notifications and optional email", () => {
  it("batch-inserts portal notifications and verified-email outbox rows in one statement", async () => {
    for (const studentNumber of ["99-9505-05", "99-9506-06"]) {
      await insertTestStudent({
        studentNumber,
        firstName: "Batch",
        lastName: "Notify",
        yearLevel: 3,
        dateOfBirth: "2003-05-06",
      });
    }
    await pool.query(
      `UPDATE students SET email='batch@example.test', email_verified_at=NOW()
        WHERE student_number='99-9505-05'`,
    );

    await transaction(async (client) => {
      const querySpy = vi.spyOn(client, "query");
      await createStudentNotifications(client, [
        {
          studentNumber: "99-9505-05",
          notificationType: "SCHEDULE_PUBLISHED",
          title: "Schedule published",
          message: "Your First Year schedule is ready.",
          emailSubject: "Your current First Year schedule",
          emailTextBody: "Authoritative First Year schedule body.",
          messageKind: "SCHEDULE",
          sourceType: "FIRST_YEAR_IMPORT",
          sourceId: "import-1",
          scheduleFingerprint: "b".repeat(64),
        },
        {
          studentNumber: "99-9506-06",
          notificationType: "SCHEDULE_PUBLISHED",
          title: "Schedule published",
          message: "Your First Year schedule is ready.",
        },
      ]);
      expect(querySpy).toHaveBeenCalledTimes(1);
      querySpy.mockRestore();
    });

    await expect(pool.query(
      "SELECT student_number FROM student_portal_notifications ORDER BY student_number",
    )).resolves.toMatchObject({
      rows: [
        { student_number: "99-9505-05" },
        { student_number: "99-9506-06" },
      ],
    });
    await expect(pool.query(
      `SELECT student_number,to_email,subject,text_body,message_kind,source_type,source_id,
              schedule_fingerprint
         FROM email_outbox ORDER BY student_number`,
    )).resolves.toMatchObject({
      rows: [{
        student_number: "99-9505-05",
        to_email: "batch@example.test",
        subject: "Your current First Year schedule",
        text_body: "Authoritative First Year schedule body.",
        message_kind: "SCHEDULE",
        source_type: "FIRST_YEAR_IMPORT",
        source_id: "import-1",
        schedule_fingerprint: "b".repeat(64),
      }],
    });
    await expect(pool.query(
      `SELECT action,metadata->>'studentNumber' AS student_number
         FROM audit_logs
        WHERE action='EMAIL_OUTBOX_QUEUED'
          AND metadata->>'studentNumber' LIKE '99-95%'
        ORDER BY student_number`,
    )).resolves.toMatchObject({
      rows: [{ action: "EMAIL_OUTBOX_QUEUED", student_number: "99-9505-05" }],
    });
  });

  it("always creates a portal notification and queues email only for a verified address", async () => {
    for (const studentNumber of ["99-9501-01", "99-9502-02"]) {
      await insertTestStudent({
        studentNumber,
        firstName: "Notify",
        lastName: "Student",
        yearLevel: 3,
        dateOfBirth: "2003-05-06",
      });
    }
    await pool.query(
      `UPDATE students SET email='verified@example.test', email_verified_at=NOW()
        WHERE student_number='99-9501-01'`,
    );
    await transaction(async (client) => {
      await createStudentNotification(client, {
        studentNumber: "99-9501-01",
        notificationType: "SCHEDULE_RESCHEDULED",
        title: "Schedule updated",
        message: "Your Laboratory date changed.",
        metadata: { previousDate: "2027-08-02", replacementDate: "2027-08-09" },
      });
      await createStudentNotification(client, {
        studentNumber: "99-9502-02",
        notificationType: "SCHEDULE_RESCHEDULED",
        title: "Schedule updated",
        message: "Your Physical Examination date changed.",
      });
    });
    const notifications = await pool.query(
      "SELECT student_number FROM student_portal_notifications ORDER BY student_number",
    );
    expect(notifications.rows.map((row) => row.student_number)).toEqual(["99-9501-01", "99-9502-02"]);
    const outbox = await pool.query(
      "SELECT student_number,to_email,message_kind FROM email_outbox ORDER BY student_number",
    );
    expect(outbox.rows).toEqual([{
      student_number: "99-9501-01",
      to_email: "verified@example.test",
      message_kind: "GENERAL",
    }]);
  });

  it("stores only a token hash and keeps the prior verified email until replacement verification", async () => {
    await insertTestStudent({
      studentNumber: "99-9503-03",
      firstName: "Email",
      lastName: "Replace",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await pool.query(
      `UPDATE students SET email='old@example.test', email_verified_at=NOW()
        WHERE student_number='99-9503-03'`,
    );
    const request = await requestStudentEmailVerification("99-9503-03", " New@Example.Test ");
    expect(request.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
    expect(request.resendAvailableAt.getTime() - Date.now()).toBeGreaterThan(59 * 1000);
    const stored = await pool.query<{
      pending_email: string;
      token_hash: string;
      lifetime_minutes: number;
    }>(
      `SELECT pending_email, token_hash,
              FLOOR(EXTRACT(EPOCH FROM (expires_at-created_at))/60)::int AS lifetime_minutes
         FROM student_email_verifications WHERE student_number='99-9503-03'`,
    );
    expect(stored.rows[0]).toMatchObject({ pending_email: "new@example.test", lifetime_minutes: 30 });
    expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(request.token);
    const queued = await pool.query<{
      message_kind: string;
      subject: string;
      text_body: string;
      html_body: string | null;
      verification_body_encrypted: string;
    }>(
      `SELECT message_kind,subject,text_body,html_body,verification_body_encrypted
         FROM email_outbox WHERE student_number='99-9503-03'`,
    );
    expect(queued.rows[0]).toMatchObject({
      message_kind: "VERIFICATION",
      subject: "Verify your MedClinic notification email",
      text_body: "Verification email content is encrypted.",
      html_body: null,
    });
    expect(JSON.stringify(queued.rows[0])).not.toContain(request.token);
    expect(JSON.stringify(queued.rows[0])).not.toContain("token=");
    expect(decryptVerificationEmailBody(
      queued.rows[0].verification_body_encrypted,
      encryptionKey,
    )).toContain(encodeURIComponent(request.token));

    const audits = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action='EMAIL_OUTBOX_QUEUED' AND entity_type='email_outbox'
          AND metadata->>'studentNumber'='99-9503-03'`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows)).not.toContain(request.token);
    expect(JSON.stringify(audits.rows)).not.toContain("token=");
    await expect(pool.query(
      "SELECT email FROM students WHERE student_number='99-9503-03'",
    )).resolves.toMatchObject({ rows: [{ email: "old@example.test" }] });
    await transaction((client) => createStudentNotification(client, {
      studentNumber: "99-9503-03",
      notificationType: "SCHEDULE_RESCHEDULED",
      title: "Schedule updated",
      message: "Use the current verified delivery address.",
      eventKey: "TEST-STUDENT-EMAIL-REPLACEMENT-SAFETY",
    }));
    await expect(pool.query(
      `SELECT to_email FROM email_outbox
        WHERE student_number='99-9503-03' AND message_kind='GENERAL'`,
    )).resolves.toMatchObject({ rows: [{ to_email: "old@example.test" }] });

    await verifyStudentEmail(request.token);
    const verified = await pool.query(
      `SELECT email, email_verified_at IS NOT NULL AS verified
         FROM students WHERE student_number='99-9503-03'`,
    );
    expect(verified.rows).toEqual([{ email: "new@example.test", verified: true }]);
    const verificationAudits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='student_email_verification' AND entity_id='99-9503-03'
        ORDER BY created_at,action`,
    );
    expect(verificationAudits.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "STUDENT_EMAIL_REPLACEMENT_REQUESTED",
      "STUDENT_EMAIL_VERIFICATION_COMPLETED",
      "STUDENT_EMAIL_ADDRESS_REPLACED",
    ]));
    const auditText = JSON.stringify(verificationAudits.rows);
    expect(auditText).not.toContain("new@example.test");
    expect(auditText).not.toContain("old@example.test");
    expect(auditText).not.toContain(request.token);
    const verificationDelivery = await pool.query<{
      status: string;
      verification_body_encrypted: string | null;
      last_attempt_status: string | null;
    }>(
      `SELECT status,verification_body_encrypted,last_attempt_status
         FROM email_outbox
        WHERE student_number='99-9503-03' AND message_kind='VERIFICATION'`,
    );
    expect(verificationDelivery.rows).toEqual([{
      status: "OBSOLETE",
      verification_body_encrypted: null,
      last_attempt_status: "OBSOLETE",
    }]);
    const obsoleteAudit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action='EMAIL_OUTBOX_OBSOLETE' AND entity_type='email_outbox'
          AND metadata->>'studentNumber'='99-9503-03'`,
    );
    expect(obsoleteAudit.rows).toEqual([{
      metadata: expect.objectContaining({ reason: "CONSUMED", messageKind: "VERIFICATION" }),
    }]);
    expect(JSON.stringify(obsoleteAudit.rows)).not.toContain(request.token);
  });

  it("keeps distinct typed outbox fields correlated to identical batch portal inputs", async () => {
    const studentNumber = "99-9526-26";
    await insertTestStudent({
      studentNumber,
      firstName: "Batch",
      lastName: "Correlation",
      yearLevel: 3,
    });
    await pool.query(
      `UPDATE students SET email='batch-correlation@example.test',email_verified_at=NOW()
        WHERE student_number=$1`,
      [studentNumber],
    );

    await transaction((client) => createStudentNotifications(client, [
      {
        studentNumber,
        notificationType: "SCHEDULE_CURRENT_STATE",
        title: "Identical portal title",
        message: "Identical portal message.",
        emailSubject: "First typed subject",
        emailTextBody: "First typed body.",
        messageKind: "SCHEDULE",
        sourceType: "FIRST_TYPED_SOURCE",
        sourceId: "first-source-id",
        scheduleFingerprint: "c".repeat(64),
      },
      {
        studentNumber,
        notificationType: "SCHEDULE_CURRENT_STATE",
        title: "Identical portal title",
        message: "Identical portal message.",
        emailSubject: "Second typed subject",
        emailTextBody: "Second typed body.",
        messageKind: "SCHEDULE",
        sourceType: "SECOND_TYPED_SOURCE",
        sourceId: "second-source-id",
        scheduleFingerprint: "d".repeat(64),
      },
    ]));

    const portal = await pool.query(
      `SELECT id FROM student_portal_notifications
        WHERE student_number=$1 AND title='Identical portal title'`,
      [studentNumber],
    );
    const outbox = await pool.query(
      `SELECT subject,text_body,source_type,source_id,schedule_fingerprint
         FROM email_outbox WHERE student_number=$1 ORDER BY source_id`,
      [studentNumber],
    );
    expect(portal.rows).toHaveLength(2);
    expect(outbox.rows).toEqual([
      {
        subject: "First typed subject",
        text_body: "First typed body.",
        source_type: "FIRST_TYPED_SOURCE",
        source_id: "first-source-id",
        schedule_fingerprint: "c".repeat(64),
      },
      {
        subject: "Second typed subject",
        text_body: "Second typed body.",
        source_type: "SECOND_TYPED_SOURCE",
        source_id: "second-source-id",
        schedule_fingerprint: "d".repeat(64),
      },
    ]);
  });

  it("reuses a deterministic portal row to retry one failed email without duplicates", async () => {
    const studentNumber = "99-9527-27";
    await insertTestStudent({
      studentNumber,
      firstName: "Catchup",
      lastName: "Retry",
      yearLevel: 3,
    });
    await pool.query(
      `UPDATE students SET email='catchup-retry@example.test',email_verified_at=NOW()
        WHERE student_number=$1`,
      [studentNumber],
    );
    const eventKey = `schedule:current:${studentNumber}:${"e".repeat(64)}`;
    const baseInput = {
      studentNumber,
      notificationType: "SCHEDULE_CURRENT_STATE",
      title: "Current schedule",
      message: "Your current schedule is available.",
      emailSubject: "Your current schedule",
      emailTextBody: "Current authoritative schedule body.",
      messageKind: "SCHEDULE" as const,
      sourceType: "CURRENT_SCHEDULE_STATE",
      sourceId: "e".repeat(64),
      eventKey,
    };

    const failed = await transaction((client) => createStudentNotificationIsolated(client, {
      ...baseInput,
      scheduleFingerprint: "invalid-fingerprint",
    }));
    expect(failed).toEqual({
      id: expect.any(String),
      warnings: [{ channel: "EMAIL_OUTBOX" }],
    });
    const portalId = failed.id;
    await expect(pool.query(
      "SELECT id FROM student_portal_notifications WHERE event_key=$1",
      [eventKey],
    )).resolves.toMatchObject({ rows: [{ id: portalId }] });
    await expect(pool.query(
      "SELECT id FROM email_outbox WHERE event_key=$1",
      [eventKey],
    )).resolves.toMatchObject({ rows: [] });

    const retryInput = { ...baseInput, scheduleFingerprint: "e".repeat(64) };
    const retry = await transaction((client) => createStudentNotificationIsolated(client, retryInput));
    expect(retry).toEqual({ id: portalId, warnings: [] });
    await transaction((client) => createStudentNotificationIsolated(client, retryInput));
    await Promise.all([
      transaction((client) => createStudentNotificationIsolated(client, retryInput)),
      transaction((client) => createStudentNotificationIsolated(client, retryInput)),
    ]);

    const persisted = await pool.query<{
      portal_count: number;
      outbox_count: number;
      linked_portal_id: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE event_key=$1) AS portal_count,
         (SELECT COUNT(*)::int FROM email_outbox WHERE event_key=$1) AS outbox_count,
         (SELECT portal_notification_id::text FROM email_outbox WHERE event_key=$1) AS linked_portal_id`,
      [eventKey],
    );
    expect(persisted.rows).toEqual([{
      portal_count: 1,
      outbox_count: 1,
      linked_portal_id: portalId,
    }]);
  });

  it("deduplicates concurrent first success for one deterministic notification", async () => {
    const studentNumber = "99-9528-28";
    await insertTestStudent({
      studentNumber,
      firstName: "Concurrent",
      lastName: "Notification",
      yearLevel: 3,
    });
    await pool.query(
      `UPDATE students SET email='concurrent-notification@example.test',email_verified_at=NOW()
        WHERE student_number=$1`,
      [studentNumber],
    );
    const fingerprint = "f".repeat(64);
    const input = {
      studentNumber,
      notificationType: "SCHEDULE_CURRENT_STATE",
      title: "Concurrent current schedule",
      message: "Concurrent authoritative schedule.",
      emailSubject: "Concurrent current schedule",
      emailTextBody: "Concurrent authoritative schedule body.",
      messageKind: "SCHEDULE" as const,
      sourceType: "CURRENT_SCHEDULE_STATE",
      sourceId: fingerprint,
      scheduleFingerprint: fingerprint,
      eventKey: `schedule:current:${studentNumber}:${fingerprint}`,
    };

    const results = await Promise.all([
      transaction((client) => createStudentNotificationIsolated(client, input)),
      transaction((client) => createStudentNotificationIsolated(client, input)),
    ]);
    expect(results[0]).toEqual({ id: expect.any(String), warnings: [] });
    expect(results[1]).toEqual({ id: results[0].id, warnings: [] });
    await expect(pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE event_key=$1) AS portal_count,
         (SELECT COUNT(*)::int FROM email_outbox WHERE event_key=$1) AS outbox_count`,
      [input.eventKey],
    )).resolves.toMatchObject({ rows: [{ portal_count: 1, outbox_count: 1 }] });
  });

  it("enforces cooldown, invalidates older requests, and reports retry timing", async () => {
    await insertTestStudent({
      studentNumber: "99-9510-10", firstName: "Cool", lastName: "Down", yearLevel: 2,
    });
    const first = await requestStudentEmailVerification("99-9510-10", "first@example.test");

    await expect(requestStudentEmailVerification("99-9510-10", "second@example.test"))
      .rejects.toMatchObject({ code: "EMAIL_VERIFICATION_COOLDOWN", status: 429 });

    await pool.query(
      "UPDATE student_email_verifications SET created_at=NOW()-INTERVAL '61 seconds' WHERE student_number=$1",
      ["99-9510-10"],
    );
    const second = await requestStudentEmailVerification("99-9510-10", "second@example.test");
    await expect(verifyStudentEmail(first.token)).rejects.toMatchObject({ code: "EMAIL_VERIFICATION_INVALID" });
    await expect(verifyStudentEmail(second.token)).resolves.toMatchObject({ email: "second@example.test" });
  });

  it("limits verification requests to five in a rolling 15 minutes", async () => {
    await insertTestStudent({
      studentNumber: "99-9511-11", firstName: "Rate", lastName: "Limited", yearLevel: 2,
    });
    for (let index = 0; index < 5; index += 1) {
      await pool.query(
        `INSERT INTO student_email_verifications
           (student_number,pending_email,token_hash,expires_at,consumed_at,created_at)
         VALUES ($1,$2,$3,NOW()+INTERVAL '30 minutes',NOW(),NOW()-($4::int*INTERVAL '61 seconds'))`,
        ["99-9511-11", `rate${index}@example.test`, String(index).padStart(64, "a"), index + 1],
      );
    }

    await expect(requestStudentEmailVerification("99-9511-11", "sixth@example.test"))
      .rejects.toMatchObject({
        code: "EMAIL_VERIFICATION_THROTTLED",
        status: 429,
        details: { retryAfterSeconds: expect.any(Number), retryAt: expect.any(String) },
      });
  });

  it("rejects expired and reused tokens without changing a replacement address", async () => {
    await insertTestStudent({
      studentNumber: "99-9512-12", firstName: "Token", lastName: "Safety", yearLevel: 2,
    });
    await pool.query(
      "UPDATE students SET email='safe@example.test',email_verified_at=NOW() WHERE student_number='99-9512-12'",
    );
    const expired = await requestStudentEmailVerification("99-9512-12", "expired@example.test");
    await pool.query("UPDATE student_email_verifications SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1", [
      createHash("sha256").update(expired.token).digest("hex"),
    ]);
    await expect(verifyStudentEmail(expired.token)).rejects.toMatchObject({ code: "EMAIL_VERIFICATION_INVALID" });
    await expect(pool.query("SELECT email FROM students WHERE student_number='99-9512-12'"))
      .resolves.toMatchObject({ rows: [{ email: "safe@example.test" }] });

    await pool.query("UPDATE student_email_verifications SET created_at=NOW()-INTERVAL '61 seconds' WHERE student_number='99-9512-12'");
    const valid = await requestStudentEmailVerification("99-9512-12", "valid@example.test");
    await verifyStudentEmail(valid.token);
    await expect(verifyStudentEmail(valid.token)).rejects.toMatchObject({ code: "EMAIL_VERIFICATION_INVALID" });
  });

  it("permits only one concurrent verified owner and audits conflict without raw addresses or tokens", async () => {
    for (const studentNumber of ["99-9513-13", "99-9514-14"]) {
      await insertTestStudent({ studentNumber, firstName: "Concurrent", lastName: "Owner", yearLevel: 2 });
    }
    const first = await requestStudentEmailVerification("99-9513-13", " Shared@Example.Test ");
    const second = await requestStudentEmailVerification("99-9514-14", "shared@example.test");
    const outcomes = await Promise.allSettled([
      verifyStudentEmail(first.token),
      verifyStudentEmail(second.token),
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const owners = await pool.query(
      `SELECT student_number FROM students
        WHERE is_active=TRUE AND email_verified_at IS NOT NULL AND LOWER(BTRIM(email))='shared@example.test'`,
    );
    expect(owners.rows).toHaveLength(1);
    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='student_email_verification'
          AND entity_id IN ('99-9513-13','99-9514-14')`,
    );
    expect(audits.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "STUDENT_EMAIL_VERIFICATION_REQUESTED",
      "STUDENT_EMAIL_VERIFICATION_COMPLETED",
      "STUDENT_EMAIL_OWNERSHIP_CONFLICT",
    ]));
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain("shared@example.test");
    expect(serialized).not.toContain(first.token);
    expect(serialized).not.toContain(second.token);
  });

  it("invokes the catch-up boundary only for first-ever verification and exposes current status", async () => {
    await insertTestStudent({
      studentNumber: "99-9515-15", firstName: "Catch", lastName: "Up", yearLevel: 2,
    });
    const catchUp = vi.fn().mockResolvedValue(undefined);
    const first = await requestStudentEmailVerification("99-9515-15", "firstverified@example.test");
    await verifyStudentEmail(first.token, { queueCurrentStateCatchUp: catchUp });
    expect(catchUp).toHaveBeenCalledTimes(1);

    await pool.query("UPDATE student_email_verifications SET created_at=NOW()-INTERVAL '61 seconds' WHERE student_number='99-9515-15'");
    const replacement = await requestStudentEmailVerification("99-9515-15", "replacement@example.test");
    await verifyStudentEmail(replacement.token, { queueCurrentStateCatchUp: catchUp });
    expect(catchUp).toHaveBeenCalledTimes(1);

    await expect(getStudentEmailVerificationStatus("99-9515-15")).resolves.toMatchObject({
      verified: true,
      verifiedEmail: "replacement@example.test",
    });
  });

  it("queues only the latest current state after late first verification and remains idempotent", async () => {
    const studentNumber = "99-9525-25";
    await insertTestStudent({
      studentNumber, firstName: "Late", lastName: "Verifier", yearLevel: 3,
    });
    const oldLaboratory = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start
       ) VALUES ($1,$2,'LABORATORY','2091-09-03','RESCHEDULED',TRUE,2091)
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber],
    );
    const oldPhysical = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2091-09-10','RESCHEDULED',TRUE,2091)
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber],
    );
    await pool.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,rescheduled_from
       ) VALUES
         ($1,$3,'LABORATORY','2091-09-18','PENDING',TRUE,2091,$4),
         ($2,$3,'PHYSICAL_EXAM','2091-09-25','PENDING',TRUE,2091,$5)`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        studentNumber,
        oldLaboratory.rows[0].id,
        oldPhysical.rows[0].id,
      ],
    );

    const first = await requestStudentEmailVerification(studentNumber, "latest@example.test");
    await verifyStudentEmail(first.token);
    await transaction((client) => queueFirstVerificationCurrentStateCatchUp(client, studentNumber));

    const notifications = await pool.query<{ event_key: string }>(
      `SELECT event_key FROM student_portal_notifications
        WHERE student_number=$1 AND notification_type='SCHEDULE_CURRENT_STATE'`,
      [studentNumber],
    );
    const outbox = await pool.query<{ text_body: string; schedule_fingerprint: string }>(
      `SELECT text_body,schedule_fingerprint FROM email_outbox
        WHERE student_number=$1 AND notification_type='SCHEDULE_CURRENT_STATE'`,
      [studentNumber],
    );
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0].event_key).toMatch(
      /^schedule:current:99-9525-25:[0-9a-f]{64}$/,
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].schedule_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(outbox.rows[0].text_body).toContain("Laboratory: 2091-09-18 at KABALAKA Clinic (Pending).");
    expect(outbox.rows[0].text_body).toContain("Physical Examination: 2091-09-25 at CPU Clinic (Pending).");
    expect(outbox.rows[0].text_body).not.toContain("2091-09-03");
    expect(outbox.rows[0].text_body).not.toContain("2091-09-10");

    await pool.query(
      "UPDATE student_email_verifications SET created_at=clock_timestamp()-INTERVAL '61 seconds' WHERE student_number=$1",
      [studentNumber],
    );
    const replacement = await requestStudentEmailVerification(studentNumber, "latest-new@example.test");
    await verifyStudentEmail(replacement.token);
    await expect(pool.query(
      `SELECT id FROM email_outbox
        WHERE student_number=$1 AND notification_type='SCHEDULE_CURRENT_STATE'`,
      [studentNumber],
    )).resolves.toMatchObject({ rows: [expect.objectContaining({ id: expect.any(String) })] });
  });

  it("serializes first verification with concurrent publication so the latest schedule email cannot be missed", async () => {
    const studentNumber = "99-9529-29";
    await insertTestStudent({
      studentNumber,
      firstName: "Concurrent",
      lastName: "Publication",
      yearLevel: 3,
    });
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO schedule_batches (clinic_id,batch_name,status,created_by)
       VALUES ($1,'TEST-STUDENT-EMAIL-CONCURRENT-PUBLICATION','GENERATED',$2)
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    await pool.query(
      `INSERT INTO appointments (
         batch_id,clinic_id,student_number,schedule_type,appointment_date,status,
         is_published,schedule_cycle_start,created_by,updated_by
       ) VALUES ($1,$2,$3,'LABORATORY','2091-10-07','DRAFT',FALSE,2091,$4,$4)`,
      [
        batch.rows[0].id,
        TEST_REFERENCE_IDS.laboratoryClinic,
        studentNumber,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    const request = await requestStudentEmailVerification(
      studentNumber,
      "concurrent-publication@example.test",
    );

    let catchUpReached!: () => void;
    const atCatchUp = new Promise<void>((resolve) => { catchUpReached = resolve; });
    let releaseCatchUp!: () => void;
    const catchUpMayContinue = new Promise<void>((resolve) => { releaseCatchUp = resolve; });
    let publicationSettled = false;
    const publicationClient = await pool.connect();
    let publicationTransactionOpen = false;
    let publicationTask: Promise<void> | null = null;
    const verificationTask = verifyStudentEmail(request.token, {
      queueCurrentStateCatchUp: async (client, currentStudentNumber) => {
        catchUpReached();
        await catchUpMayContinue;
        return queueFirstVerificationCurrentStateCatchUp(client, currentStudentNumber);
      },
    });

    try {
      await atCatchUp;
      await publicationClient.query("BEGIN");
      publicationTransactionOpen = true;
      await publicationClient.query("SET LOCAL deadlock_timeout='100ms'");
      const publicationBackend = await publicationClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      publicationTask = (async () => {
        await publicationClient.query(
          "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
        );
        await publishScheduleBatchWithClient(
          batch.rows[0].id,
          TEST_REFERENCE_IDS.adminUser,
          publicationClient,
          false,
          true,
        );
        await publicationClient.query("COMMIT");
        publicationTransactionOpen = false;
      })().finally(() => { publicationSettled = true; });
      await waitForBackendLockWaiter(publicationBackend.rows[0].pid, () => publicationSettled);

      releaseCatchUp();
      await expect(verificationTask).resolves.toMatchObject({
        email: "concurrent-publication@example.test",
        firstVerification: true,
      });
      await expect(publicationTask).resolves.toBeUndefined();

      const scheduleEmails = await pool.query<{
        notificationType: string;
        textBody: string;
      }>(
        `SELECT notification_type AS "notificationType",text_body AS "textBody"
           FROM email_outbox
          WHERE student_number=$1 AND message_kind='SCHEDULE'`,
        [studentNumber],
      );
      expect(scheduleEmails.rows).toEqual([
        expect.objectContaining({
          notificationType: "SCHEDULE_INITIAL_PUBLICATION",
          textBody: expect.stringContaining("2091-10-07"),
        }),
      ]);
    } finally {
      releaseCatchUp();
      await Promise.allSettled([
        verificationTask,
        ...(publicationTask ? [publicationTask] : []),
      ]);
      if (publicationTransactionOpen) {
        await publicationClient.query("ROLLBACK").catch(() => undefined);
      }
      publicationClient.release();
    }
  });

  it("uses the database clock for cooldown retry timing despite application clock skew", async () => {
    await insertTestStudent({
      studentNumber: "99-9516-16", firstName: "Clock", lastName: "Cooldown", yearLevel: 2,
    });
    await requestStudentEmailVerification("99-9516-16", "clock-cooldown@example.test");
    const actualNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(actualNow - 24 * 60 * 60 * 1_000);
    try {
      const error = await requestStudentEmailVerification(
        "99-9516-16",
        "clock-cooldown-2@example.test",
      ).catch((caught) => caught);
      expect(error).toMatchObject({
        code: "EMAIL_VERIFICATION_COOLDOWN",
        status: 429,
        details: {
          retryAfterSeconds: expect.any(Number),
          retryAt: expect.any(String),
        },
      });
      expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
      const status = await getStudentEmailVerificationStatus("99-9516-16");
      expect(status.retryAfterSeconds).toBeGreaterThan(0);
      expect(status.retryAfterSeconds).toBeLessThanOrEqual(60);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("uses the database clock for token expiry despite application clock skew", async () => {
    for (const studentNumber of ["99-9517-17", "99-9518-18"]) {
      await insertTestStudent({ studentNumber, firstName: "Clock", lastName: "Expiry", yearLevel: 2 });
    }
    const valid = await requestStudentEmailVerification("99-9517-17", "clock-valid@example.test");
    const actualNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(actualNow + 24 * 60 * 60 * 1_000);
    try {
      await expect(verifyStudentEmail(valid.token)).resolves.toMatchObject({
        email: "clock-valid@example.test",
      });
    } finally {
      vi.restoreAllMocks();
    }

    const expired = await requestStudentEmailVerification("99-9518-18", "clock-expired@example.test");
    await pool.query(
      "UPDATE student_email_verifications SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1",
      [createHash("sha256").update(expired.token).digest("hex")],
    );
    vi.spyOn(Date, "now").mockReturnValue(actualNow - 24 * 60 * 60 * 1_000);
    try {
      await expect(verifyStudentEmail(expired.token)).rejects.toMatchObject({
        code: "EMAIL_VERIFICATION_INVALID",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("uses the current database clock after a student lock wait crosses the resend boundary", async () => {
    await insertTestStudent({
      studentNumber: "99-9523-23", firstName: "Boundary", lastName: "Cooldown", yearLevel: 2,
    });
    await requestStudentEmailVerification("99-9523-23", "boundary-cooldown@example.test");
    await pool.query(
      `UPDATE student_email_verifications
          SET created_at=clock_timestamp()-INTERVAL '59 seconds'
        WHERE student_number='99-9523-23'`,
    );

    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT student_number FROM students WHERE student_number='99-9523-23' FOR UPDATE",
      );
      const resend = requestStudentEmailVerification(
        "99-9523-23",
        "boundary-cooldown@example.test",
      );
      await waitForStudentLockWaiters(1);
      await blocker.query("SELECT pg_sleep(2)");
      await blocker.query("COMMIT");
      released = true;

      await expect(resend).resolves.toMatchObject({
        expiresAt: expect.any(Date),
        resendAvailableAt: expect.any(Date),
      });
    } finally {
      if (!released) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("uses the current database clock after a student lock wait crosses token expiry", async () => {
    await insertTestStudent({
      studentNumber: "99-9524-24", firstName: "Boundary", lastName: "Expiry", yearLevel: 2,
    });
    const request = await requestStudentEmailVerification(
      "99-9524-24",
      "boundary-expiry@example.test",
    );
    await pool.query(
      `UPDATE student_email_verifications
          SET expires_at=clock_timestamp()+INTERVAL '2 seconds'
        WHERE token_hash=$1`,
      [createHash("sha256").update(request.token).digest("hex")],
    );

    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT student_number FROM students WHERE student_number='99-9524-24' FOR UPDATE",
      );
      const confirmation = verifyStudentEmail(request.token);
      await waitForStudentLockWaiters(1);
      await blocker.query("SELECT pg_sleep(3)");
      await blocker.query("COMMIT");
      released = true;

      await expect(confirmation).rejects.toMatchObject({
        code: "EMAIL_VERIFICATION_INVALID",
        status: 422,
      });
    } finally {
      if (!released) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("counts ownership conflicts toward cooldown and the rolling attempt limit", async () => {
    await insertTestStudent({
      studentNumber: "99-9519-19", firstName: "Conflict", lastName: "Owner", yearLevel: 2,
    });
    await insertTestStudent({
      studentNumber: "99-9520-20", firstName: "Conflict", lastName: "Probe", yearLevel: 2,
    });
    await pool.query(
      "UPDATE students SET email='claimed@example.test',email_verified_at=NOW() WHERE student_number='99-9519-19'",
    );

    for (let index = 1; index <= 5; index += 1) {
      await expect(requestStudentEmailVerification("99-9520-20", "claimed@example.test"))
        .rejects.toMatchObject({ code: "EMAIL_ALREADY_IN_USE", status: 409 });
      await pool.query(
        `UPDATE student_email_verifications
            SET created_at=NOW()-($2::int*INTERVAL '61 seconds')
          WHERE student_number=$1`,
        ["99-9520-20", index],
      );
    }

    await expect(requestStudentEmailVerification("99-9520-20", "claimed@example.test"))
      .rejects.toMatchObject({ code: "EMAIL_VERIFICATION_THROTTLED", status: 429 });
    const attempts = await pool.query<{
      pendingEmail: string;
      tokenHash: string;
      consumed: boolean;
    }>(
      `SELECT pending_email AS "pendingEmail",token_hash AS "tokenHash",
              consumed_at IS NOT NULL AS consumed
         FROM student_email_verifications WHERE student_number='99-9520-20'`,
    );
    expect(attempts.rowCount).toBe(5);
    expect(attempts.rows).toEqual(Array.from({ length: 5 }, () => ({
      pendingEmail: "ownership-conflict@invalid.local",
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      consumed: true,
    })));
    expect(JSON.stringify(attempts.rows)).not.toContain("claimed@example.test");
    const audits = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE entity_type='student_email_verification' AND entity_id='99-9520-20'
          AND action='STUDENT_EMAIL_OWNERSHIP_CONFLICT'`,
    );
    expect(audits.rowCount).toBe(5);
    expect(JSON.stringify(audits.rows)).not.toContain("claimed@example.test");
  });

  it("audits a repeated pending replacement as a resend", async () => {
    await insertTestStudent({
      studentNumber: "99-9521-21", firstName: "Replace", lastName: "Resend", yearLevel: 2,
    });
    await pool.query(
      "UPDATE students SET email='existing@example.test',email_verified_at=NOW() WHERE student_number='99-9521-21'",
    );
    await requestStudentEmailVerification("99-9521-21", "candidate@example.test");
    await pool.query(
      "UPDATE student_email_verifications SET created_at=NOW()-INTERVAL '61 seconds' WHERE student_number='99-9521-21'",
    );
    await requestStudentEmailVerification("99-9521-21", "candidate@example.test");

    const audits = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE entity_type='student_email_verification' AND entity_id='99-9521-21'
        ORDER BY created_at,action`,
    );
    expect(audits.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "STUDENT_EMAIL_REPLACEMENT_REQUESTED",
      "STUDENT_EMAIL_VERIFICATION_RESENT",
    ]));
    expect(audits.rows.filter((row) => row.action === "STUDENT_EMAIL_REPLACEMENT_REQUESTED")).toHaveLength(1);
    expect(audits.rows.filter((row) => row.action === "STUDENT_EMAIL_VERIFICATION_RESENT")).toHaveLength(1);
  });

  it("does not deadlock a resend racing token confirmation", async () => {
    await insertTestStudent({
      studentNumber: "99-9522-22", firstName: "Concurrent", lastName: "Resend", yearLevel: 2,
    });
    const original = await requestStudentEmailVerification("99-9522-22", "race@example.test");
    await pool.query(
      "UPDATE student_email_verifications SET created_at=NOW()-INTERVAL '61 seconds' WHERE student_number='99-9522-22'",
    );

    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT student_number FROM students WHERE student_number='99-9522-22' FOR UPDATE",
      );
      const resend = requestStudentEmailVerification("99-9522-22", "race@example.test");
      await waitForStudentLockWaiters(1);
      const confirmation = verifyStudentEmail(original.token);
      await waitForStudentLockWaiters(2);
      await blocker.query("COMMIT");
      released = true;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcomes = await Promise.race([
        Promise.allSettled([resend, confirmation]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Concurrent verification operations timed out.")),
            5_000,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toMatchObject({ code: "EMAIL_VERIFICATION_INVALID" });
          expect(String(outcome.reason)).not.toMatch(/deadlock/i);
        }
      }
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    } finally {
      if (!released) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("keeps portal changes transactional when SMTP is not configured and scopes read actions to the owner", async () => {
    await insertTestStudent({
      studentNumber: "99-9504-04",
      firstName: "Portal",
      lastName: "Only",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    const notificationId = await transaction((client) => createStudentNotification(client, {
      studentNumber: "99-9504-04",
      notificationType: "SCHEDULE_RESCHEDULED",
      title: "Schedule updated",
      message: "Review your new dates.",
    }));
    expect((await listStudentNotifications("99-9504-04")).unreadCount).toBe(1);
    await expect(markStudentNotificationRead("99-9599-99", notificationId!)).resolves.toBe(false);
    await expect(markStudentNotificationRead("99-9504-04", notificationId!)).resolves.toBe(true);
    expect((await listStudentNotifications("99-9504-04")).unreadCount).toBe(0);
  });
});
