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
  await pool.query("DELETE FROM clinic_closure_manual_cases WHERE student_number LIKE $1", [studentPattern]);
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'ADM-DEL-MANUAL-%'");
  await cleanupTestFixtures(studentPattern, "ADM-DEL-%", "ADM-DEL-%");
}

async function waitForRowLockWaiter(tableName: "students" | "appointments") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock'
          AND query ILIKE $1 AND query ILIKE '%FOR UPDATE%'`,
      [`%FROM ${tableName}%`],
    );
    if (waiting.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${tableName} row-lock waiter.`);
}

async function waitForManualResolutionQueueWaiter() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock'
          AND query ILIKE '%pg_advisory_xact_lock%medclinic:schedule-import-queue%'`,
    );
    if (waiting.rows[0].count > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
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

async function openManualResolutionFixture(studentNumber: string, appointmentDate: string) {
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start
     ) VALUES ($1,$2,'LABORATORY',$3,'PENDING',TRUE,2096) RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, appointmentDate],
  );
  const closure = await pool.query<{ id: string }>(
    `INSERT INTO clinic_closure_groups (
       start_date,end_date,category,reason,created_by,creation_batch_id,recovery_mode
     ) VALUES ('2096-05-05','2096-05-05','CLOSURE',$1,$2,gen_random_uuid(),'MANUAL_ALL')
     RETURNING id::text`,
    [`ADM-DEL-MANUAL-${studentNumber}`, TEST_REFERENCE_IDS.adminUser],
  );
  const manualCase = await pool.query<{ id: string }>(
    `INSERT INTO clinic_closure_manual_cases (
       student_number,closure_group_id,schedule_cycle_start,
       affected_laboratory_appointment_id,reason_code,reason_message
     ) VALUES ($1,$2,2096,$3,'NO_REPLACEMENT_CAPACITY','Manual Resolution lock fixture.')
     RETURNING id::text`,
    [studentNumber, closure.rows[0].id, appointment.rows[0].id],
  );
  return { appointmentId: appointment.rows[0].id, manualCaseId: manualCase.rows[0].id };
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
          sourceId: null,
        },
        failureReason: "Email service authentication failed.",
        actionable: true,
      }],
    });
    expect(JSON.stringify(actionable)).not.toContain("raw-secret");
    expect(JSON.stringify(actionable)).not.toContain("adm-del-list@example.test");
    expect(JSON.stringify(actionable)).not.toMatch(/[0-9a-f]{64}/i);

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

  it("rejects retry to a former address after verified-email replacement and leaves the old row failed", async () => {
    await verifiedStudent("ADM-DEL-ADDRESS");
    const fingerprint = await currentScheduleFingerprint("ADM-DEL-ADDRESS");
    const id = await failedSchedule("ADM-DEL-ADDRESS", fingerprint);
    await pool.query(
      `UPDATE students
          SET email='new-address@example.test',email_verified_at=clock_timestamp()
        WHERE student_number='ADM-DEL-ADDRESS'`,
    );

    await expect(retryAdminEmailDelivery(id, TEST_REFERENCE_IDS.adminUser)).rejects.toMatchObject({
      code: "STALE_SCHEDULE_EMAIL",
      status: 409,
      details: {
        reason: "VERIFIED_ADDRESS_CHANGED",
        guidance: "Queue the student's current schedule to the verified address instead.",
        currentState: expect.objectContaining({ studentNumber: "ADM-DEL-ADDRESS" }),
      },
    });
    const stored = await pool.query<{ status: string; attempts: number; to_email: string }>(
      "SELECT status,attempts,to_email FROM email_outbox WHERE id=$1",
      [id],
    );
    expect(stored.rows[0]).toEqual({
      status: "PERMANENT_FAILURE",
      attempts: 10,
      to_email: "adm-del-address@example.test",
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

  it("waits for verification consumption and rechecks eligibility before resetting", async () => {
    const studentNumber = "ADM-DEL-VRACE";
    await verifiedStudent(studentNumber);
    const verification = await pool.query<{ id: string }>(
      `INSERT INTO student_email_verifications (
         student_number,pending_email,token_hash,expires_at
       ) VALUES ($1,'vrace@example.test',$2,NOW()+INTERVAL '30 minutes') RETURNING id::text`,
      [studentNumber, "vrace".padEnd(64, "0")],
    );
    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,last_error,message_kind,
         notification_type,source_type,source_id,verification_body_encrypted,last_attempt_status
       ) VALUES (
         $1,'vrace@example.test','Verify your MedClinic notification email',
         'Verification email content is encrypted.','PERMANENT_FAILURE',10,
         'Verification email delivery failed.','VERIFICATION','EMAIL_VERIFICATION',
         'STUDENT_EMAIL_VERIFICATION',$2,'v1.concurrent-envelope','PERMANENT_FAILURE'
       ) RETURNING id::text`,
      [studentNumber, verification.rows[0].id],
    );
    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT student_number FROM students WHERE student_number=$1 FOR UPDATE", [studentNumber]);
      const retry = retryAdminEmailDelivery(outbox.rows[0].id, TEST_REFERENCE_IDS.adminUser).then(
        (value) => ({ outcome: "resolved" as const, value }),
        (error: unknown) => ({ outcome: "rejected" as const, error }),
      );
      await waitForRowLockWaiter("students");
      await blocker.query(
        "UPDATE student_email_verifications SET consumed_at=clock_timestamp() WHERE id=$1",
        [verification.rows[0].id],
      );
      await blocker.query("COMMIT");
      committed = true;

      await expect(retry).resolves.toEqual({
        outcome: "rejected",
        error: expect.objectContaining({ code: "EMAIL_VERIFICATION_RETRY_REJECTED", status: 409 }),
      });
      const stored = await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM email_outbox WHERE id=$1",
        [outbox.rows[0].id],
      );
      expect(stored.rows[0]).toEqual({ status: "PERMANENT_FAILURE", attempts: 10 });
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("waits for a schedule mutation and rechecks the fingerprint before resetting", async () => {
    const studentNumber = "ADM-DEL-SRACE";
    await verifiedStudent(studentNumber);
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start
       ) VALUES ($1,$2,'LABORATORY','2095-03-03','PENDING',TRUE,2095) RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber],
    );
    const fingerprint = await currentScheduleFingerprint(studentNumber);
    const outboxId = await failedSchedule(studentNumber, fingerprint);
    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE appointments SET status='CANCELLED' WHERE id=$1", [appointment.rows[0].id]);
      const retry = retryAdminEmailDelivery(outboxId, TEST_REFERENCE_IDS.adminUser).then(
        (value) => ({ outcome: "resolved" as const, value }),
        (error: unknown) => ({ outcome: "rejected" as const, error }),
      );
      await waitForRowLockWaiter("appointments");
      await blocker.query("COMMIT");
      committed = true;

      await expect(retry).resolves.toEqual({
        outcome: "rejected",
        error: expect.objectContaining({ code: "STALE_SCHEDULE_EMAIL", status: 409 }),
      });
      const stored = await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM email_outbox WHERE id=$1",
        [outboxId],
      );
      expect(stored.rows[0]).toEqual({ status: "PERMANENT_FAILURE", attempts: 10 });
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("waits for a schedule mutation before queueing the authoritative current state", async () => {
    const studentNumber = "ADM-DEL-QRACE";
    await verifiedStudent(studentNumber);
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start
       ) VALUES ($1,$2,'LABORATORY','2095-04-04','PENDING',TRUE,2095) RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber],
    );
    const fingerprint = await currentScheduleFingerprint(studentNumber);
    const outboxId = await failedSchedule(studentNumber, fingerprint);
    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE appointments SET appointment_date='2095-04-05' WHERE id=$1", [appointment.rows[0].id]);
      const queue = queueCurrentAdminEmailDelivery(outboxId, TEST_REFERENCE_IDS.adminUser);
      await waitForRowLockWaiter("appointments");
      await blocker.query("COMMIT");
      committed = true;

      await expect(queue).resolves.toMatchObject({
        queued: true,
        currentState: {
          studentNumber,
          laboratory: { date: "2095-04-05" },
        },
      });
      const stored = await pool.query<{ status: string }>("SELECT status FROM email_outbox WHERE id=$1", [outboxId]);
      expect(stored.rows[0].status).toBe("OBSOLETE");
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("serializes admin retry behind Manual Resolution and revalidates instead of deadlocking", async () => {
    const studentNumber = "ADM-DEL-MRETRY";
    await verifiedStudent(studentNumber);
    const fixture = await openManualResolutionFixture(studentNumber, "2096-05-06");
    const fingerprint = await currentScheduleFingerprint(studentNumber);
    const outboxId = await failedSchedule(studentNumber, fingerprint);
    const manualResolution = await pool.connect();
    let committed = false;
    try {
      await manualResolution.query("BEGIN");
      await manualResolution.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      await manualResolution.query(
        "SELECT id FROM clinic_closure_manual_cases WHERE id=$1 FOR UPDATE",
        [fixture.manualCaseId],
      );
      await manualResolution.query(
        "UPDATE appointments SET status='CANCELLED' WHERE id=$1",
        [fixture.appointmentId],
      );
      const retry = retryAdminEmailDelivery(outboxId, TEST_REFERENCE_IDS.adminUser).then(
        (value) => ({ outcome: "resolved" as const, value }),
        (error: unknown) => ({ outcome: "rejected" as const, error }),
      );
      const waitedForManualResolution = await waitForManualResolutionQueueWaiter();
      await manualResolution.query("COMMIT");
      committed = true;

      expect(waitedForManualResolution).toBe(true);
      await expect(retry).resolves.toEqual({
        outcome: "rejected",
        error: expect.objectContaining({ code: "STALE_SCHEDULE_EMAIL", status: 409 }),
      });
      const stored = await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM email_outbox WHERE id=$1",
        [outboxId],
      );
      expect(stored.rows[0]).toEqual({ status: "PERMANENT_FAILURE", attempts: 10 });
    } finally {
      if (!committed) await manualResolution.query("ROLLBACK");
      manualResolution.release();
    }
  });

  it("serializes queue-current behind Manual Resolution and queues the revalidated state", async () => {
    const studentNumber = "ADM-DEL-MQUEUE";
    await verifiedStudent(studentNumber);
    const fixture = await openManualResolutionFixture(studentNumber, "2096-05-07");
    const fingerprint = await currentScheduleFingerprint(studentNumber);
    const outboxId = await failedSchedule(studentNumber, fingerprint);
    const manualResolution = await pool.connect();
    let committed = false;
    try {
      await manualResolution.query("BEGIN");
      await manualResolution.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      await manualResolution.query(
        "SELECT id FROM clinic_closure_manual_cases WHERE id=$1 FOR UPDATE",
        [fixture.manualCaseId],
      );
      await manualResolution.query(
        "UPDATE appointments SET appointment_date='2096-05-08' WHERE id=$1",
        [fixture.appointmentId],
      );
      const queue = queueCurrentAdminEmailDelivery(outboxId, TEST_REFERENCE_IDS.adminUser);
      const waitedForManualResolution = await waitForManualResolutionQueueWaiter();
      await manualResolution.query("COMMIT");
      committed = true;

      expect(waitedForManualResolution).toBe(true);
      await expect(queue).resolves.toMatchObject({
        queued: true,
        currentState: {
          studentNumber,
          laboratory: { date: "2096-05-08" },
          manualResolutionOpen: true,
        },
      });
    } finally {
      if (!committed) await manualResolution.query("ROLLBACK");
      manualResolution.release();
    }
  });
});
