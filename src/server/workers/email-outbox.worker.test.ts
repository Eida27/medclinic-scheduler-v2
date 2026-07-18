// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/server/db/pool";
import {
  claimEmailOutboxMessages,
  deliverClaimedEmail,
} from "@/server/services/email-outbox.service";
import { cleanupTestFixtures, insertTestStudent } from "@/test/integration-fixtures";
import {
  EMAIL_OUTBOX_INTERVAL_MS,
  startEmailOutboxWorker,
} from "./email-outbox.worker";

const studentPattern = "99-92%";
type EmailGlobal = typeof globalThis & { __medclinicEmailOutboxWorkerStarted?: boolean };

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-EMAIL-OUTBOX%", "TEST-EMAIL-OUTBOX%");
}

async function outbox(studentNumber: string, attempts = 0) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO email_outbox (
       student_number, to_email, subject, text_body, attempts, next_attempt_at
     ) VALUES ($1,$2,'Test subject','Test body',$3,'2027-08-01T00:00:00Z') RETURNING id`,
    [studentNumber, `${studentNumber}@example.test`, attempts],
  );
  return result.rows[0].id;
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
    }));
    expect((await pool.query("SELECT status, attempts, sent_at IS NOT NULL AS sent FROM email_outbox WHERE id=$1", [id])).rows)
      .toEqual([{ status: "SENT", attempts: 1, sent: true }]);
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
