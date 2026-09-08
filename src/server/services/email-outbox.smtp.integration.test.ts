// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { queueStaffEmailVerification } from "@/server/services/staff-email-verification.service";
import { deliverEmailOutboxBatch } from "./email-outbox.service";
import { startLoopbackSmtpSink } from "../../../scripts/loopback-smtp-sink";

const email = "administrator@task2-delivery.test";

async function cleanup() {
  const users = await pool.query<{ id: string }>(
    "SELECT id::text FROM users WHERE email=$1 OR full_name='TEST Task 2 SMTP Delivery'",
    [email],
  );
  const ids = users.rows.map((row) => row.id);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM audit_logs
      WHERE (entity_type='user' AND entity_id=ANY($1::text[]))
         OR (entity_type='staff_email_verification' AND entity_id IN (
           SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
         ))`,
    [ids],
  );
  await pool.query(
    `DELETE FROM email_outbox WHERE source_id IN (
       SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
     )`,
    [ids],
  );
  await pool.query("DELETE FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
}

beforeEach(cleanup);
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("application outbox delivery through the loopback SMTP sink", () => {
  it("delivers a queued staff verification and clears its encrypted body", async () => {
    const sink = await startLoopbackSmtpSink({ port: 0 });
    try {
      vi.stubEnv("SMTP_HOST", sink.host);
      vi.stubEnv("SMTP_PORT", String(sink.port));
      vi.stubEnv("SMTP_FROM", "clinic@delivery.test");
      vi.stubEnv("SMTP_USER", "");
      vi.stubEnv("SMTP_PASS", "");
      vi.stubEnv("APP_URL", "http://127.0.0.1:3000");

      const userId = randomUUID();
      const requestId = await transaction(async (client) => {
        await client.query(
          `INSERT INTO users (
             id,full_name,email,password_hash,role,email_verified_at,must_change_password
           ) VALUES ($1,'TEST Task 2 SMTP Delivery',$2,'hash','COORDINATOR',NULL,TRUE)`,
          [userId, email],
        );
        return (await queueStaffEmailVerification(client, userId, email, {
          enforceRateLimit: false,
        })).requestId;
      });

      await expect(deliverEmailOutboxBatch()).resolves.toEqual({
        skipped: false,
        processedCount: 1,
      });
      const message = await sink.waitForMessage({ timeoutMs: 2_000 });
      expect(message.envelope.rcptTo).toEqual([email]);
      expect(message.raw.toString("utf8")).toContain(
        "/staff/email-verification/confirm?token=",
      );
      await expect(pool.query(
        `SELECT status,verification_body_encrypted
           FROM email_outbox WHERE source_id=$1`,
        [requestId],
      )).resolves.toMatchObject({
        rows: [{ status: "SENT", verification_body_encrypted: null }],
      });
    } finally {
      await sink.close();
    }
  });
});
