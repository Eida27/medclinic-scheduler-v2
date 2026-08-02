// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { publishScheduleBatchWithClient } from "@/server/services/appointments.service";
import { ensureStudentAcademicSnapshotsWithClient } from "./student-academic-snapshots.repository";

const actorUserId = TEST_REFERENCE_IDS.adminUser;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    studentNumber: "91-0001-01",
    academicYearStart: 2091,
    studentName: "Snapshot, Student Maria",
    collegeId: "10000000-0000-4000-8000-000000000110",
    collegeName: "College of Computer Studies",
    programId: "20000000-0000-4000-8000-000000000113",
    programCode: "BSIT",
    programName: "Bachelor of Science in Information Technology",
    yearLevel: 3,
    sourceImportGroupId: null,
    sourceType: "VERIFIED_HISTORICAL" as const,
    sourceMetadata: { source: "gateway-test" },
    ...overrides,
  };
}

async function insertLegacyGeneratedPublicationFixture(
  client: import("pg").PoolClient,
  suffix: string,
) {
  const collegeId = `91000000-0000-4000-8000-0000000000${suffix}`;
  const programId = `92000000-0000-4000-8000-0000000000${suffix}`;
  const importGroupId = `93000000-0000-4000-8000-0000000000${suffix}`;
  const batchId = `94000000-0000-4000-8000-0000000000${suffix}`;
  const studentNumber = `91-LEGACY-${suffix}`;
  await client.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2091,'2092-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING`,
    [actorUserId],
  );
  await client.query(
    `INSERT INTO colleges (id,code,name) VALUES ($1,$2,'Original Historical College')`,
    [collegeId, `LGC-${suffix}`],
  );
  await client.query(
    `INSERT INTO programs (id,college_id,code,name)
     VALUES ($1,$2,'OLD','Original Historical Program')`,
    [programId, collegeId],
  );
  await client.query(
    `INSERT INTO students (
       student_number,first_name,middle_name,last_name,college_id,program_id,year_level
     ) VALUES ($1,'Legacy','Maria','Original',$2,$3,2)`,
    [studentNumber, collegeId, programId],
  );
  await client.query(
    `INSERT INTO schedule_import_groups (
       id,import_name,source_filename,total_rows,created_by,
       student_category,academic_year_start,preferred_month,accepted_at
     ) VALUES ($1,$2,$3,1,$4,'REGULAR',2091,NULL,'2020-01-01T00:00:00Z')`,
    [importGroupId, `TEST legacy provenance ${suffix}`, `legacy-${suffix}.csv`, actorUserId],
  );
  await client.query(
    `INSERT INTO schedule_batches (
       id,clinic_id,batch_name,status,created_by,import_group_id
     ) VALUES ($1,$2,$3,'GENERATED',$4,$5)`,
    [
      batchId,
      TEST_REFERENCE_IDS.laboratoryClinic,
      `TEST legacy provenance batch ${suffix}`,
      actorUserId,
      importGroupId,
    ],
  );
  await client.query(
    `INSERT INTO appointments (
       batch_id,clinic_id,student_number,schedule_type,appointment_date,status,
       is_published,schedule_cycle_start,created_by,updated_by
     ) VALUES ($1,$2,$3,'LABORATORY','2091-09-01','DRAFT',FALSE,2091,$4,$4)`,
    [batchId, TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, actorUserId],
  );
  return { batchId, collegeId, importGroupId, programId, studentNumber };
}

async function mutateLegacyAcademicValues(
  client: import("pg").PoolClient,
  fixture: Awaited<ReturnType<typeof insertLegacyGeneratedPublicationFixture>>,
) {
  await client.query(
    `UPDATE students
        SET first_name='Changed',middle_name='After',last_name='Profile',year_level=4
      WHERE student_number=$1`,
    [fixture.studentNumber],
  );
  await client.query(
    "UPDATE colleges SET name='Changed Current College' WHERE id=$1",
    [fixture.collegeId],
  );
  await client.query(
    "UPDATE programs SET code='NEW',name='Changed Current Program' WHERE id=$1",
    [fixture.programId],
  );
}

afterAll(async () => {
  await pool.end();
});

