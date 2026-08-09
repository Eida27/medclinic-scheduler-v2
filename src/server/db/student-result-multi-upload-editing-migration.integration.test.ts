// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";

afterAll(async () => {
  await pool.end();
});

async function applyMigration(client: PoolClient) {
  const migrationSql = await readFile(
    join(process.cwd(), "database", "migrations", "017_student_result_multi_upload_editing.sql"),
    "utf8",
  );
  await client.query(migrationSql);
}

async function createPreMigrationSubmissionSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE student_result_submissions (
      id UUID PRIMARY KEY,
      appointment_id UUID NOT NULL,
      student_number VARCHAR(20) NOT NULL,
      result_type VARCHAR(30) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalized_at TIMESTAMPTZ,
      invalidated_at TIMESTAMPTZ,
      invalidated_by UUID,
      invalidation_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT student_result_submissions_status_check
        CHECK (status IN ('DRAFT', 'FINALIZED', 'INVALIDATED')),
      CONSTRAINT student_result_submissions_check CHECK (
        (status = 'DRAFT' AND finalized_at IS NULL AND invalidated_at IS NULL
          AND invalidated_by IS NULL AND invalidation_reason IS NULL)
        OR
        (status = 'FINALIZED' AND finalized_at IS NOT NULL AND invalidated_at IS NULL
          AND invalidated_by IS NULL AND invalidation_reason IS NULL)
        OR
        (status = 'INVALIDATED' AND finalized_at IS NOT NULL AND invalidated_at IS NOT NULL
          AND invalidated_by IS NOT NULL AND NULLIF(BTRIM(invalidation_reason), '') IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX student_result_submissions_one_draft_idx
      ON student_result_submissions (appointment_id) WHERE status = 'DRAFT';
    CREATE UNIQUE INDEX student_result_submissions_one_finalized_idx
      ON student_result_submissions (appointment_id) WHERE status = 'FINALIZED';
    CREATE INDEX student_result_submissions_admin_profile_idx
      ON student_result_submissions (student_number, appointment_id, last_activity_at DESC)
      WHERE status IN ('FINALIZED', 'INVALIDATED');
  `);
}

async function withMigrationSchema(test: (client: PoolClient, schemaName: string) => Promise<void>) {
  const schemaName = `student_result_multi_upload_${randomUUID().replaceAll("-", "_")}`;
  const quotedSchema = `"${schemaName}"`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await createPreMigrationSubmissionSchema(client);
    await applyMigration(client);
    await test(client, schemaName);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    client.release();
  }
}

describe("student result multi-upload editing migration", () => {
  it("supports one active draft, one finalized version, and multiple superseded versions", async () => {
    await withMigrationSchema(async (client, schemaName) => {
      const appointmentId = "10000000-0000-4000-8000-000000000001";
      const finalizedId = "20000000-0000-4000-8000-000000000001";
      const activeDraftId = "30000000-0000-4000-8000-000000000001";
      const discardedDraftId = "40000000-0000-4000-8000-000000000001";
      const firstSupersededId = "50000000-0000-4000-8000-000000000001";
      const secondSupersededId = "60000000-0000-4000-8000-000000000001";

      await client.query(
        `INSERT INTO student_result_submissions (id, appointment_id, student_number, result_type, status, finalized_at)
         VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','FINALIZED',NOW())`,
        [finalizedId, appointmentId],
      );
      await client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, based_on_submission_id
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','DRAFT',$3)`,
        [activeDraftId, appointmentId, finalizedId],
      );
      await client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, based_on_submission_id, discarded_at
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','DRAFT',$3,NOW())`,
        [discardedDraftId, appointmentId, finalizedId],
      );
      await client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, superseded_at,
           superseded_by_submission_id
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',NOW(),NOW(),$3)`,
        [firstSupersededId, appointmentId, finalizedId],
      );
      await client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, superseded_at,
           superseded_by_submission_id
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',NOW(),NOW(),$3)`,
        [secondSupersededId, appointmentId, finalizedId],
      );

      await expect(client.query(
        `INSERT INTO student_result_submissions (id, appointment_id, student_number, result_type, status)
         VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','DRAFT')`,
        ["70000000-0000-4000-8000-000000000001", appointmentId],
      )).rejects.toMatchObject({ code: "23505" });

      const rows = await client.query<{ status: string }>(
        "SELECT status FROM student_result_submissions ORDER BY id",
      );
      expect(rows.rows).toEqual([
        { status: "FINALIZED" },
        { status: "DRAFT" },
        { status: "DRAFT" },
        { status: "SUPERSEDED" },
        { status: "SUPERSEDED" },
      ]);

      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema=$1
            AND table_name='student_result_submissions'
            AND column_name IN (
              'based_on_submission_id', 'discarded_at', 'superseded_at', 'superseded_by_submission_id'
            )
          ORDER BY column_name`,
        [schemaName],
      );
      expect(columns.rows).toEqual([
        { column_name: "based_on_submission_id" },
        { column_name: "discarded_at" },
        { column_name: "superseded_at" },
        { column_name: "superseded_by_submission_id" },
      ]);

      const indexes = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname=$1
            AND indexname IN (
              'student_result_submissions_based_on_idx',
              'student_result_submissions_one_draft_idx',
              'student_result_submissions_superseded_by_idx'
            )
          ORDER BY indexname`,
        [schemaName],
      );
      expect(indexes.rows).toEqual([
        expect.objectContaining({ indexname: "student_result_submissions_based_on_idx" }),
        expect.objectContaining({
          indexname: "student_result_submissions_one_draft_idx",
          indexdef: expect.stringContaining("discarded_at IS NULL"),
        }),
        expect.objectContaining({ indexname: "student_result_submissions_superseded_by_idx" }),
      ]);
    });
  });

  it("rejects invalid lifecycle metadata and self references", async () => {
    await withMigrationSchema(async (client) => {
      const appointmentId = "10000000-0000-4000-8000-000000000002";
      const supersededById = "20000000-0000-4000-8000-000000000002";

      await client.query(
        `INSERT INTO student_result_submissions (id, appointment_id, student_number, result_type, status, finalized_at)
         VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','FINALIZED',NOW())`,
        [supersededById, appointmentId],
      );

      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, superseded_at
         ) VALUES ('30000000-0000-4000-8000-000000000002',$1,'TEST-RESULT-MULTI','LABORATORY','DRAFT',NOW())`,
        [appointmentId],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, based_on_submission_id
         ) VALUES ('35000000-0000-4000-8000-000000000002',$1,'TEST-RESULT-MULTI','LABORATORY','FINALIZED',NOW(),$2)`,
        [appointmentId, supersededById],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, superseded_at, superseded_by_submission_id
         ) VALUES ('40000000-0000-4000-8000-000000000002',$1,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',NOW(),$2)`,
        [appointmentId, supersededById],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, superseded_by_submission_id
         ) VALUES ('50000000-0000-4000-8000-000000000002',$1,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',NOW(),$2)`,
        [appointmentId, supersededById],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, superseded_at,
           superseded_by_submission_id, invalidated_at, invalidated_by, invalidation_reason
         ) VALUES (
           '60000000-0000-4000-8000-000000000002',$1,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',
           NOW(),NOW(),$2,NOW(),'70000000-0000-4000-8000-000000000002','not allowed'
         )`,
        [appointmentId, supersededById],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, based_on_submission_id
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','DRAFT',$1)`,
        ["80000000-0000-4000-8000-000000000002", appointmentId],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_submissions (
           id, appointment_id, student_number, result_type, status, finalized_at, superseded_at,
           superseded_by_submission_id
         ) VALUES ($1,$2,'TEST-RESULT-MULTI','LABORATORY','SUPERSEDED',NOW(),NOW(),$1)`,
        ["90000000-0000-4000-8000-000000000002", appointmentId],
      )).rejects.toMatchObject({ code: "23514" });
    });
  });
});
