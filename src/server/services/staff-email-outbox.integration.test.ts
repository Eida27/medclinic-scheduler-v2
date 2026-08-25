// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/server/db/pool";
import {
  decryptEmailOutboxSensitiveBody,
  encryptEmailOutboxSensitiveBody,
} from "@/server/email/verification-body-encryption";
import { claimEmailOutboxMessages, deliverClaimedEmail } from "./email-outbox.service";
import { retryAdminEmailDelivery } from "./admin-email-deliveries.service";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

const encryptionKey = Buffer.alloc(32, 17).toString("base64");
const fixtureDomain = "@staff-outbox.test";

async function cleanup() {
  const users = await pool.query<{ id: string }>("SELECT id FROM users WHERE full_name LIKE 'TEST Staff Outbox%' OR email LIKE $1", [`%${fixtureDomain}`]);
  const ids = users.rows.map((row) => row.id);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM audit_logs WHERE entity_type='email_outbox' AND entity_id IN (
       SELECT id::text FROM email_outbox WHERE source_id IN (
         SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
         UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[])
       )
     )`,
    [ids],
  );
  await pool.query(
    `DELETE FROM email_outbox WHERE source_id IN (
       SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[])
     )`,
    [ids],
  );
  await pool.query("DELETE FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM staff_password_resets WHERE user_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
}

async function staffUser(options: { verified?: boolean; mustChangePassword?: boolean } = {}) {
  const email = `recipient${fixtureDomain}`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (
       full_name,email,password_hash,role,email_verified_at,must_change_password
     ) VALUES (
       'TEST Staff Outbox User',$1,'hash','COORDINATOR',
       CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,$3
     ) RETURNING id::text`,
    [email, options.verified ?? false, options.mustChangePassword ?? true],
  );
  return { id: user.rows[0].id, email };
}

