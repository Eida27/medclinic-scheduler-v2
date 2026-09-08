// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/server/db/pool";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import { fingerprintScheduleState } from "@/server/schedule/schedule-notifications";
import { retryAdminEmailDelivery } from "@/server/services/admin-email-deliveries.service";
import {
  claimEmailOutboxMessages,
  deliverClaimedEmail,
  obsoleteEmailOutboxMessage,
} from "@/server/services/email-outbox.service";
import { encryptVerificationEmailBody } from "@/server/email/verification-body-encryption";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  EMAIL_OUTBOX_INTERVAL_MS,
  startEmailOutboxWorker,
} from "./email-outbox.worker";

const studentPattern = "99-92%";
const encryptionKey = Buffer.alloc(32, 13).toString("base64");
type EmailGlobal = typeof globalThis & { __medclinicEmailOutboxWorkerStarted?: boolean };

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-EMAIL-OUTBOX%", "TEST-EMAIL-OUTBOX%");
}

async function outbox(studentNumber: string, attempts = 0) {
  await pool.query(
    "UPDATE students SET email=$2,email_verified_at=clock_timestamp() WHERE student_number=$1",
    [studentNumber, `${studentNumber}@example.test`],
  );
  const result = await pool.query<{ id: string }>(
    `INSERT INTO email_outbox (
       student_number, to_email, subject, text_body, attempts, next_attempt_at, message_kind
     ) VALUES ($1,$2,'Test subject','Test body',$3,'2027-08-01T00:00:00Z','SCHEDULE') RETURNING id`,
    [studentNumber, `${studentNumber}@example.test`, attempts],
  );
  return result.rows[0].id;
}

async function currentScheduleFingerprint(studentNumber: string) {
  const client = await pool.connect();
  try {
    const state = await loadAuthoritativeScheduleState(client, studentNumber);
    if (!state) throw new Error("Missing schedule state fixture");
    return fingerprintScheduleState(state);
  } finally {
    client.release();
  }
}

