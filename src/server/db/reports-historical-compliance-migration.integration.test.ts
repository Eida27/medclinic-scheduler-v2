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
  const schema = `reports_migration_${randomUUID().replaceAll("-", "_")}`;
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
    CREATE TABLE users (id UUID PRIMARY KEY);
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
      first_name VARCHAR(100) NOT NULL, middle_name VARCHAR(100),
      last_name VARCHAR(100) NOT NULL, suffix VARCHAR(20),
      college_id UUID NOT NULL REFERENCES colleges(id),
      program_id UUID NOT NULL REFERENCES programs(id), year_level INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE schedule_import_groups (
      id UUID PRIMARY KEY, academic_year_start INTEGER,
      accepted_at TIMESTAMPTZ NOT NULL, created_by UUID NOT NULL REFERENCES users(id)
    );
    CREATE TABLE schedule_batches (
      id UUID PRIMARY KEY, status VARCHAR(30) NOT NULL,
      import_group_id UUID REFERENCES schedule_import_groups(id),
      published_at TIMESTAMPTZ, published_by UUID REFERENCES users(id),
      created_by UUID NOT NULL REFERENCES users(id),
      college_id UUID REFERENCES colleges(id), program_id UUID REFERENCES programs(id)
    );
    CREATE TABLE coordinator_schedule_items (
      id UUID PRIMARY KEY, batch_id UUID NOT NULL REFERENCES schedule_batches(id),
      student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
      schedule_cycle_start INTEGER
    );
    CREATE TABLE appointments (
      id UUID PRIMARY KEY, batch_id UUID REFERENCES schedule_batches(id),
      schedule_item_id UUID REFERENCES coordinator_schedule_items(id),
      student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
      schedule_type VARCHAR(30) NOT NULL, schedule_cycle_start INTEGER NOT NULL,
      appointment_date DATE NOT NULL, is_published BOOLEAN NOT NULL,
      created_by UUID REFERENCES users(id)
    );
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID REFERENCES users(id),
      action VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(100), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function seedHistoricalAppointments(client: PoolClient) {
  await client.query(`
    INSERT INTO users (id) VALUES
      ('00000000-0000-4000-8000-000000000001'),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    INSERT INTO colleges (id,name,updated_at) VALUES
      ('11111111-1111-4111-8111-111111111111','Reliable College','2025-01-01'),
      ('22222222-2222-4222-8222-222222222222','Fallback College','2025-01-01');
    INSERT INTO programs (id,college_id,code,name,updated_at) VALUES
      ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','RC','Reliable Course','2025-01-01'),
      ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','FC','Fallback Course','2025-01-01');
    INSERT INTO students (
      student_number,first_name,middle_name,last_name,suffix,
      college_id,program_id,year_level,created_at,updated_at
    ) VALUES
      ('25-0001-01','Ana','Maria','Reliable',NULL,
       '11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',2,
       '2025-08-01','2025-08-02'),
      ('25-0002-02','Ben',NULL,'Fallback','Jr.',
       '22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',3,
       '2025-08-01','2025-10-01'),
      ('24-0003-03','Cara',NULL,'Legacy',NULL,
       '22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',4,
       '2024-08-01','2024-08-01');
    INSERT INTO schedule_import_groups (id,academic_year_start,accepted_at,created_by) VALUES
      ('55555555-5555-4555-8555-555555555555',2025,'2025-08-01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ('66666666-6666-4666-8666-666666666666',2025,'2025-08-01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    INSERT INTO schedule_batches (
      id,status,import_group_id,published_at,published_by,created_by,college_id,program_id
    ) VALUES
      ('77777777-7777-4777-8777-777777777777','PUBLISHED','55555555-5555-4555-8555-555555555555','2025-08-01',
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333'),
      ('88888888-8888-4888-8888-888888888888','PUBLISHED','66666666-6666-4666-8666-666666666666','2025-08-01',
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444'),
      ('99999999-9999-4999-8999-999999999990','PUBLISHED',NULL,'2024-08-01',
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444');
    INSERT INTO coordinator_schedule_items (id,batch_id,student_number,schedule_cycle_start) VALUES
      ('99999999-9999-4999-8999-999999999991','77777777-7777-4777-8777-777777777777','25-0001-01',2025),
      ('99999999-9999-4999-8999-999999999992','88888888-8888-4888-8888-888888888888','25-0002-02',2025),
      ('99999999-9999-4999-8999-999999999993','99999999-9999-4999-8999-999999999990','24-0003-03',2024);
    INSERT INTO appointments (
      id,batch_id,schedule_item_id,student_number,schedule_type,
      schedule_cycle_start,appointment_date,is_published,created_by
    ) VALUES
      ('aaaaaaaa-0001-4001-8001-aaaaaaaa0001','77777777-7777-4777-8777-777777777777','99999999-9999-4999-8999-999999999991',
       '25-0001-01','LABORATORY',2025,'2025-09-01',TRUE,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ('aaaaaaaa-0002-4002-8002-aaaaaaaa0002','88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999992',
       '25-0002-02','PHYSICAL_EXAM',2025,'2025-09-02',TRUE,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ('aaaaaaaa-0003-4003-8003-aaaaaaaa0003','99999999-9999-4999-8999-999999999990','99999999-9999-4999-8999-999999999993',
       '24-0003-03','LABORATORY',2024,'2024-09-02',TRUE,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    INSERT INTO audit_logs (
      actor_user_id,action,entity_type,entity_id,metadata,created_at
    ) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','STUDENT_PROFILE_UPDATED_BY_IMPORT','student','25-0001-01',
       '{"importId":"55555555-5555-4555-8555-555555555555"}','2025-08-01 00:01:00+00'),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','STUDENT_UPDATED','student','25-0002-02','{}','2025-09-01');
  `);
}

