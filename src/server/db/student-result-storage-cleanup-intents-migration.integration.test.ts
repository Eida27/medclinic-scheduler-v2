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

async function withMigrationSchema(test: (client: PoolClient, schemaName: string) => Promise<void>) {
  const schemaName = `student_result_cleanup_intents_${randomUUID().replaceAll("-", "_")}`;
  const quotedSchema = `"${schemaName}"`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    const migration = await readFile(
      join(process.cwd(), "database/migrations/018_student_result_storage_cleanup_intents.sql"),
      "utf8",
    );
    await client.query(migration);
    await test(client, schemaName);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    client.release();
  }
}

describe("student result storage cleanup intent migration", () => {
  it("creates a durable keyed ledger with not-before and paired claim leases", async () => {
    await withMigrationSchema(async (client, schemaName) => {
      const columns = await client.query<{
        columnName: string;
        dataType: string;
        isNullable: "YES" | "NO";
      }>(
        `SELECT column_name AS "columnName", data_type AS "dataType",
                is_nullable AS "isNullable"
           FROM information_schema.columns
          WHERE table_schema=$1
            AND table_name='student_result_storage_cleanup_intents'
          ORDER BY ordinal_position`,
        [schemaName],
      );
      expect(columns.rows).toEqual([
        { columnName: "storage_key", dataType: "text", isNullable: "NO" },
        { columnName: "not_before", dataType: "timestamp with time zone", isNullable: "NO" },
        { columnName: "claim_token", dataType: "uuid", isNullable: "YES" },
        { columnName: "claim_expires_at", dataType: "timestamp with time zone", isNullable: "YES" },
        { columnName: "attempt_count", dataType: "integer", isNullable: "NO" },
        { columnName: "delete_error", dataType: "text", isNullable: "YES" },
        { columnName: "created_at", dataType: "timestamp with time zone", isNullable: "NO" },
        { columnName: "updated_at", dataType: "timestamp with time zone", isNullable: "NO" },
      ]);

      const storageKey = "test-draft/test-object.pdf";
      await client.query(
        `INSERT INTO student_result_storage_cleanup_intents (storage_key, not_before)
         VALUES ($1,'2027-08-06T01:00:00Z')`,
        [storageKey],
      );
      await expect(client.query(
        `INSERT INTO student_result_storage_cleanup_intents (storage_key, not_before)
         VALUES ($1,'2027-08-06T02:00:00Z')`,
        [storageKey],
      )).rejects.toMatchObject({ code: "23505" });
      await expect(client.query(
        `INSERT INTO student_result_storage_cleanup_intents (
           storage_key, not_before, claim_token
         ) VALUES ('unpaired-claim','2027-08-06T01:00:00Z',$1)`,
        [randomUUID()],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `INSERT INTO student_result_storage_cleanup_intents (
           storage_key, not_before, attempt_count
         ) VALUES ('negative-attempt','2027-08-06T01:00:00Z',-1)`,
      )).rejects.toMatchObject({ code: "23514" });

      const indexes = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname=$1
            AND tablename='student_result_storage_cleanup_intents'
          ORDER BY indexname`,
        [schemaName],
      );
      expect(indexes.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          indexname: "student_result_storage_cleanup_intents_pkey",
          indexdef: expect.stringContaining("storage_key"),
        }),
        expect.objectContaining({
          indexname: "student_result_storage_cleanup_intents_due_idx",
          indexdef: expect.stringContaining("not_before"),
        }),
      ]));
    });
  });
});
