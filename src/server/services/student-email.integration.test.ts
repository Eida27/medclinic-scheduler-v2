// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent } from "@/test/integration-fixtures";
import {
  createStudentNotification,
  listStudentNotifications,
  markStudentNotificationRead,
} from "./student-notifications.service";
import { requestStudentEmailVerification, verifyStudentEmail } from "./student-email.service";

const studentPattern = "99-95%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-STUDENT-EMAIL%", "TEST-STUDENT-EMAIL%");
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("student notifications and optional email", () => {
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
    await expect(pool.query(
      "SELECT email FROM students WHERE student_number='99-9503-03'",
    )).resolves.toMatchObject({ rows: [{ email: "old@example.test" }] });

    await verifyStudentEmail("99-9503-03", request.token);
    const verified = await pool.query(
      `SELECT email, email_verified_at IS NOT NULL AS verified
         FROM students WHERE student_number='99-9503-03'`,
    );
    expect(verified.rows).toEqual([{ email: "new@example.test", verified: true }]);
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
    await expect(markStudentNotificationRead("99-9599-99", notificationId)).resolves.toBe(false);
    await expect(markStudentNotificationRead("99-9504-04", notificationId)).resolves.toBe(true);
    expect((await listStudentNotifications("99-9504-04")).unreadCount).toBe(0);
  });
});
