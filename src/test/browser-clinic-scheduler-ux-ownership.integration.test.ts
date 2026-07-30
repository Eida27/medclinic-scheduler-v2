// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  collectCleanupManifest,
  countCleanupResidue,
  deleteDatabaseManifestWithClient,
  findEmptyFutureWeekday,
  validateLaboratoryStatusAcceptanceFixture,
  validateQuickStatusAcceptanceFixture,
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
  closure: "d2100000-0000-4000-8000-000000000060",
  closureGroup: "d2100000-0000-4000-8000-000000000068",
  blockBatch: "d2100000-0000-4000-8000-000000000061",
  unblockBatch: "d2100000-0000-4000-8000-000000000062",
  blockBatchAudit: "d2100000-0000-4000-8000-000000000063",
  unblockBatchAudit: "d2100000-0000-4000-8000-000000000064",
  unrelatedCalendarAudit: "d2100000-0000-4000-8000-000000000065",
  unrelatedCalendarBatch: "d2100000-0000-4000-8000-000000000066",
  lateCalendarAudit: "d2100000-0000-4000-8000-000000000067",
  laboratoryBatch: "d2100000-0000-4000-8000-000000000070",
  physicalExamBatch: "d2100000-0000-4000-8000-000000000071",
  laboratoryAppointment: "d2100000-0000-4000-8000-000000000072",
  physicalExamAppointment: "d2100000-0000-4000-8000-000000000073",
  laboratoryStatusLog: "d2100000-0000-4000-8000-000000000074",
  schedulePair: "d2100000-0000-4000-8000-000000000075",
} as const;
const preExistingStudent = "T20-PRE-OWN";
const createdStudent = "T20-NEW-OWN";
const sourceFilename = "T20-ownership-fixture.csv";

afterAll(async () => {
  await pool.end();
});

describe("browser quick-status fixture validation", () => {
  const fixture = {
    pending: {
      studentNumber: "pending-student",
      appointmentId: "pending-appointment",
      appointmentDate: "2045-08-18",
    },
    noShow: {
      studentNumber: "no-show-student",
      appointmentId: "no-show-appointment",
      appointmentDate: "2026-07-27",
    },
    protected: {
      studentNumber: "protected-student",
      appointmentId: "protected-appointment",
      appointmentDate: "2045-08-19",
    },
  };

  it("accepts three disjoint quick-status appointments", () => {
    expect(validateQuickStatusAcceptanceFixture(fixture)).toBe(fixture);
  });

  it("rejects reused appointments across quick-status states", () => {
    expect(() => validateQuickStatusAcceptanceFixture({
      ...fixture,
      protected: { ...fixture.protected, appointmentId: fixture.pending.appointmentId },
    })).toThrow("Quick-status acceptance appointments must be disjoint.");
  });
});

describe("browser Physical Exam Laboratory-status fixture validation", () => {
  it("rejects a staged unavailable row that reuses a quick-status or calendar role", () => {
    const unavailable = {
      studentNumber: "unavailable-student",
      laboratoryAppointmentId: "unavailable-laboratory",
      physicalAppointmentId: "unavailable-physical",
    };
    const laboratoryStatus = { unavailable };
    const ownership = {
      studentNumbers: ["quick-status-student", "calendar-student"],
      appointmentIds: ["quick-status-appointment", "calendar-replacement"],
    };

    expect(validateLaboratoryStatusAcceptanceFixture(laboratoryStatus, ownership)).toBe(laboratoryStatus);
    expect(() => validateLaboratoryStatusAcceptanceFixture({
      unavailable: { ...unavailable, studentNumber: ownership.studentNumbers[1] },
    }, ownership)).toThrow(/student role.*disjoint/i);
    expect(() => validateLaboratoryStatusAcceptanceFixture({
      unavailable: { ...unavailable, physicalAppointmentId: ownership.appointmentIds[1] },
    }, ownership)).toThrow(/appointment.*disjoint/i);
  });
});

