// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  collectCleanupManifest,
  deleteDatabaseManifestWithClient,
} from "../../scripts/browser-clinic-scheduler-ux-fixture";

const ids = {
  import: "d2100000-0000-4000-8000-000000000001",
  unrelatedNotification: "d2100000-0000-4000-8000-000000000010",
  linkedNotification: "d2100000-0000-4000-8000-000000000011",
  createdNotification: "d2100000-0000-4000-8000-000000000012",
  unrelatedVerification: "d2100000-0000-4000-8000-000000000020",
  createdVerification: "d2100000-0000-4000-8000-000000000021",
  unrelatedLogin: "d2100000-0000-4000-8000-000000000030",
  createdLogin: "d2100000-0000-4000-8000-000000000031",
  unrelatedOutbox: "d2100000-0000-4000-8000-000000000040",
  createdOutbox: "d2100000-0000-4000-8000-000000000041",
  unrelatedAudit: "d2100000-0000-4000-8000-000000000050",
  linkedAudit: "d2100000-0000-4000-8000-000000000051",
  createdAudit: "d2100000-0000-4000-8000-000000000052",
} as const;
const preExistingStudent = "T20-PRE-OWN";
const createdStudent = "T20-NEW-OWN";
const sourceFilename = "T20-ownership-fixture.csv";

afterAll(async () => {
  await pool.end();
});

