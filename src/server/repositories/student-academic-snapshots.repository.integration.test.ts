// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  ensureStudentAcademicSnapshotsWithClient,
  writeStudentAcademicSnapshotConflictAuditWithClient,
} from "./student-academic-snapshots.repository";

const actorUserId = TEST_REFERENCE_IDS.adminUser;

function candidate(sourceImportGroupId: string, overrides: Record<string, unknown> = {}) {
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
    sourceImportGroupId,
    ...overrides,
  };
}

async function createImportGroup(client: PoolClient, academicYearStart = 2091) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO schedule_import_groups (
       id,import_name,source_filename,total_rows,created_by,student_category,
       academic_year_start,accepted_at
     ) VALUES ($1,$2,$3,1,$4,'REGULAR',$5,clock_timestamp())`,
    [id, `Snapshot gateway ${id}`, `${id}.csv`, actorUserId, academicYearStart],
  );
  return id;
}

afterAll(async () => {
  await pool.end();
});

describe("student academic snapshot gateway", () => {
  it("formats multi-year conflict audit metadata once with years in ascending order", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await writeStudentAcademicSnapshotConflictAuditWithClient(client, {
        actorUserId,
        conflicts: [
          { studentNumber: "91-0002-02", academicYearStart: 2091, fields: ["programName"] },
          { studentNumber: "90-0001-01", academicYearStart: 2090, fields: ["collegeName"] },
        ],
      });

      const audits = await client.query(
        `SELECT action,entity_type,entity_id,metadata
           FROM audit_logs
          WHERE action='SNAPSHOT_CONFLICT_DETECTED'
            AND metadata->'conflicts' @> $1::jsonb`,
        [JSON.stringify([{ studentNumber: "91-0002-02" }])],
      );
      expect(audits.rows).toEqual([{
        action: "SNAPSHOT_CONFLICT_DETECTED",
        entity_type: "student_academic_snapshot",
        entity_id: null,
        metadata: {
          academicYearStart: null,
          academicYearStarts: [2090, 2091],
          conflictCount: 2,
          conflicts: [
            { studentNumber: "91-0002-02", academicYearStart: 2091, fields: ["programName"] },
            { studentNumber: "90-0001-01", academicYearStart: 2090, fields: ["collegeName"] },
          ],
        },
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("writes exactly one single-conflict audit for duplicate input", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2091,'2092-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorUserId],
      );
      const importId = await createImportGroup(client);
      const result = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [
          candidate(importId),
          candidate(importId, { collegeName: "Conflicting Duplicate College" }),
        ],
      });
      expect(result).toMatchObject({ outcome: "CONFLICT" });

      const audits = await client.query(
        `SELECT entity_id,metadata FROM audit_logs
          WHERE action='SNAPSHOT_CONFLICT_DETECTED'
            AND entity_id='91-0001-01:2091'`,
      );
      expect(audits.rows).toEqual([{
        entity_id: "91-0001-01:2091",
        metadata: {
          academicYearStart: 2091,
          academicYearStarts: [2091],
          conflictCount: 1,
          conflicts: [{
            studentNumber: "91-0001-01",
            academicYearStart: 2091,
            fields: ["collegeName"],
          }],
        },
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("writes exactly one audit for conflicts returned by the SQL gateway", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2090,'2091-07-31',$1,$1),(2091,'2092-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorUserId],
      );
      const import2090 = await createImportGroup(client, 2090);
      const import2091 = await createImportGroup(client, 2091);
      await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [
          candidate(import2090, { studentNumber: "90-0001-01", academicYearStart: 2090 }),
          candidate(import2091),
        ],
      });

      const result = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [
          candidate(import2091, { collegeName: "Changed 2091 College" }),
          candidate(import2090, {
            studentNumber: "90-0001-01",
            academicYearStart: 2090,
            programName: "Changed 2090 Program",
          }),
        ],
      });
      expect(result).toMatchObject({ outcome: "CONFLICT" });

      const audits = await client.query(
        `SELECT entity_id,metadata FROM audit_logs
          WHERE action='SNAPSHOT_CONFLICT_DETECTED'
            AND metadata->>'conflictCount'='2'`,
      );
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0]).toMatchObject({
        entity_id: null,
        metadata: {
          academicYearStart: null,
          academicYearStarts: [2090, 2091],
          conflictCount: 2,
        },
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("creates an immutable snapshot, preserves first-import provenance, and reports historical conflicts", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2091,'2092-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorUserId],
      );
      const firstImportId = await createImportGroup(client);
      const laterImportId = await createImportGroup(client);

      const inserted = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [candidate(firstImportId)],
      });
      expect(inserted).toEqual({
        outcome: "CREATED_OR_IDENTICAL",
        insertedCount: 1,
        identicalCount: 0,
      });

      const identical = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [candidate(laterImportId)],
      });
      expect(identical).toEqual({
        outcome: "CREATED_OR_IDENTICAL",
        insertedCount: 0,
        identicalCount: 1,
      });

      const stored = await client.query(
        `SELECT student_number,college_name,source_import_group_id::text
           FROM student_academic_snapshots
          WHERE academic_year_start=2091`,
      );
      expect(stored.rows).toEqual([{
        student_number: "91-0001-01",
        college_name: "College of Computer Studies",
        source_import_group_id: firstImportId,
      }]);

      await client.query("SAVEPOINT immutable_update");
      await expect(client.query(
        `UPDATE student_academic_snapshots
            SET college_name='Changed College'
          WHERE student_number='91-0001-01' AND academic_year_start=2091`,
      )).rejects.toThrow(/immutable/i);
      await client.query("ROLLBACK TO SAVEPOINT immutable_update");
      await client.query("SAVEPOINT immutable_delete");
      await expect(client.query(
        `DELETE FROM student_academic_snapshots
          WHERE student_number='91-0001-01' AND academic_year_start=2091`,
      )).rejects.toThrow(/immutable/i);
      await client.query("ROLLBACK TO SAVEPOINT immutable_delete");

      const conflict = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [
          candidate(laterImportId, { collegeName: "Changed College" }),
          candidate(laterImportId, {
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
      const mixedSetResidue = await client.query(
        `SELECT student_number FROM student_academic_snapshots
          WHERE student_number='91-0002-02' AND academic_year_start=2091`,
      );
      expect(mixedSetResidue.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("stores no legacy source columns", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND table_name='student_academic_snapshots'
          AND column_name IN ('source_type','source_metadata')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("rejects snapshot provenance from an import group in another academic year", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2090,'2091-07-31',$1,$1),(2091,'2092-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorUserId],
      );
      const wrongYearImportId = await createImportGroup(client, 2090);
      await client.query("SAVEPOINT wrong_year_provenance");
      await expect(ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: [candidate(wrongYearImportId)],
      })).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT wrong_year_provenance");
      const residue = await client.query(
        `SELECT student_number FROM student_academic_snapshots
          WHERE student_number='91-0001-01' AND academic_year_start=2091`,
      );
      expect(residue.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