async function staffSecurityOutbox(input: {
  userId: string;
  email: string;
  purpose: "STAFF_EMAIL_VERIFICATION" | "STAFF_PASSWORD_RESET";
  body: string;
}) {
  const tokenHash = createHash("sha256").update(`${input.userId}:${input.purpose}`).digest("hex");
  const request = input.purpose === "STAFF_EMAIL_VERIFICATION"
    ? await pool.query<{ id: string }>(
        `INSERT INTO staff_email_verifications (user_id,pending_email,token_hash,expires_at)
         VALUES ($1,$2,$3,clock_timestamp()+INTERVAL '30 minutes') RETURNING id::text`,
        [input.userId, input.email, tokenHash],
      )
    : await pool.query<{ id: string }>(
        `INSERT INTO staff_password_resets (user_id,token_hash,expires_at)
         VALUES ($1,$2,clock_timestamp()+INTERVAL '30 minutes') RETURNING id::text`,
        [input.userId, tokenHash],
      );
  const encrypted = encryptEmailOutboxSensitiveBody(input.body, encryptionKey, {
    iv: Buffer.from("000102030405060708090a0b", "hex"),
  });
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO email_outbox (
       student_number,to_email,subject,text_body,message_kind,notification_type,
       source_type,source_id,verification_body_encrypted,next_attempt_at
     ) VALUES (
       NULL,$1,'Staff security','Staff security email content is encrypted.',
       'STAFF_SECURITY',$2,$2,$3,$4,clock_timestamp()-INTERVAL '1 second'
     ) RETURNING id::text`,
    [input.email, input.purpose, request.rows[0].id, encrypted],
  );
  return { requestId: request.rows[0].id, outboxId: outbox.rows[0].id, encrypted };
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("staff security email outbox", () => {
  it("keeps the existing envelope compatible under the generalized helper names", () => {
    const encrypted = encryptEmailOutboxSensitiveBody("bearer token body", encryptionKey, {
      iv: Buffer.from("000102030405060708090a0b", "hex"),
    });
    expect(encrypted).toMatch(/^v1\./);
    expect(decryptEmailOutboxSensitiveBody(encrypted, encryptionKey)).toBe("bearer token body");
  });

  it("delivers a live staff verification request and clears its encrypted body", async () => {
    const user = await staffUser();
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_EMAIL_VERIFICATION",
      body: "Verify: https://example.test/staff/email-verification/confirm?token=verification-secret",
    });
    const [message] = await claimEmailOutboxMessages(1, new Date());
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "staff-verification" }) };
    await expect(deliverClaimedEmail(message, transport, new Date(), "clinic@example.test", encryptionKey))
      .resolves.toEqual({ status: "SENT" });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: user.email,
      text: expect.stringContaining("verification-secret"),
    }));
    await expect(pool.query(
      "SELECT status,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [fixture.outboxId],
    )).resolves.toMatchObject({ rows: [{ status: "SENT", verification_body_encrypted: null }] });
  });

  it("delivers reset mail only for a live, verified, fully onboarded account", async () => {
    const user = await staffUser({ verified: true, mustChangePassword: false });
    await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_PASSWORD_RESET",
      body: "Reset: https://example.test/reset-password?token=reset-secret",
    });
    const [message] = await claimEmailOutboxMessages(1, new Date());
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "staff-reset" }) };
    await expect(deliverClaimedEmail(message, transport, new Date(), "clinic@example.test", encryptionKey))
      .resolves.toEqual({ status: "SENT" });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("reset-secret"),
    }));
  });

  it.each([
    ["invalidated", "UPDATE staff_email_verifications SET invalidated_at=clock_timestamp() WHERE id=$1"],
    ["expired", "UPDATE staff_email_verifications SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1"],
    ["destination changed", "UPDATE users SET email='changed@staff-outbox.test' WHERE id=(SELECT user_id FROM staff_email_verifications WHERE id=$1)"],
  ])("obsoletes %s verification mail before SMTP", async (_label, mutation) => {
    const user = await staffUser();
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_EMAIL_VERIFICATION",
      body: "secret verification body",
    });
    await pool.query(mutation, [fixture.requestId]);
    const [message] = await claimEmailOutboxMessages(1, new Date());
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "must-not-send" }) };
    await expect(deliverClaimedEmail(message, transport, new Date(), "clinic@example.test", encryptionKey))
      .resolves.toEqual({ status: "OBSOLETE" });
    expect(transport.sendMail).not.toHaveBeenCalled();
    await expect(pool.query(
      "SELECT status,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [fixture.outboxId],
    )).resolves.toMatchObject({ rows: [{ status: "OBSOLETE", verification_body_encrypted: null }] });
  });

  it("obsoletes reset mail after account deletion without decrypting or sending it", async () => {
    const user = await staffUser({ verified: true, mustChangePassword: false });
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_PASSWORD_RESET",
      body: "secret reset body",
    });
    await pool.query(
      `UPDATE users SET deleted_at=clock_timestamp(),deleted_by=id,email=NULL,password_hash=NULL,
                        email_verified_at=NULL,must_change_password=FALSE WHERE id=$1`,
      [user.id],
    );
    const [message] = await claimEmailOutboxMessages(1, new Date());
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: "must-not-send" }) };
    await expect(deliverClaimedEmail(message, transport, new Date(), "clinic@example.test", encryptionKey))
      .resolves.toEqual({ status: "OBSOLETE" });
    expect(transport.sendMail).not.toHaveBeenCalled();
    await expect(pool.query(
      "SELECT status,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [fixture.outboxId],
    )).resolves.toMatchObject({ rows: [{ status: "OBSOLETE", verification_body_encrypted: null }] });
  });

  it("retains encrypted content for a retry and stores only a generic SMTP failure", async () => {
    const user = await staffUser({ verified: true, mustChangePassword: false });
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_PASSWORD_RESET",
      body: "reset token retry-secret",
    });
    const [message] = await claimEmailOutboxMessages(1, new Date());
    const transport = { sendMail: vi.fn().mockRejectedValue(new Error("SMTP echoed retry-secret")) };
    await expect(deliverClaimedEmail(message, transport, new Date(), "clinic@example.test", encryptionKey))
      .resolves.toEqual({ status: "PENDING" });
    const stored = await pool.query<{ status: string; last_error: string; verification_body_encrypted: string }>(
      "SELECT status,last_error,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [fixture.outboxId],
    );
    expect(stored.rows[0].status).toBe("PENDING");
    expect(stored.rows[0].last_error).toBe("Staff security email delivery failed.");
    expect(stored.rows[0].verification_body_encrypted).toBe(fixture.encrypted);
    expect(JSON.stringify(stored.rows[0])).not.toContain("retry-secret");
  });

  it("lets an Administrator retry only a still-eligible staff security request", async () => {
    const user = await staffUser({ verified: true, mustChangePassword: false });
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_PASSWORD_RESET",
      body: "live reset body",
    });
    await pool.query(
      "UPDATE email_outbox SET status='PERMANENT_FAILURE',attempts=10,last_attempt_status='PERMANENT_FAILURE' WHERE id=$1",
      [fixture.outboxId],
    );
    await expect(retryAdminEmailDelivery(fixture.outboxId, TEST_REFERENCE_IDS.adminUser))
      .resolves.toMatchObject({
        id: fixture.outboxId,
        attempts: 0,
        state: "Pending",
        context: { messageKind: "STAFF_SECURITY", sourceType: "STAFF_PASSWORD_RESET" },
      });
  });

  it("obsoletes an invalid staff security failure instead of retrying it", async () => {
    const user = await staffUser();
    const fixture = await staffSecurityOutbox({
      userId: user.id,
      email: user.email,
      purpose: "STAFF_EMAIL_VERIFICATION",
      body: "invalid verification body",
    });
    await pool.query("UPDATE staff_email_verifications SET invalidated_at=clock_timestamp() WHERE id=$1", [fixture.requestId]);
    await pool.query(
      "UPDATE email_outbox SET status='PERMANENT_FAILURE',attempts=10,last_attempt_status='PERMANENT_FAILURE' WHERE id=$1",
      [fixture.outboxId],
    );
    await expect(retryAdminEmailDelivery(fixture.outboxId, TEST_REFERENCE_IDS.adminUser))
      .rejects.toMatchObject({ code: "STAFF_SECURITY_RETRY_REJECTED", status: 409 });
    await expect(pool.query(
      "SELECT status,attempts,verification_body_encrypted FROM email_outbox WHERE id=$1",
      [fixture.outboxId],
    )).resolves.toMatchObject({ rows: [{
      status: "OBSOLETE",
      attempts: 10,
      verification_body_encrypted: null,
    }] });
  });
});
