// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import { fingerprintScheduleState } from "@/server/schedule/schedule-notifications";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import {
  listAdminEmailDeliveries,
  queueCurrentAdminEmailDelivery,
  retryAdminEmailDelivery,
} from "./admin-email-deliveries.service";

const studentPattern = "ADM-DEL-%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "ADM-DEL-%", "ADM-DEL-%");
}

async function verifiedStudent(studentNumber: string) {
  await insertTestStudent({
    studentNumber,
    firstName: "Delivery",
    lastName: "Student",
    yearLevel: 2,
  });
  await pool.query(
    `UPDATE students SET email=$2,email_verified_at=clock_timestamp()
      WHERE student_number=$1`,
    [studentNumber, `${studentNumber.toLowerCase()}@example.test`],
  );
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

async function failedSchedule(studentNumber: string, fingerprint: string, error = "SMTP password=raw-secret") {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO email_outbox (
       student_number,to_email,subject,text_body,status,attempts,last_error,
       message_kind,notification_type,source_type,source_id,schedule_fingerprint,
       last_attempt_at,last_attempt_status
     ) VALUES (
       $1,$2,'Schedule delivery','Safe body','PERMANENT_FAILURE',10,$3,
       'SCHEDULE','SCHEDULE_CURRENT_STATE','CURRENT_SCHEDULE_STATE',$4::text,$4::char(64),
       '2026-08-22T02:00:00.000Z','PERMANENT_FAILURE'
     ) RETURNING id::text`,
    [studentNumber, `${studentNumber.toLowerCase()}@example.test`, error, fingerprint],
  );
  return result.rows[0].id;
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("administrator email-delivery service", () => {
  it("defaults to permanent actionable failures and exposes history only through explicit filtering", async () => {
    await verifiedStudent("ADM-DEL-LIST");
    const failureId = await failedSchedule("ADM-DEL-LIST", "a".repeat(64));
    await pool.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,message_kind,
         notification_type,source_type,source_id,schedule_fingerprint,sent_at,last_attempt_at,last_attempt_status
       ) VALUES (
         'ADM-DEL-LIST','sent.private@example.test','Sent','Safe body','SENT',1,'SCHEDULE',
         'SCHEDULE_INITIAL_PUBLICATION','SCHEDULE_IMPORT','import-safe',$1,clock_timestamp(),clock_timestamp(),'SENT'
       )`,
      ["b".repeat(64)],
    );

    const actionable = await listAdminEmailDeliveries({});
    expect(actionable).toEqual({
      scope: "actionable",
      items: [{
        id: failureId,
        destination: "a***@example.test",
        state: "Failed",
        attempts: 10,
        lastAttempt: { at: "2026-08-22T02:00:00.000Z", state: "Failed" },
        context: {
          studentNumber: "ADM-DEL-LIST",
          messageKind: "SCHEDULE",
          notificationType: "SCHEDULE_CURRENT_STATE",
          sourceType: "CURRENT_SCHEDULE_STATE",
          sourceId: "a".repeat(64),
        },
        failureReason: "Email service authentication failed.",
        actionable: true,
      }],
    });
    expect(JSON.stringify(actionable)).not.toContain("raw-secret");
    expect(JSON.stringify(actionable)).not.toContain("adm-del-list@example.test");

    const history = await listAdminEmailDeliveries({ scope: "history", state: "Sent" });
    expect(history.scope).toBe("history");
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ state: "Sent", actionable: false });
  });

  it("resets and audits only a current permanent schedule failure", async () => {
    await verifiedStudent("ADM-DEL-RETRY");
    const fingerprint = await currentScheduleFingerprint("ADM-DEL-RETRY");
    const id = await failedSchedule("ADM-DEL-RETRY", fingerprint);

    const retried = await retryAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser);
    expect(retried).toMatchObject({ id, state: "Pending", attempts: 0, actionable: false });
    expect(retried.lastAttempt).toMatchObject({ state: "Failed" });

    const stored = await pool.query(
      `SELECT status,attempts,last_error,last_attempt_status
         FROM email_outbox WHERE id=$1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({
      status: "PENDING",
      attempts: 0,
      last_error: null,
      last_attempt_status: "PERMANENT_FAILURE",
    });
    const audit = await pool.query<{ actor_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id,metadata FROM audit_logs
        WHERE action='EMAIL_DELIVERY_ADMIN_RETRY_QUEUED' AND entity_id=$1`,
      [id],
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      actor_user_id: TEST_REFERENCE_IDS.adminUser,
      metadata: expect.objectContaining({
        studentNumber: "ADM-DEL-RETRY",
        messageKind: "SCHEDULE",
        previousAttempts: 10,
      }),
    })]);

    await expect(retryAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser)).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_NOT_RETRYABLE",
      status: 409,
    });
  });

  it("rejects a stale schedule retry with safe current state and queues one idempotent replacement", async () => {
    await verifiedStudent("ADM-DEL-STALE");
    await pool.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start
       ) VALUES ($1,'ADM-DEL-STALE','LABORATORY','2094-09-11','PENDING',TRUE,2094)`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );
    const id = await failedSchedule("ADM-DEL-STALE", "c".repeat(64), "connect ECONNREFUSED smtp.internal:587");

    await expect(retryAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser)).rejects.toMatchObject({
      code: "STALE_SCHEDULE_EMAIL",
      status: 409,
      details: {
        guidance: "Queue the student's current schedule instead.",
        currentState: {
          studentNumber: "ADM-DEL-STALE",
          laboratory: {
            scheduleType: "LABORATORY",
            status: "PENDING",
            date: "2094-09-11",
            affectedDate: null,
            location: "KABALAKA Clinic",
          },
          physicalExam: null,
          manualResolutionOpen: false,
        },
      },
    });

    const first = await queueCurrentAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser);
    const second = await queueCurrentAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser);
    expect(first).toMatchObject({ queued: true, currentState: { studentNumber: "ADM-DEL-STALE" } });
    expect(second).toMatchObject({ queued: false, currentState: { studentNumber: "ADM-DEL-STALE" } });
    const stored = await pool.query<{ status: string }>("SELECT status FROM email_outbox WHERE id=$1", [id]);
    expect(stored.rows[0].status).toBe("OBSOLETE");
    const replacements = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox
        WHERE student_number='ADM-DEL-STALE' AND notification_type='SCHEDULE_CURRENT_STATE'
          AND id<>$1`,
      [id],
    );
    expect(replacements.rows[0].count).toBe(1);
  });

  it("rejects queue-current for a schedule delivery that is not a failed or obsolete row", async () => {
    await verifiedStudent("ADM-DEL-NOTFAIL");
    const fingerprint = await currentScheduleFingerprint("ADM-DEL-NOTFAIL");
    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,message_kind,notification_type,
         source_type,source_id,schedule_fingerprint
       ) VALUES (
         'ADM-DEL-NOTFAIL','notfail@example.test','Current','Safe body','SENT','SCHEDULE',
         'SCHEDULE_CURRENT_STATE','CURRENT_SCHEDULE_STATE',$1::text,$1::char(64)
       ) RETURNING id::text`,
      [fingerprint],
    );

    await expect(queueCurrentAdminEmailDelivery(outbox.rows[0].id, TEST_REFERENCE_IDS.adminUser))
      .rejects.toMatchObject({ code: "EMAIL_DELIVERY_CURRENT_STATE_NOT_AVAILABLE", status: 409 });
    const notifications = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM student_portal_notifications
        WHERE student_number='ADM-DEL-NOTFAIL'`,
    );
    expect(notifications.rows[0].count).toBe(0);
  });

  it.each([
    ["expired", "NOW()-INTERVAL '1 minute'", null],
    ["superseded", "NOW()+INTERVAL '30 minutes'", "NOW()"],
  ])("rejects an %s verification retry and directs the student to request a new link", async (_label, expiresSql, consumedSql) => {
    const studentNumber = `ADM-DEL-${_label === "expired" ? "EXP" : "SUPER"}`;
    await verifiedStudent(studentNumber);
    const verification = await pool.query<{ id: string }>(
      `INSERT INTO student_email_verifications (
         student_number,pending_email,token_hash,expires_at,consumed_at
       ) VALUES ($1,$2,$3,${expiresSql},${consumedSql ?? "NULL"}) RETURNING id::text`,
      [studentNumber, `${studentNumber.toLowerCase()}@example.test`, _label.padEnd(64, "0")],
    );
    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,last_error,message_kind,
         notification_type,source_type,source_id,verification_body_encrypted,last_attempt_status
       ) VALUES (
         $1,$2,'Verify your MedClinic notification email','Verification email content is encrypted.',
         'PERMANENT_FAILURE',10,'Verification email delivery failed.','VERIFICATION',
         'EMAIL_VERIFICATION','STUDENT_EMAIL_VERIFICATION',$3,'ciphertext','PERMANENT_FAILURE'
       ) RETURNING id::text`,
      [studentNumber, `${studentNumber.toLowerCase()}@example.test`, verification.rows[0].id],
    );

    await expect(retryAdminEmailDelivery(outbox.rows[0].id, TEST_REFERENCE_IDS.adminUser)).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_RETRY_REJECTED",
      status: 409,
      details: { guidance: "Ask the student to request a new verification link." },
    });
    const stored = await pool.query<{ status: string }>("SELECT status FROM email_outbox WHERE id=$1", [outbox.rows[0].id]);
    expect(stored.rows[0].status).toBe("PERMANENT_FAILURE");
  });

  it("retries a current unexpired verification failure without exposing its encrypted body", async () => {
    const studentNumber = "ADM-DEL-VERIFY";
    await verifiedStudent(studentNumber);
    const verification = await pool.query<{ id: string }>(
      `INSERT INTO student_email_verifications (
         student_number,pending_email,token_hash,expires_at
       ) VALUES ($1,$2,$3,NOW()+INTERVAL '30 minutes') RETURNING id::text`,
      [studentNumber, "verify@example.test", "valid".padEnd(64, "0")],
    );
    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,last_error,message_kind,
         notification_type,source_type,source_id,verification_body_encrypted,last_attempt_status
       ) VALUES (
         $1,'verify@example.test','Verify your MedClinic notification email',
         'Verification email content is encrypted.','PERMANENT_FAILURE',10,
         'Verification email delivery failed.','VERIFICATION','EMAIL_VERIFICATION',
         'STUDENT_EMAIL_VERIFICATION',$2,'v1.raw-encrypted-envelope','PERMANENT_FAILURE'
       ) RETURNING id::text`,
      [studentNumber, verification.rows[0].id],
    );

    const result = await retryAdminEmailDelivery(outbox.rows[0].id, TEST_REFERENCE_IDS.adminUser);
    expect(result).toMatchObject({
      id: outbox.rows[0].id,
      destination: "v***@example.test",
      state: "Pending",
      attempts: 0,
      context: { messageKind: "VERIFICATION" },
    });
    expect(JSON.stringify(result)).not.toContain("raw-encrypted-envelope");
  });
});