afterAll(async () => {
  await pool.end();
});

describe("reports historical compliance migration", () => {
  it("backfills conservative immutable snapshots with derived academic-year configuration", async () => {
    await inIsolatedSchema(async (client) => {
      await createPrerequisiteSchema(client);
      await seedHistoricalAppointments(client);

      const migration = await readFile(migrationPath, "utf8");
      await client.query(migration);

      const years = await client.query(
        `SELECT start_year,label,closing_date::text,created_by,updated_by
           FROM academic_years ORDER BY start_year`,
      );
      expect(years.rows).toEqual([
        {
          start_year: 2024,
          label: "2024–2025",
          closing_date: "2025-07-31",
          created_by: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          updated_by: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        {
          start_year: 2025,
          label: "2025–2026",
          closing_date: "2026-07-31",
          created_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          updated_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ]);

      const snapshots = await client.query(
        `SELECT student_number,student_name,college_name,program_code,program_name,
                year_level,source_import_group_id,source_type
           FROM student_academic_snapshots ORDER BY student_number`,
      );
      expect(snapshots.rows).toEqual([
        {
          student_number: "24-0003-03",
          student_name: "Legacy, Cara",
          college_name: "Fallback College",
          program_code: "FC",
          program_name: "Fallback Course",
          year_level: 4,
          source_import_group_id: null,
          source_type: "MIGRATED_INCOMPLETE",
        },
        {
          student_number: "25-0001-01",
          student_name: "Reliable, Ana Maria",
          college_name: "Reliable College",
          program_code: "RC",
          program_name: "Reliable Course",
          year_level: 2,
          source_import_group_id: "55555555-5555-4555-8555-555555555555",
          source_type: "RECOVERED_HISTORICAL",
        },
        {
          student_number: "25-0002-02",
          student_name: "Fallback, Ben (Jr.)",
          college_name: "Fallback College",
          program_code: "FC",
          program_name: "Fallback Course",
          year_level: 3,
          source_import_group_id: null,
          source_type: "MIGRATED_INCOMPLETE",
        },
      ]);

      const audit = await client.query(
        `SELECT metadata FROM audit_logs
          WHERE action='HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED'`,
      );
      expect(audit.rows).toEqual([{
        metadata: expect.objectContaining({
          academicYearCount: 2,
          snapshotCount: 3,
          recoveredHistoricalCount: 1,
          migratedIncompleteCount: 2,
          closingDateRule: "JULY_31_OF_START_YEAR_PLUS_ONE",
        }),
      }]);

      await expect(client.query(
        "UPDATE student_academic_snapshots SET college_name='Changed'",
      )).rejects.toThrow(/immutable/i);
      await expect(client.query(
        "DELETE FROM student_academic_snapshots",
      )).rejects.toThrow(/immutable/i);
    });
  });

  it("rejects unsupported snapshot source types at the SQL boundary", async () => {
    await inIsolatedSchema(async (client) => {
      await createPrerequisiteSchema(client);
      await seedHistoricalAppointments(client);
      await client.query(await readFile(migrationPath, "utf8"));

      await expect(client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,
           program_name,source_type
         ) VALUES ('90-0001-01',2025,'Invalid, Source','College','Program','UNTRUSTED')`,
      )).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("rejects duplicate student and academic-year snapshots at the SQL boundary", async () => {
    await inIsolatedSchema(async (client) => {
      await createPrerequisiteSchema(client);
      await seedHistoricalAppointments(client);
      await client.query(await readFile(migrationPath, "utf8"));

      await expect(client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,
           program_name,source_type
         ) VALUES (
           '25-0001-01',2025,'Duplicate, Student','College','Program','RECOVERED_HISTORICAL'
         )`,
      )).rejects.toMatchObject({ code: "23505" });
    });
  });
});
