// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent } from "@/test/integration-fixtures";
import {
  createStudentNotification,
  createStudentNotifications,
  listStudentNotifications,
  markStudentNotificationRead,
} from "./student-notifications.service";
import {
  getStudentEmailVerificationStatus,
  requestStudentEmailVerification,
  verifyStudentEmail,
} from "./student-email.service";
import { decryptVerificationEmailBody } from "@/server/email/verification-body-encryption";

const studentPattern = "99-95%";
const encryptionKey = Buffer.alloc(32, 11).toString("base64");
const originalEncryptionKey = process.env.EMAIL_OUTBOX_ENCRYPTION_KEY;

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-STUDENT-EMAIL%", "TEST-STUDENT-EMAIL%");
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
      "SELECT student_number,to_email FROM email_outbox ORDER BY student_number",
    )).resolves.toMatchObject({
      rows: [{ student_number: "99-9505-05", to_email: "batch@example.test" }],
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
    const outbox = await pool.query("SELECT student_number, to_email FROM email_outbox ORDER BY student_number");
    expect(outbox.rows).toEqual([{ student_number: "99-9501-01", to_email: "verified@example.test" }]);
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
        WHERE student_number='99-9503-03' AND message_kind='SCHEDULE'`,
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