describe("browser clinic scheduler cleanup ownership", () => {
  it("preserves unrelated post-baseline activity for a pre-existing matching student", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO students (
           student_number, first_name, last_name, college_id, program_id, year_level, date_of_birth
         ) VALUES ($1,'Pre','Existing',$3,$4,3,'2004-01-01'),
                  ($2,'Fixture','Created',$3,$4,3,'2004-01-02')`,
        [preExistingStudent, createdStudent, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
      );
      const preExistingRow = (await client.query<{ value: Record<string, unknown> }>(
        "SELECT to_jsonb(student) AS value FROM students student WHERE student_number=$1",
        [preExistingStudent],
      )).rows[0].value;
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      await client.query(
        `INSERT INTO schedule_import_groups
           (id, import_name, source_filename, total_rows, created_by)
         VALUES ($1,'T20 ownership fixture',$2,2,$3)`,
        [ids.import, sourceFilename, TEST_REFERENCE_IDS.adminUser],
      );
      await client.query(
        `INSERT INTO student_portal_notifications
           (id, student_number, notification_type, title, message, metadata)
         VALUES ($1,$4,'UNRELATED','Unrelated','Preserve me','{}'),
                ($2,$4,'SCHEDULE_RESCHEDULED','Linked','Remove me',jsonb_build_object('sourceImportId',$6::text)),
                ($3,$5,'FIXTURE','Created','Remove me','{}')`,
        [
          ids.unrelatedNotification,
          ids.linkedNotification,
          ids.createdNotification,
          preExistingStudent,
          createdStudent,
          ids.import,
        ],
      );
      await client.query(
        `INSERT INTO student_email_verifications
           (id, student_number, pending_email, token_hash, expires_at)
         VALUES ($1,$3,'pre@example.test',$5,NOW()+INTERVAL '30 minutes'),
                ($2,$4,'created@example.test',$6,NOW()+INTERVAL '30 minutes')`,
        [
          ids.unrelatedVerification,
          ids.createdVerification,
          preExistingStudent,
          createdStudent,
          "a".repeat(64),
          "b".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO student_login_attempts (id, student_number, ip_address)
         VALUES ($1,$3,'203.0.113.10'), ($2,$4,'203.0.113.11')`,
        [ids.unrelatedLogin, ids.createdLogin, preExistingStudent, createdStudent],
      );
      await client.query(
        `INSERT INTO email_outbox
           (id, student_number, to_email, subject, text_body)
         VALUES ($1,$3,'pre@example.test','Unrelated','Preserve me'),
                ($2,$4,'created@example.test','Fixture','Remove me')`,
        [ids.unrelatedOutbox, ids.createdOutbox, preExistingStudent, createdStudent],
      );
      await client.query(
        `INSERT INTO audit_logs
           (id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,$6,'STUDENT_UPDATED','student',$4,'{}'),
                ($2,$6,'STUDENT_PROFILE_UPDATED_BY_IMPORT','student',$4,jsonb_build_object('importId',$7::text)),
                ($3,$6,'STUDENT_CREATED','student',$5,'{}')`,
        [
          ids.unrelatedAudit,
          ids.linkedAudit,
          ids.createdAudit,
          preExistingStudent,
          createdStudent,
          TEST_REFERENCE_IDS.adminUser,
          ids.import,
        ],
      );

      const state = {
        version: 1,
        runId: "ownership-test",
        phase: "STAGED",
        startedAt,
        source: { path: "external.csv", sha256: "x", byteLength: 1, bomHex: "efbbbf", acceptedRows: 2 },
        temporaryCsv: {
          path: "temporary.csv",
          filename: sourceFilename,
          sha256: "y",
          byteLength: 1,
          encoding: "windows-1252",
          peñaCount: 1,
        },
        fixtureReason: "T20-ownership-test",
        studentNumbers: [preExistingStudent, createdStudent],
        preExistingStudents: [preExistingRow],
        referencePrograms: { preExisting: [], temporary: [] },
        baseline: {
          capacities: [],
          ids: {
            appointments: [], coordinatorItems: [], laboratoryResults: [], examResults: [],
            submissions: [], notifications: [], verificationTokens: [], loginAttempts: [],
            outbox: [], rescheduleEvents: [], closures: [], audits: [],
          },
        },
      } as never;
      const manifest = await collectCleanupManifest(client, state);

      expect(manifest.notifications).toEqual(expect.arrayContaining([
        ids.linkedNotification,
        ids.createdNotification,
      ]));
      expect(manifest.notifications).not.toContain(ids.unrelatedNotification);
      expect(manifest.verificationTokens).toEqual([ids.createdVerification]);
      expect(manifest.loginAttempts).toEqual([ids.createdLogin]);
      expect(manifest.outbox).toEqual([ids.createdOutbox]);
      expect(manifest.audits).toEqual(expect.arrayContaining([ids.linkedAudit, ids.createdAudit]));
      expect(manifest.audits).not.toContain(ids.unrelatedAudit);

      await deleteDatabaseManifestWithClient(client, state, manifest);
      const sentinels = await client.query<{ table_name: string; id: string }>(
        `SELECT 'notifications' AS table_name, id::text FROM student_portal_notifications WHERE id=$1
         UNION ALL SELECT 'verifications', id::text FROM student_email_verifications WHERE id=$2
         UNION ALL SELECT 'logins', id::text FROM student_login_attempts WHERE id=$3
         UNION ALL SELECT 'outbox', id::text FROM email_outbox WHERE id=$4
         UNION ALL SELECT 'audits', id::text FROM audit_logs WHERE id=$5
         ORDER BY table_name`,
        [
          ids.unrelatedNotification,
          ids.unrelatedVerification,
          ids.unrelatedLogin,
          ids.unrelatedOutbox,
          ids.unrelatedAudit,
        ],
      );
      expect(sentinels.rows).toHaveLength(5);
      const ownedResidue = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM (
           SELECT id FROM student_portal_notifications WHERE id=ANY($1::uuid[])
           UNION ALL SELECT id FROM student_email_verifications WHERE id=$2
           UNION ALL SELECT id FROM student_login_attempts WHERE id=$3
           UNION ALL SELECT id FROM email_outbox WHERE id=$4
           UNION ALL SELECT id FROM audit_logs WHERE id=ANY($5::uuid[])
         ) owned`,
        [
          [ids.linkedNotification, ids.createdNotification],
          ids.createdVerification,
          ids.createdLogin,
          ids.createdOutbox,
          [ids.linkedAudit, ids.createdAudit],
        ],
      );
      expect(ownedResidue.rows[0].count).toBe(0);
      await expect(client.query(
        "SELECT to_jsonb(student) AS value FROM students student WHERE student_number=$1",
        [preExistingStudent],
      )).resolves.toMatchObject({ rows: [{ value: preExistingRow }] });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
