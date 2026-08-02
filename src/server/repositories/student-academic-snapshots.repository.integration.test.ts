// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
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
});