async function waitForStudentDeliveryLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock'
          AND query ILIKE '%FROM students%FOR NO KEY UPDATE%'`,
    );
    if (waiting.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected schedule delivery to wait for the student address lock.");
}

async function verificationOutbox(studentNumber: string, body: string) {
  const encryptedBody = encryptVerificationEmailBody(body, encryptionKey, {
    iv: Buffer.from("000102030405060708090a0b", "hex"),
  });
  const verification = await pool.query<{ id: string }>(
    `INSERT INTO student_email_verifications (
       student_number,pending_email,token_hash,expires_at
     ) VALUES ($1,$2,$3,clock_timestamp()+INTERVAL '30 minutes')
     RETURNING id::text`,
    [
      studentNumber,
      `${studentNumber}@example.test`,
      createHash("sha256").update(`${studentNumber}@example.test`).digest("hex"),
    ],
  );
  const result = await pool.query<{ id: string }>(
    `INSERT INTO email_outbox (
       student_number,to_email,subject,text_body,message_kind,
       verification_body_encrypted,next_attempt_at,notification_type,source_type,source_id
     ) VALUES ($1,$2,'Verify your MedClinic notification email',
               'Verification email content is encrypted.','VERIFICATION',$3,
               '2027-08-01T00:00:00Z','EMAIL_VERIFICATION',
               'STUDENT_EMAIL_VERIFICATION',$4) RETURNING id`,
    [studentNumber, `${studentNumber}@example.test`, encryptedBody, verification.rows[0].id],
  );
  return { outboxId: result.rows[0].id, verificationId: verification.rows[0].id };
}

beforeAll(cleanup);
beforeEach(() => {
  delete (globalThis as EmailGlobal).__medclinicEmailOutboxWorkerStarted;
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("email outbox delivery", () => {
  it("claims concurrent batches with FOR UPDATE SKIP LOCKED and no duplicate IDs", async () => {
    for (const studentNumber of ["99-9201-01", "99-9202-02"]) {
      await insertTestStudent({ studentNumber, firstName: "Email", lastName: "Student", yearLevel: 3 });
      await outbox(studentNumber);
    }
    const now = new Date("2027-08-02T00:00:00.000Z");
    const [first, second] = await Promise.all([
      claimEmailOutboxMessages(1, now),
      claimEmailOutboxMessages(1, now),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).not.toBe(second[0].id);
  });

  it("marks SMTP success sent", async () => {
    await insertTestStudent({ studentNumber: "99-9203-03", firstName: "Sent", lastName: "Student", yearLevel: 3 });
    const id = await outbox("99-9203-03");
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "smtp-1" }) };
    await deliverClaimedEmail(message, transport, new Date("2027-08-02T00:00:00.000Z"), "clinic@example.test");
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "clinic@example.test",
      to: "99-9203-03@example.test",
      text: "Test body",
    }));
    expect((await pool.query(
      `SELECT status,attempts,sent_at IS NOT NULL AS sent,last_attempt_at,
              last_attempt_status,message_kind,text_body,verification_body_encrypted
         FROM email_outbox WHERE id=$1`,
      [id],
    )).rows).toEqual([expect.objectContaining({
      status: "SENT",
      attempts: 1,
      sent: true,
      last_attempt_at: new Date("2027-08-02T00:00:00.000Z"),
      last_attempt_status: "SENT",
      message_kind: "SCHEDULE",
      text_body: "Test body",
      verification_body_encrypted: null,
    })]);
    expect((await pool.query(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='email_outbox' AND entity_id=$1`,
      [id],
    )).rows).toEqual([{
      action: "EMAIL_OUTBOX_DELIVERED",
      metadata: expect.objectContaining({ messageKind: "SCHEDULE", attempts: 1 }),
    }]);
  });

  it("obsoletes an admin-retried schedule message when address replacement commits before delivery", async () => {
    const studentNumber = "99-9209-09";
    const oldAddress = "former-address@example.test";
    await insertTestStudent({ studentNumber, firstName: "Former", lastName: "Address", yearLevel: 3 });
    await pool.query(
      "UPDATE students SET email=$2,email_verified_at=clock_timestamp() WHERE student_number=$1",
      [studentNumber, oldAddress],
    );
    const fingerprint = await currentScheduleFingerprint(studentNumber);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,last_error,next_attempt_at,
         message_kind,notification_type,source_type,source_id,schedule_fingerprint,last_attempt_status
       ) VALUES (
         $1,$2,'Current schedule','Safe schedule body','PERMANENT_FAILURE',10,
         'Prior delivery failure.','2027-08-01T00:00:00Z','SCHEDULE',
         'SCHEDULE_CURRENT_STATE','CURRENT_SCHEDULE_STATE',$3::text,$3::char(64),'PERMANENT_FAILURE'
       ) RETURNING id::text`,
      [studentNumber, oldAddress, fingerprint],
    );
    await retryAdminEmailDelivery(inserted.rows[0].id, TEST_REFERENCE_IDS.adminUser);
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "must-not-send" }) };
    const replacement = await pool.connect();
    let committed = false;
    try {
      await replacement.query("BEGIN");
      await replacement.query(
        "SELECT student_number FROM students WHERE student_number=$1 FOR UPDATE",
        [studentNumber],
      );
      await replacement.query(
        "UPDATE students SET email='current-address@example.test',email_verified_at=clock_timestamp() WHERE student_number=$1",
        [studentNumber],
      );
      const delivery = deliverClaimedEmail(
        message,
        transport,
        new Date("2027-08-02T00:00:00.000Z"),
        "clinic@example.test",
      );
      await waitForStudentDeliveryLock();
      await replacement.query("COMMIT");
      committed = true;

      await expect(delivery).resolves.toEqual({ status: "OBSOLETE" });
      expect(transport.sendMail).not.toHaveBeenCalled();
      const stored = await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM email_outbox WHERE id=$1",
        [inserted.rows[0].id],
      );
      expect(stored.rows[0]).toEqual({ status: "OBSOLETE", attempts: 0 });
      const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
        "SELECT action,metadata FROM audit_logs WHERE entity_type='email_outbox' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1",
        [inserted.rows[0].id],
      );
      expect(audit.rows[0]).toEqual({
        action: "EMAIL_OUTBOX_OBSOLETE",
        metadata: expect.objectContaining({ reason: "VERIFIED_ADDRESS_CHANGED" }),
      });
    } finally {
      if (!committed) await replacement.query("ROLLBACK");
      replacement.release();
    }
  });

  it("decrypts verification content only for delivery and clears ciphertext after success", async () => {
    await insertTestStudent({ studentNumber: "99-9206-06", firstName: "Encrypted", lastName: "Student", yearLevel: 3 });
    const body = "Verify at https://example.test/student/email-verification/confirm?token=raw-secret";
    const { outboxId: id } = await verificationOutbox("99-9206-06", body);
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    expect(message.textBody).toBe("Verification email content is encrypted.");
    expect(message.verificationBodyEncrypted).not.toContain("raw-secret");
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "smtp-verified" }) };
    await deliverClaimedEmail(
      message,
      transport,
      new Date("2027-08-02T00:00:00.000Z"),
      "clinic@example.test",
      encryptionKey,
    );
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: body }));
    expect((await pool.query(
      "SELECT status,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [id],
    )).rows).toEqual([{ status: "SENT", verification_body_encrypted: null }]);
  });

  it("does not persist or audit a verification token echoed by SMTP failure", async () => {
    await insertTestStudent({ studentNumber: "99-9208-08", firstName: "Failure", lastName: "Student", yearLevel: 3 });
    const body = "Verify at https://example.test/student/email-verification/confirm?token=failure-secret";
    const { outboxId: id } = await verificationOutbox("99-9208-08", body);
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    const transport = {
      sendMail: vi.fn().mockRejectedValue(new Error(`SMTP echoed ${body}`)),
    };
    await deliverClaimedEmail(
      message,
      transport,
      new Date("2027-08-02T00:00:00.000Z"),
      "clinic@example.test",
      encryptionKey,
    );
    const persisted = await pool.query<{ last_error: string; verification_body_encrypted: string }>(
      `SELECT last_error,verification_body_encrypted FROM email_outbox WHERE id=$1`,
      [id],
    );
    expect(persisted.rows[0].last_error).toBe("Verification email delivery failed.");
    expect(persisted.rows[0].verification_body_encrypted).not.toContain("failure-secret");
    const audits = await pool.query(
      "SELECT metadata FROM audit_logs WHERE entity_type='email_outbox' AND entity_id=$1",
      [id],
    );
    expect(JSON.stringify(audits.rows)).not.toContain("failure-secret");
    expect(JSON.stringify(audits.rows)).not.toContain("token=");
  });

  it("uses bounded exponential retry and becomes permanent after ten attempts", async () => {
    for (const [studentNumber, attempts] of [["99-9204-04", 0], ["99-9205-05", 9]] as const) {
      await insertTestStudent({ studentNumber, firstName: "Retry", lastName: "Student", yearLevel: 3 });
      await outbox(studentNumber, attempts);
    }
    const now = new Date("2027-08-02T00:00:00.000Z");
    const claimed = await claimEmailOutboxMessages(2, now);
    const transport = { sendMail: vi.fn().mockRejectedValue(new Error("SMTP unavailable")) };
    for (const message of claimed) await deliverClaimedEmail(message, transport, now, "clinic@example.test");
    const rows = await pool.query(
      `SELECT student_number, status, attempts,
              EXTRACT(EPOCH FROM (next_attempt_at-$1::timestamptz))::int AS retry_seconds,
              last_error
         FROM email_outbox ORDER BY student_number`,
      [now],
    );
    expect(rows.rows).toEqual([
      { student_number: "99-9204-04", status: "PENDING", attempts: 1, retry_seconds: 60, last_error: "SMTP unavailable" },
      { student_number: "99-9205-05", status: "PERMANENT_FAILURE", attempts: 10, retry_seconds: 0, last_error: "SMTP unavailable" },
    ]);
    const attemptStates = await pool.query(
      `SELECT student_number,last_attempt_at,last_attempt_status
         FROM email_outbox ORDER BY student_number`,
    );
    expect(attemptStates.rows).toEqual([
      { student_number: "99-9204-04", last_attempt_at: now, last_attempt_status: "PENDING" },
      { student_number: "99-9205-05", last_attempt_at: now, last_attempt_status: "PERMANENT_FAILURE" },
    ]);
    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='email_outbox'
          AND entity_id=ANY($1::text[])
        ORDER BY action`,
      [claimed.map((message) => message.id)],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "EMAIL_OUTBOX_PERMANENT_FAILURE",
      "EMAIL_OUTBOX_RETRY_SCHEDULED",
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("SMTP unavailable");
  });

  it("obsoletes verification mail, clears ciphertext, and writes a token-safe audit", async () => {
    await insertTestStudent({ studentNumber: "99-9207-07", firstName: "Obsolete", lastName: "Student", yearLevel: 3 });
    const { outboxId: id } = await verificationOutbox(
      "99-9207-07",
      "https://example.test/student/email-verification/confirm?token=obsolete-secret",
    );
    await expect(obsoleteEmailOutboxMessage(
      id,
      "SUPERSEDED",
      new Date("2027-08-02T00:00:00.000Z"),
    )).resolves.toBe(true);
    expect((await pool.query(
      `SELECT status,verification_body_encrypted,locked_at,last_attempt_at,last_attempt_status
         FROM email_outbox WHERE id=$1`,
      [id],
    )).rows).toEqual([{
      status: "OBSOLETE",
      verification_body_encrypted: null,
      locked_at: null,
      last_attempt_at: new Date("2027-08-02T00:00:00.000Z"),
      last_attempt_status: "OBSOLETE",
    }]);
    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE entity_type='email_outbox' AND entity_id=$1",
      [id],
    );
    expect(audit.rows).toEqual([{
      action: "EMAIL_OUTBOX_OBSOLETE",
      metadata: expect.objectContaining({ reason: "SUPERSEDED", messageKind: "VERIFICATION" }),
    }]);
    expect(JSON.stringify(audit.rows)).not.toContain("obsolete-secret");
  });

  it.each([
    ["expired", "EXPIRED", "expires_at=clock_timestamp()-INTERVAL '1 second'"],
    ["superseded", "SUPERSEDED", "consumed_at=clock_timestamp()"],
  ])("does not send %s verification mail and atomically obsoletes its ciphertext", async (_label, reason, mutation) => {
    const studentNumber = _label === "expired" ? "99-9210-10" : "99-9211-11";
    await insertTestStudent({ studentNumber, firstName: "Invalid", lastName: "Verification", yearLevel: 3 });
    const body = `https://example.test/student/email-verification/confirm?token=${_label}-secret`;
    const fixture = await verificationOutbox(studentNumber, body);
    await pool.query(
      `UPDATE student_email_verifications SET ${mutation} WHERE id=$1`,
      [fixture.verificationId],
    );
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "must-not-send" }) };

    await expect(deliverClaimedEmail(
      message,
      transport,
      new Date("2027-08-02T00:00:00.000Z"),
      "clinic@example.test",
      encryptionKey,
    )).resolves.toEqual({ status: "OBSOLETE" });

    expect(transport.sendMail).not.toHaveBeenCalled();
    await expect(pool.query(
      `SELECT status,verification_body_encrypted,locked_at,last_attempt_status
         FROM email_outbox WHERE id=$1`,
      [fixture.outboxId],
    )).resolves.toMatchObject({ rows: [{
      status: "OBSOLETE",
      verification_body_encrypted: null,
      locked_at: null,
      last_attempt_status: "OBSOLETE",
    }] });
    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE entity_type='email_outbox' AND entity_id=$1",
      [fixture.outboxId],
    );
    expect(audits.rows).toEqual([{
      action: "EMAIL_OUTBOX_OBSOLETE",
      metadata: expect.objectContaining({ reason, messageKind: "VERIFICATION" }),
    }]);
    expect(JSON.stringify(audits.rows)).not.toContain(`${_label}-secret`);
    expect(JSON.stringify(audits.rows)).not.toContain("token=");
  });

  it("delivers an untyped legacy notification as ordinary GENERAL plaintext mail", async () => {
    const studentNumber = "99-9212-12";
    await insertTestStudent({ studentNumber, firstName: "General", lastName: "Notification", yearLevel: 3 });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,next_attempt_at
       ) VALUES ($1,'general@example.test','General notice','Ordinary notification body',
                 '2027-08-01T00:00:00Z') RETURNING id::text`,
      [studentNumber],
    );
    const [message] = await claimEmailOutboxMessages(1, new Date("2027-08-02T00:00:00.000Z"));
    expect(message.messageKind).toBe("GENERAL");
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "general-1" }) };

    await expect(deliverClaimedEmail(
      message,
      transport,
      new Date("2027-08-02T00:00:00.000Z"),
      "clinic@example.test",
    )).resolves.toEqual({ status: "SENT" });

    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "general@example.test",
      text: "Ordinary notification body",
    }));
    await expect(pool.query(
      "SELECT status,message_kind FROM email_outbox WHERE id=$1",
      [inserted.rows[0].id],
    )).resolves.toMatchObject({ rows: [{ status: "SENT", message_kind: "GENERAL" }] });
  });
});

describe("startEmailOutboxWorker", () => {
  it("runs at startup, polls every minute, and unreferences the timer", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn(() => ({ unref: vi.fn() }));
    expect(startEmailOutboxWorker({ deliver, schedule })).toBe(true);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), EMAIL_OUTBOX_INTERVAL_MS);
    expect(EMAIL_OUTBOX_INTERVAL_MS).toBe(60_000);
    expect(schedule.mock.results[0].value.unref).toHaveBeenCalledOnce();
    expect(startEmailOutboxWorker({ deliver, schedule })).toBe(false);
  });
});
