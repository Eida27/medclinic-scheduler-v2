import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { queueCurrentAdminEmailDelivery, retryAdminEmailDelivery } from "@/server/services/admin-email-deliveries.service";
import { verifyStudentEmail } from "@/server/services/student-email.service";
import {
  STUDENT_EMAIL_NOTIFICATIONS_FIXTURE,
  assertSafeStudentEmailNotificationsAcceptanceDatabase,
  assertZeroStudentEmailNotificationsResidue,
  cleanupStudentEmailNotificationsFixture,
  getStudentEmailNotificationsFixtureStatus,
  normalizeStudentEmailNotificationsDatabaseIdentity,
  prepareStudentEmailNotificationsFixture,
} from "../../scripts/browser-student-email-notifications-fixture";

const EXCLUSIVE_FLAG = "STUDENT_EMAIL_NOTIFICATIONS_ACCEPTANCE_EXCLUSIVE_DATABASE";
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("student email notifications Browser acceptance fixture guards", () => {
  it("rejects remote databases and requires explicit exclusive-database consent", () => {
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.com:5432/student_email_notifications",
      "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email_notifications",
      undefined,
    )).toThrow(new RegExp(`${EXCLUSIVE_FLAG}=1`));
  });

  it("returns a credential-free identity and rejects destination overrides", () => {
    expect(normalizeStudentEmailNotificationsDatabaseIdentity(
      "postgresql://secret-user:secret-password@LOCALHOST:5433/student%5Femail?sslmode=disable",
    )).toEqual({
      scheme: "postgresql",
      host: "localhost",
      port: "5433",
      database: "student_email",
    });
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email?host=remote.example",
      "1",
    )).toThrow(/host or port query parameters/i);
  });

  it("accepts only exhaustive zero cleanup residue", () => {
    const zero = {
      users: 0,
      colleges: 0,
      programs: 0,
      students: 0,
      loginAttempts: 0,
      emailVerifications: 0,
      appointments: 0,
      closureGroups: 0,
      unavailableDates: 0,
      manualCases: 0,
      rescheduleEvents: 0,
      eventUnavailableDates: 0,
      notifications: 0,
      outbox: 0,
      audits: 0,
      triggers: 0,
      triggerFunctions: 0,
      stateFiles: 0,
    };
    expect(assertZeroStudentEmailNotificationsResidue(zero)).toBe(zero);
    expect(() => assertZeroStudentEmailNotificationsResidue({
      ...zero,
      eventUnavailableDates: 1,
    })).toThrow(/cleanup residue/i);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const runLifecycle = process.env[EXCLUSIVE_FLAG] === "1" && Boolean(databaseUrl);

describe.skipIf(!runLifecycle)("student email notifications Browser acceptance fixture lifecycle", () => {
  it("prepares deterministic browser scenarios without exposing the raw token and cleans every owned category", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      const setup = await prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      const firstStatus = await getStudentEmailNotificationsFixtureStatus(pool, identity);
      const state = JSON.parse(await readFile(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile,
        "utf8",
      )) as { rawVerificationToken: string };

      expect(setup).toMatchObject({ mode: "setup", phase: "PREPARED" });
      expect(firstStatus).toMatchObject({
        mode: "status",
        phase: "PREPARED",
        expected: {
          unverifiedStudents: 2,
          confirmationCatchUpNotificationsBeforeConfirmation: 0,
          actionableDeliveryFailures: 2,
          openManualCases: 1,
        },
        residue: {
          users: 2,
          colleges: 1,
          programs: 1,
          students: 6,
          loginAttempts: 0,
          emailVerifications: 1,
          appointments: 9,
          closureGroups: 1,
          unavailableDates: 1,
          manualCases: 1,
          rescheduleEvents: 2,
          eventUnavailableDates: 2,
          notifications: 4,
          outbox: 5,
          audits: 5,
          triggers: 1,
          triggerFunctions: 1,
          stateFiles: 1,
        },
      });
      expect(state.rawVerificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(setup)).not.toContain(state.rawVerificationToken);
      expect(JSON.stringify(firstStatus)).not.toContain(state.rawVerificationToken);

      const databasePlaintext = await pool.query<{ containsToken: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM student_email_verifications
            WHERE student_number=ANY($1::varchar[])
              AND (pending_email LIKE '%' || $2 || '%' OR token_hash LIKE '%' || $2 || '%')
           UNION ALL
           SELECT 1 FROM email_outbox
            WHERE student_number=ANY($1::varchar[])
              AND CONCAT_WS('|',to_email,subject,text_body,COALESCE(html_body,''),
                            COALESCE(last_error,''),COALESCE(verification_body_encrypted,''))
                  LIKE '%' || $2 || '%'
           UNION ALL
           SELECT 1 FROM audit_logs
            WHERE metadata->>'studentNumber'=ANY($1::text[])
              AND (metadata::text LIKE '%' || $2 || '%' OR entity_id LIKE '%' || $2 || '%')
         ) AS "containsToken"`,
        [Object.values(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students).map((student) => student.studentNumber), state.rawVerificationToken],
      );
      expect(databasePlaintext.rows[0].containsToken).toBe(false);

      await expect(verifyStudentEmail(state.rawVerificationToken)).resolves.toMatchObject({
        email: STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.confirmationCatchUp.pendingEmail,
        firstVerification: true,
      });
      expect((await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM student_portal_notifications
          WHERE student_number=$1 AND notification_type='SCHEDULE_CURRENT_STATE'`,
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.confirmationCatchUp.studentNumber],
      )).rows[0].count).toBe(1);

      await expect(retryAdminEmailDelivery(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.deliveryIds.current,
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id,
      )).resolves.toMatchObject({ state: "Pending", actionable: false });
      await expect(retryAdminEmailDelivery(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.deliveryIds.stale,
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id,
      )).rejects.toMatchObject({ code: "STALE_SCHEDULE_EMAIL", status: 409 });
      await expect(queueCurrentAdminEmailDelivery(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.deliveryIds.stale,
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id,
      )).resolves.toMatchObject({ queued: true });

      await prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      const rerunStatus = await getStudentEmailNotificationsFixtureStatus(pool, identity);
      expect(rerunStatus.residue).toEqual(firstStatus.residue);

      const firstCleanup = await cleanupStudentEmailNotificationsFixture(pool, identity);
      expect(assertZeroStudentEmailNotificationsResidue(firstCleanup.residue)).toBe(firstCleanup.residue);
      const secondCleanup = await cleanupStudentEmailNotificationsFixture(pool, identity);
      expect(secondCleanup).toMatchObject({ mode: "cleanup", phase: "ABSENT", residue: firstCleanup.residue });
      const absentStatus = await getStudentEmailNotificationsFixtureStatus(pool, identity);
      expect(absentStatus).toMatchObject({ mode: "status", phase: "ABSENT", residue: firstCleanup.residue });
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      await pool.end();
    }
  }, 30_000);
});