describe("student academic snapshot gateway", () => {
  it("inserts once, accepts identical data, and rejects a conflicting bulk set atomically", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO academic_years (
           start_year,closing_date,created_by,updated_by
         ) VALUES (2091,'2092-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorUserId],
      );

      const inserted = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [candidate()],
      });
      expect(inserted).toEqual({
        outcome: "CREATED_OR_IDENTICAL",
        insertedCount: 1,
        identicalCount: 0,
      });

      const identical = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [candidate({
          sourceImportGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceMetadata: { source: "later-identical-import" },
        })],
      });
      expect(identical).toEqual({
        outcome: "CREATED_OR_IDENTICAL",
        insertedCount: 0,
        identicalCount: 1,
      });

      const conflict = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [
          candidate({ collegeName: "Changed College" }),
          candidate({
            studentNumber: "91-0002-02",
            studentName: "Would Insert, Student",
          }),
        ],
      });
      expect(conflict).toMatchObject({
        outcome: "CONFLICT",
        conflicts: [{
          studentNumber: "91-0001-01",
          academicYearStart: 2091,
          fields: ["collegeName"],
        }],
      });

      const stored = await client.query(
        `SELECT student_number,college_name,source_metadata
           FROM student_academic_snapshots
          WHERE academic_year_start=2091 ORDER BY student_number`,
      );
      expect(stored.rows).toEqual([{
        student_number: "91-0001-01",
        college_name: "College of Computer Studies",
        source_metadata: { source: "gateway-test" },
      }]);
      const audits = await client.query(
        `SELECT action,metadata FROM audit_logs
          WHERE action='SNAPSHOT_CONFLICT_DETECTED'
            AND metadata->>'academicYearStart'='2091'`,
      );
      expect(audits.rows).toEqual([{
        action: "SNAPSHOT_CONFLICT_DETECTED",
        metadata: expect.objectContaining({
          academicYearStart: 2091,
          conflictCount: 1,
        }),
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("marks a pre-deployment grouped publication incomplete when accepted evidence was invalidated", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const fixture = await insertLegacyGeneratedPublicationFixture(client, "11");
      await mutateLegacyAcademicValues(client, fixture);

      await expect(publishScheduleBatchWithClient(
        fixture.batchId,
        actorUserId,
        client,
        true,
      )).resolves.toEqual({ count: 1 });

      const snapshot = await client.query(
        `SELECT student_name,college_name,program_code,program_name,year_level,
                source_import_group_id,source_type,source_metadata
           FROM student_academic_snapshots
          WHERE student_number=$1 AND academic_year_start=2091`,
        [fixture.studentNumber],
      );
      expect(snapshot.rows).toEqual([{
        student_name: "Profile, Changed After",
        college_name: "Changed Current College",
        program_code: "NEW",
        program_name: "Changed Current Program",
        year_level: 4,
        source_import_group_id: fixture.importGroupId,
        source_type: "MIGRATED_INCOMPLETE",
        source_metadata: expect.objectContaining({
          provenance: "CURRENT_PROFILE_AT_LEGACY_PUBLICATION",
          historicalEvidenceComplete: false,
        }),
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps a grouped publication atomic when current legacy values conflict with an immutable snapshot", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const fixture = await insertLegacyGeneratedPublicationFixture(client, "12");
      await client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_id,college_name,
           program_id,program_code,program_name,year_level,source_import_group_id,
           source_type,source_metadata
         ) VALUES ($1,2091,'Original, Legacy Maria',$2,'Original Historical College',
                   $3,'OLD','Original Historical Program',2,$4,
                   'RECOVERED_HISTORICAL','{"fixture":"preexisting"}'::jsonb)`,
        [fixture.studentNumber, fixture.collegeId, fixture.programId, fixture.importGroupId],
      );
      await mutateLegacyAcademicValues(client, fixture);

      const result = await publishScheduleBatchWithClient(
        fixture.batchId,
        actorUserId,
        client,
        true,
      );
      expect(result).toMatchObject({
        snapshotConflict: [{
          studentNumber: fixture.studentNumber,
          academicYearStart: 2091,
          fields: expect.arrayContaining([
            "studentName", "collegeName", "programCode", "programName", "yearLevel",
          ]),
        }],
      });
      const state = await client.query(
        `SELECT batch.status AS batch_status,appointment.status AS appointment_status,
                appointment.is_published,snapshot.student_name,snapshot.source_type,
                (SELECT COUNT(*)::integer FROM audit_logs audit
                  WHERE audit.action='SNAPSHOT_CONFLICT_DETECTED'
                    AND audit.entity_id=$2) AS conflict_audits
           FROM schedule_batches batch
           JOIN appointments appointment ON appointment.batch_id=batch.id
           JOIN student_academic_snapshots snapshot
             ON snapshot.student_number=appointment.student_number
            AND snapshot.academic_year_start=appointment.schedule_cycle_start
          WHERE batch.id=$1`,
        [fixture.batchId, `${fixture.studentNumber}:2091`],
      );
      expect(state.rows).toEqual([{
        batch_status: "GENERATED",
        appointment_status: "DRAFT",
        is_published: false,
        student_name: "Original, Legacy Maria",
        source_type: "RECOVERED_HISTORICAL",
        conflict_audits: 1,
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
