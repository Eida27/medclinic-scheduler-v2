import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
const EXPANDED_APPOINTMENT_STATUS_LOG_ID = "ee230000-0000-4000-8000-000000000901";
const EXPANDED_SUBMISSION_ID = "ee230000-0000-4000-8000-000000000902";
const EXPANDED_FILE_ID = "ee230000-0000-4000-8000-000000000903";
const EXPANDED_EXAM_RESULT_ID = "ee230000-0000-4000-8000-000000000904";
const EXPANDED_LAB_RESULT_ID = "ee230000-0000-4000-8000-000000000905";
const EXPANDED_STORAGE_KEY = `${EXPANDED_SUBMISSION_ID}/browser-expanded-result.pdf`;
const EXPANDED_STORAGE_PATH = resolve(
  process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads",
  EXPANDED_STORAGE_KEY,
);

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
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email?options=-c%20search_path%3Dprivate",
      "1",
    )).toThrow(/namespace-changing|options/i);
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
      appointmentStatusLogs: 0,
      resultSubmissions: 0,
      resultFiles: 0,
      laboratoryResults: 0,
      examResults: 0,
      storageCleanupIntents: 0,
      storageObjects: 0,
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
  it("refuses and preserves an untracked exact reserved-identifier collision", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await pool.query(
        `INSERT INTO users (id,full_name,email,password_hash,role)
         VALUES ($1,'Unrelated exact-ID sentinel','unrelated.fixture.sentinel@example.test','not-used','ADMIN')`,
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id],
      );
      await expect(prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
      })).rejects.toThrow(/untracked/i);
      expect((await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE id=$1 AND full_name='Unrelated exact-ID sentinel'",
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id],
      )).rows[0].count).toBe(1);
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id]);
      await pool.end();
    }
  });

  it("refuses status and cleanup when the connected namespace differs from persisted effective identity", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    const mismatchedPool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=pg_catalog",
    });
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await prepareStudentEmailNotificationsFixture(pool, identity, { encryptionKey: TEST_ENCRYPTION_KEY });
      await expect(getStudentEmailNotificationsFixtureStatus(mismatchedPool, identity))
        .rejects.toThrow(/effective database identity|search_path|namespace/i);
      await expect(prepareStudentEmailNotificationsFixture(mismatchedPool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
      })).rejects.toThrow(/effective database identity|search_path|namespace/i);
      await expect(cleanupStudentEmailNotificationsFixture(mismatchedPool, identity))
        .rejects.toThrow(/effective database identity|search_path|namespace/i);
      expect((await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1",
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.onboarding.studentNumber],
      )).rows[0].count).toBe(1);
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await mismatchedPool.end();
      await pool.end();
    }
  });

  it("retains recoverable ownership when setup and its recovery cleanup both fail", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await expect(prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
        afterSeed: async () => { throw new Error("simulated post-seed setup failure"); },
        beforeRemoveOwnedRows: async () => { throw new Error("simulated recovery cleanup failure"); },
      })).rejects.toThrow(/recovery cleanup failure|recovery state retained/i);
      const retained = JSON.parse(await readFile(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile,
        "utf8",
      )) as { phase: string; rawVerificationToken: string };
      expect(retained).toMatchObject({ phase: "PREPARING" });
      expect(retained.rawVerificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1",
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.onboarding.studentNumber],
      )).rows[0].count).toBe(1);
      await expect(cleanupStudentEmailNotificationsFixture(pool, identity)).resolves.toMatchObject({
        phase: "ABSENT",
        residue: { stateFiles: 0 },
      });
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      await pool.end();
    }
  });

  it("keeps the previous valid recovery state when atomic prepared-state replacement fails", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    let renameCalls = 0;
    let observedRecoveryPhase: string | null = null;
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await expect(prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
        renameStateFile: async (source, destination) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error("simulated atomic state rename failure");
          await rename(source, destination);
        },
        beforeRemoveOwnedRows: async () => {
          observedRecoveryPhase = (JSON.parse(await readFile(
            STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile,
            "utf8",
          )) as { phase: string }).phase;
        },
      })).rejects.toThrow("simulated atomic state rename failure");
      expect(observedRecoveryPhase).toBe("PREPARING");
      await expect(readFile(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      await pool.end();
    }
  });

  it("retains recovery state across an injected cleanup failure and succeeds on retry", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await prepareStudentEmailNotificationsFixture(pool, identity, { encryptionKey: TEST_ENCRYPTION_KEY });
      await expect(cleanupStudentEmailNotificationsFixture(pool, identity, {
        beforeRemoveOwnedRows: async () => { throw new Error("simulated cleanup failure"); },
      })).rejects.toThrow("simulated cleanup failure");
      expect(JSON.parse(await readFile(
        STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile,
        "utf8",
      ))).toMatchObject({ phase: "PREPARED" });
      expect((await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1",
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.onboarding.studentNumber],
      )).rows[0].count).toBe(1);
      await expect(cleanupStudentEmailNotificationsFixture(pool, identity)).resolves.toMatchObject({
        residue: { students: 0, stateFiles: 0 },
      });
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      await pool.end();
    }
  });

  it("refuses malformed recovery state without deleting exact owned rows", async () => {
    const identity = assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl, "1");
    const pool = new Pool({ connectionString: databaseUrl });
    let validState: string | null = null;
    try {
      await cleanupStudentEmailNotificationsFixture(pool, identity);
      await prepareStudentEmailNotificationsFixture(pool, identity, { encryptionKey: TEST_ENCRYPTION_KEY });
      validState = await readFile(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile, "utf8");
      await writeFile(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile, "{\"phase\":", "utf8");
      await expect(cleanupStudentEmailNotificationsFixture(pool, identity)).rejects.toThrow(/invalid|malformed|truncated/i);
      expect((await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1",
        [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.onboarding.studentNumber],
      )).rows[0].count).toBe(1);
      await writeFile(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile, validState, "utf8");
      await cleanupStudentEmailNotificationsFixture(pool, identity);
    } finally {
      if (validState) {
        await writeFile(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.stateFile, validState, "utf8")
          .catch(() => undefined);
        await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      }
      await pool.end();
    }
  });

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
          appointmentStatusLogs: 0,
          resultSubmissions: 0,
          resultFiles: 0,
          laboratoryResults: 0,
          examResults: 0,
          storageCleanupIntents: 0,
          storageObjects: 0,
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

      await pool.query(
        `INSERT INTO appointment_status_logs (id,appointment_id,old_status,new_status,changed_by)
         VALUES ($1,$2,'DRAFT','PENDING',$3)`,
        [
          EXPANDED_APPOINTMENT_STATUS_LOG_ID,
          "ee230000-0000-4000-8000-000000000401",
          STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id,
        ],
      );
      await pool.query(
        `INSERT INTO student_result_submissions (
           id,appointment_id,student_number,result_type,status,last_activity_at
         ) VALUES ($1,$2,$3,'LABORATORY','DRAFT',clock_timestamp())`,
        [
          EXPANDED_SUBMISSION_ID,
          "ee230000-0000-4000-8000-000000000101",
          STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.confirmationCatchUp.studentNumber,
        ],
      );
      await pool.query(
        `INSERT INTO student_result_files (
           id,submission_id,storage_key,original_filename,detected_mime_type,
           extension,byte_size,checksum_sha256
         ) VALUES ($1,$2,$3,'browser-expanded-result.pdf','application/pdf','pdf',4,$4)`,
        [EXPANDED_FILE_ID, EXPANDED_SUBMISSION_ID, EXPANDED_STORAGE_KEY, "0".repeat(64)],
      );
      await pool.query(
        "INSERT INTO student_result_storage_cleanup_intents (storage_key,not_before) VALUES ($1,clock_timestamp())",
        [EXPANDED_STORAGE_KEY],
      );
      await pool.query(
        `INSERT INTO exam_results (id,student_number,appointment_id,result_status)
         VALUES ($1,$2,$3,'PENDING_UPLOAD')`,
        [
          EXPANDED_EXAM_RESULT_ID,
          STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.confirmationCatchUp.studentNumber,
          "ee230000-0000-4000-8000-000000000102",
        ],
      );
      await pool.query(
        `INSERT INTO laboratory_results (id,student_number,appointment_id,result_status)
         VALUES ($1,$2,$3,'PENDING_UPLOAD')`,
        [
          EXPANDED_LAB_RESULT_ID,
          STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.deliveryCurrent.studentNumber,
          "ee230000-0000-4000-8000-000000000401",
        ],
      );
      await mkdir(dirname(EXPANDED_STORAGE_PATH), { recursive: true });
      await writeFile(EXPANDED_STORAGE_PATH, "%PDF", "utf8");
      expect((await getStudentEmailNotificationsFixtureStatus(pool, identity)).residue).toMatchObject({
        appointmentStatusLogs: 1,
        resultSubmissions: 1,
        resultFiles: 1,
        laboratoryResults: 1,
        examResults: 1,
        storageCleanupIntents: 1,
        storageObjects: 1,
      });

      await prepareStudentEmailNotificationsFixture(pool, identity, {
        encryptionKey: TEST_ENCRYPTION_KEY,
      });
      const rerunStatus = await getStudentEmailNotificationsFixtureStatus(pool, identity);
      expect(rerunStatus.residue).toEqual(firstStatus.residue);
      await expect(readFile(EXPANDED_STORAGE_PATH)).rejects.toMatchObject({ code: "ENOENT" });

      const firstCleanup = await cleanupStudentEmailNotificationsFixture(pool, identity);
      expect(assertZeroStudentEmailNotificationsResidue(firstCleanup.residue)).toBe(firstCleanup.residue);
      const secondCleanup = await cleanupStudentEmailNotificationsFixture(pool, identity);
      expect(secondCleanup).toMatchObject({ mode: "cleanup", phase: "ABSENT", residue: firstCleanup.residue });
      const absentStatus = await getStudentEmailNotificationsFixtureStatus(pool, identity);
      expect(absentStatus).toMatchObject({ mode: "status", phase: "ABSENT", residue: firstCleanup.residue });
    } finally {
      await cleanupStudentEmailNotificationsFixture(pool, identity).catch(() => undefined);
      await rm(EXPANDED_STORAGE_PATH, { force: true });
      await pool.end();
    }
  }, 30_000);
});