describe("browser clinic scheduler date selection", () => {
  it("skips active unified clinic closure dates", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const group = await client.query<{ id: string }>(
        `INSERT INTO clinic_closure_groups (
           start_date,end_date,category,reason,created_by,creation_batch_id
         ) VALUES ('2047-03-04','2047-03-04','MAINTENANCE',$1,$2,$3)
         RETURNING id::text`,
        ["T20-date-selection", TEST_REFERENCE_IDS.adminUser, ids.blockBatch],
      );
      await client.query(
        `INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
         VALUES ($1,'2047-03-04')`,
        [group.rows[0].id],
      );

      await expect(findEmptyFutureWeekday(
        client,
        TEST_REFERENCE_IDS.laboratoryClinic,
        "2047-03-04",
        "2047-03-05",
      )).resolves.toBe("2047-03-05");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
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
        `INSERT INTO schedule_batches
           (id, clinic_id, batch_name, status, created_by, import_group_id)
         VALUES ($1,$3,'T20 owned Laboratory batch','PUBLISHED',$5,$2),
                ($4,$6,'T20 owned Physical Exam batch','PUBLISHED',$5,$2)`,
        [
          ids.laboratoryBatch,
          ids.import,
          TEST_REFERENCE_IDS.laboratoryClinic,
          ids.physicalExamBatch,
          TEST_REFERENCE_IDS.adminUser,
          TEST_REFERENCE_IDS.physicalExamClinic,
        ],
      );
      await client.query(
        `INSERT INTO appointments (
           id,batch_id,clinic_id,student_number,schedule_type,appointment_date,
           status,is_published,schedule_pair_id,schedule_cycle_start,created_by,updated_by
         ) VALUES ($1,$2,$3,$7,'LABORATORY','2047-08-01','CANCELLED',TRUE,$8,2047,$9,$9),
                  ($4,$5,$6,$7,'PHYSICAL_EXAM','2047-08-02','PENDING',TRUE,$8,2047,$9,$9)`,
        [
          ids.laboratoryAppointment,
          ids.laboratoryBatch,
          TEST_REFERENCE_IDS.laboratoryClinic,
          ids.physicalExamAppointment,
          ids.physicalExamBatch,
          TEST_REFERENCE_IDS.physicalExamClinic,
          createdStudent,
          ids.schedulePair,
          TEST_REFERENCE_IDS.adminUser,
        ],
      );
      await client.query(
        `INSERT INTO appointment_status_logs
           (id, appointment_id, old_status, new_status, notes, changed_by)
         VALUES ($1,$2,'PENDING','CANCELLED','T20 deterministic Not available state',$3)`,
        [ids.laboratoryStatusLog, ids.laboratoryAppointment, TEST_REFERENCE_IDS.adminUser],
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
      await client.query(
        `INSERT INTO clinic_closure_groups (
           id,start_date,end_date,category,reason,created_by,creation_batch_id
         ) VALUES ($1,'2027-02-01','2027-02-01','MAINTENANCE',$2,$3,$4)`,
        [
          ids.closureGroup,
          "T20-ownership-test calendar",
          TEST_REFERENCE_IDS.adminUser,
          ids.blockBatch,
        ],
      );
      await client.query(
        `INSERT INTO clinic_unavailable_dates (
           id,closure_group_id,blocked_date,reopened_at,reopened_by,reopening_batch_id
         ) VALUES ($1,$2,'2027-02-01',NOW(),$3,$4)`,
        [
          ids.closure,
          ids.closureGroup,
          TEST_REFERENCE_IDS.adminUser,
          ids.unblockBatch,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs
           (id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,$6,'CLINIC_CALENDAR_BATCH_UPDATED','clinic_calendar_batch',$4,'{}'),
                ($2,$6,'CLINIC_CALENDAR_BATCH_UPDATED','clinic_calendar_batch','metadata-only',jsonb_build_object('batchId',$5::text)),
                ($3,$6,'CLINIC_CALENDAR_BATCH_UPDATED','clinic_calendar_batch',$7,'{}')`,
        [
          ids.blockBatchAudit,
          ids.unblockBatchAudit,
          ids.unrelatedCalendarAudit,
          ids.blockBatch,
          ids.unblockBatch,
          TEST_REFERENCE_IDS.adminUser,
          ids.unrelatedCalendarBatch,
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

      expect(manifest.appointments).toEqual(expect.arrayContaining([
        ids.laboratoryAppointment,
        ids.physicalExamAppointment,
      ]));
      expect(manifest.statusLogs).toContain(ids.laboratoryStatusLog);
      expect(manifest.notifications).toEqual(expect.arrayContaining([
        ids.linkedNotification,
        ids.createdNotification,
      ]));
      expect(manifest.notifications).not.toContain(ids.unrelatedNotification);
      expect(manifest.verificationTokens).toEqual([ids.createdVerification]);
      expect(manifest.loginAttempts).toEqual([ids.createdLogin]);
      expect(manifest.outbox).toEqual([ids.createdOutbox]);
      expect(manifest.audits).toEqual(expect.arrayContaining([ids.linkedAudit, ids.createdAudit]));
      expect(manifest.calendarBatchIds).toEqual(expect.arrayContaining([
        ids.blockBatch,
        ids.unblockBatch,
      ]));
      expect(manifest.audits).toEqual(expect.arrayContaining([
        ids.blockBatchAudit,
        ids.unblockBatchAudit,
      ]));
      expect(manifest.audits).not.toContain(ids.unrelatedAudit);
      expect(manifest.audits).not.toContain(ids.unrelatedCalendarAudit);

      await client.query(
        `INSERT INTO audit_logs
           (id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,$2,'CLINIC_CALENDAR_BATCH_UPDATED','clinic_calendar_batch','late-audit',
                 jsonb_build_object('batchId',$3::text))`,
        [ids.lateCalendarAudit, TEST_REFERENCE_IDS.adminUser, ids.unblockBatch],
      );
      const residueBeforeDelete = await countCleanupResidue(client, manifest, []);
      expect(residueBeforeDelete.audits).toBe(manifest.audits.length + 1);

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
      await expect(client.query(
        "SELECT id::text FROM audit_logs WHERE id=$1",
        [ids.unrelatedCalendarAudit],
      )).resolves.toMatchObject({ rows: [{ id: ids.unrelatedCalendarAudit }] });
      const cleanupResidue = await countCleanupResidue(client, manifest, []);
      expect(cleanupResidue.audits).toBe(0);
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
