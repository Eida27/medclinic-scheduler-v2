// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/016_reports_historical_compliance.sql",
);

async function inIsolatedSchema(
  callback: (client: PoolClient) => Promise<void>,
) {
  const client = await pool.connect();
  const schema = `reports_snapshot_schema_${randomUUID().replaceAll("-", "_")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await callback(client);
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

async function createPrerequisiteSchema(client: PoolClient) {
  await client.query(`
    CREATE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at=NOW(); RETURN NEW; END $$;
    CREATE TABLE users (id UUID PRIMARY KEY, role VARCHAR(30));
    CREATE TABLE colleges (
      id UUID PRIMARY KEY, name VARCHAR(150) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE programs (
      id UUID PRIMARY KEY, college_id UUID NOT NULL REFERENCES colleges(id),
      code VARCHAR(30) NOT NULL, name VARCHAR(150) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE students (
      student_number VARCHAR(20) PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL DEFAULT '', middle_name VARCHAR(100),
      last_name VARCHAR(100) NOT NULL DEFAULT '', suffix VARCHAR(20),
      college_id UUID REFERENCES colleges(id), program_id UUID REFERENCES programs(id),
      year_level INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE schedule_import_groups (
      id UUID PRIMARY KEY, academic_year_start INTEGER,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID REFERENCES users(id)
    );
    CREATE TABLE schedule_batches (
      id UUID PRIMARY KEY, status VARCHAR(30) NOT NULL,
      import_group_id UUID REFERENCES schedule_import_groups(id),
      published_at TIMESTAMPTZ, published_by UUID REFERENCES users(id),
      created_by UUID REFERENCES users(id), college_id UUID REFERENCES colleges(id),
      program_id UUID REFERENCES programs(id)
    );
    CREATE TABLE coordinator_schedule_items (
      id UUID PRIMARY KEY, batch_id UUID REFERENCES schedule_batches(id),
      student_number VARCHAR(20) REFERENCES students(student_number), schedule_cycle_start INTEGER
    );
    CREATE TABLE appointments (
      id UUID PRIMARY KEY, batch_id UUID REFERENCES schedule_batches(id),
      schedule_item_id UUID REFERENCES coordinator_schedule_items(id),
      student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
      schedule_type VARCHAR(30) NOT NULL,
      schedule_cycle_start INTEGER NOT NULL,
      appointment_date DATE NOT NULL,
      is_published BOOLEAN NOT NULL, created_by UUID REFERENCES users(id)
    );
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID REFERENCES users(id),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(100),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function createAcademicYearAndImportGroup(client: PoolClient) {
  const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const importGroupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await client.query("INSERT INTO users (id,role) VALUES ($1,'ADMIN')", [actorId]);
  await client.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2097,'2098-07-31',$1,$1)`,
    [actorId],
  );
  await client.query("INSERT INTO schedule_import_groups (id) VALUES ($1)", [importGroupId]);
  return { actorId, importGroupId };
}

function snapshotInsert(importGroupId: string) {
  return `INSERT INTO student_academic_snapshots (
    student_number,academic_year_start,student_name,college_name,program_name,
    source_import_group_id
  ) VALUES ('97-0001-01',2097,'Snapshot, Student','Snapshot College',
    'Snapshot Program','${importGroupId}')`;
}

afterAll(async () => {
  await pool.end();
});

describe("reports academic snapshot schema migration", () => {
  it("creates import-backed immutable snapshots without legacy provenance columns", async () => {
    await inIsolatedSchema(async (client) => {
      await createPrerequisiteSchema(client);
      await client.query(await readFile(migrationPath, "utf8"));

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema()
            AND table_name IN ('academic_years','student_academic_snapshots')
          ORDER BY table_name`,
      );
      expect(tables.rows).toEqual([
        { table_name: "academic_years" },
        { table_name: "student_academic_snapshots" },
      ]);

      const legacyColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema=current_schema()
            AND table_name='student_academic_snapshots'
            AND column_name IN ('source_type','source_metadata')`,
      );
      expect(legacyColumns.rows).toEqual([]);

      const provenance = await client.query<{
        is_nullable: string;
        foreign_table_name: string;
        delete_rule: string;
      }>(
        `SELECT column_row.is_nullable,
                foreign_table.relname AS foreign_table_name,
                CASE constraint_row.confdeltype WHEN 'r' THEN 'RESTRICT' END AS delete_rule
           FROM information_schema.columns column_row
           JOIN pg_attribute attribute_row
             ON attribute_row.attrelid='student_academic_snapshots'::regclass
            AND attribute_row.attname=column_row.column_name
           JOIN pg_constraint constraint_row
             ON constraint_row.conrelid='student_academic_snapshots'::regclass
            AND constraint_row.contype='f'
            AND attribute_row.attnum=ANY(constraint_row.conkey)
           JOIN pg_class foreign_table ON foreign_table.oid=constraint_row.confrelid
          WHERE column_row.table_schema=current_schema()
            AND column_row.table_name='student_academic_snapshots'
            AND column_row.column_name='source_import_group_id'`,
      );
      expect(provenance.rows).toEqual([{
        is_nullable: "NO",
        foreign_table_name: "schedule_import_groups",
        delete_rule: "RESTRICT",
      }]);

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname=current_schema()
            AND indexname='student_academic_snapshots_source_import_group_idx'`,
      );
      expect(indexes.rows).toEqual([
        { indexname: "student_academic_snapshots_source_import_group_idx" },
      ]);

      const { actorId, importGroupId } = await createAcademicYearAndImportGroup(client);
      await client.query(snapshotInsert(importGroupId));
      await expect(client.query(snapshotInsert(importGroupId))).rejects.toMatchObject({ code: "23505" });
      await expect(client.query(
        "UPDATE student_academic_snapshots SET college_name='Changed'",
      )).rejects.toThrow(/immutable/i);
      await expect(client.query("DELETE FROM student_academic_snapshots")).rejects.toThrow(/immutable/i);
      await expect(client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,program_name
         ) VALUES ('97-0002-02',2097,'Missing, Import','College','Program')`,
      )).rejects.toMatchObject({ code: "23502" });
      await expect(client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,program_name,
           source_import_group_id
         ) VALUES (
           '97-0003-03',2097,'Invalid, Import','College','Program',
           'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
         )`,
      )).rejects.toMatchObject({ code: "23503" });
      await expect(client.query(
        "DELETE FROM schedule_import_groups WHERE id=$1",
        [importGroupId],
      )).rejects.toMatchObject({ code: "23001" });

      const gatewayResult = await client.query<{ result: { insertedCount: number } }>(
        `SELECT ensure_student_academic_snapshots($1,$2::jsonb) AS result`,
        [
          actorId,
          JSON.stringify([{
            student_number: "97-0004-04",
            academic_year_start: 2097,
            student_name: "Gateway, Student",
            college_id: null,
            college_name: "Snapshot College",
            program_id: null,
            program_code: null,
            program_name: "Snapshot Program",
            year_level: 1,
            source_import_group_id: importGroupId,
          }]),
        ],
      );
      expect(gatewayResult.rows[0]?.result.insertedCount).toBe(1);
    });
  });

  it("does not derive academic years or snapshots from appointments that predate migration 016", async () => {
    await inIsolatedSchema(async (client) => {
      await createPrerequisiteSchema(client);
      await client.query("INSERT INTO students (student_number) VALUES ('96-0001-01')");
      await client.query(
        `INSERT INTO appointments (
           id,student_number,schedule_type,schedule_cycle_start,appointment_date,is_published
         ) VALUES (
           'dddddddd-dddd-4ddd-8ddd-dddddddddddd','96-0001-01','LABORATORY',2096,
           '2096-09-01',TRUE
         )`,
      );
      await client.query(await readFile(migrationPath, "utf8"));

      await expect(client.query("SELECT * FROM academic_years")).resolves.toMatchObject({ rows: [] });
      await expect(client.query("SELECT * FROM student_academic_snapshots")).resolves.toMatchObject({ rows: [] });
      await expect(client.query(
        `SELECT * FROM audit_logs
          WHERE action='HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED'`,
      )).resolves.toMatchObject({ rows: [] });
    });
  });
});
