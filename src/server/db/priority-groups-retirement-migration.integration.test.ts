// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";

const migrationsDirectory = join(process.cwd(), "database", "migrations");
const seedPath = join(process.cwd(), "database", "seeds", "001_reference_and_users.sql");

const ADMIN_ID = "02600000-0000-4000-8000-000000000001";
const STUDENT_NUMBER = "99-2601-01";
const COLLEGE_ID = "10000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "20000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PRIORITY_GROUP_ID = "30000000-0000-4000-8000-000000000004";

afterAll(async () => {
  await pool.end();
});

async function migrationFilesThrough(version: number) {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 3)) <= version)
    .sort();
}

async function applyMigrationsThrough(client: PoolClient, version: number) {
  const files = await migrationFilesThrough(version);
  for (const file of files) {
    await client.query(await readFile(join(migrationsDirectory, file), "utf8"));
  }
}

async function withDisposableSchema(callback: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  const schemaName = `retire_priority_${randomUUID().replaceAll("-", "_")}`;
  const quotedSchema = `"${schemaName}"`;
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await callback(client);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    client.release();
  }
}

async function assertPriorityStorageRetired(client: PoolClient) {
  const table = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name='priority_groups'`,
  );
  const column = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name='coordinator_schedule_items'
        AND column_name='priority_group_id'`,
  );
  expect(table.rows).toEqual([]);
  expect(column.rows).toEqual([]);
}

async function insertCurrentFixturePrincipals(client: PoolClient) {
  await client.query(
    `INSERT INTO users (
       id,full_name,email,password_hash,email_verified_at,must_change_password,role
     ) VALUES ($1,'Migration 026 Administrator','migration-026@example.test','hash',NOW(),FALSE,'ADMIN')`,
    [ADMIN_ID],
  );
  await client.query(
    `INSERT INTO students (
       student_number,first_name,last_name,college_id,program_id,year_level
     ) VALUES ($1,'Migration','Student',$2,$3,3)`,
    [STUDENT_NUMBER, COLLEGE_ID, PROGRAM_ID],
  );
  await client.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2027,'2028-07-31',$1,$1)`,
    [ADMIN_ID],
  );
}

describe("026 priority groups and legacy scheduling retirement migration", () => {
  it("builds and seeds a fresh 001-026 schema without priority storage", async () => {
    await withDisposableSchema(async (client) => {
      await applyMigrationsThrough(client, 26);
      await client.query(await readFile(seedPath, "utf8"));
      await assertPriorityStorageRetired(client);

      await insertCurrentFixturePrincipals(client);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO schedule_batches (
           clinic_id,batch_name,status,created_by
         ) VALUES ($1,'Migration 026 current batch','PUBLISHED',$2)
         RETURNING id::text`,
        [LABORATORY_CLINIC_ID, ADMIN_ID],
      );
      await expect(client.query(
        `INSERT INTO coordinator_schedule_items (
           batch_id,clinic_id,student_number,schedule_type,target_date,status,
           source_row_order,schedule_cycle_start
         ) VALUES ($1,$2,$3,'LABORATORY','2027-08-15','SCHEDULED',1,2027)`,
        [batch.rows[0].id, LABORATORY_CLINIC_ID, STUDENT_NUMBER],
      )).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("upgrades 025 data without cascading into scheduling provenance or history", async () => {
    await withDisposableSchema(async (client) => {
      await applyMigrationsThrough(client, 25);
      await client.query(await readFile(seedPath, "utf8"));
      await insertCurrentFixturePrincipals(client);

      const importGroupId = randomUUID();
      const batchId = randomUUID();
      const scheduleItemId = randomUUID();
      const appointmentId = randomUUID();
      const auditId = randomUUID();
      const displacementId = randomUUID();

      await client.query(
        `INSERT INTO schedule_import_groups (
           id,import_name,source_filename,total_rows,matched_student_count,created_by,
           student_category,academic_year_start,accepted_at
         ) VALUES ($1,'Migration 026 upgrade','upgrade.csv',1,1,$2,'REGULAR',2027,NOW())`,
        [importGroupId, ADMIN_ID],
      );
      await client.query(
        `INSERT INTO schedule_batches (
           id,clinic_id,batch_name,status,created_by,published_by,published_at,import_group_id
         ) VALUES ($1,$2,'Migration 026 legacy batch','PUBLISHED',$3,$3,NOW(),$4)`,
        [batchId, LABORATORY_CLINIC_ID, ADMIN_ID, importGroupId],
      );
      await client.query(
        `INSERT INTO coordinator_schedule_items (
           id,batch_id,clinic_id,student_number,schedule_type,priority_group_id,
           target_date,status,source_row_order,schedule_cycle_start
         ) VALUES ($1,$2,$3,$4,'LABORATORY',$5,'2027-08-15','SCHEDULED',1,2027)`,
        [scheduleItemId, batchId, LABORATORY_CLINIC_ID, STUDENT_NUMBER, PRIORITY_GROUP_ID],
      );
      await client.query(
        `INSERT INTO appointments (
           id,batch_id,schedule_item_id,clinic_id,student_number,schedule_type,
           appointment_date,status,is_published,schedule_cycle_start,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,'LABORATORY','2027-08-15','PENDING',TRUE,2027,$6,$6)`,
        [appointmentId, batchId, scheduleItemId, LABORATORY_CLINIC_ID, STUDENT_NUMBER, ADMIN_ID],
      );
      await client.query(
        `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id)
         VALUES ($1,$2,'MIGRATION_026_HISTORY','appointment',$3)`,
        [auditId, ADMIN_ID, appointmentId],
      );
      await client.query(
        `INSERT INTO appointment_reschedule_events (
           id,student_number,cause,source_import_group_id,old_laboratory_appointment_id,actor_user_id
         ) VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,$5)`,
        [displacementId, STUDENT_NUMBER, importGroupId, appointmentId, ADMIN_ID],
      );

      const migration026 = await readFile(
        join(migrationsDirectory, "026_remove_priority_groups_and_legacy_scheduling.sql"),
        "utf8",
      );
      await client.query(migration026);

      await assertPriorityStorageRetired(client);
      const survivors = await client.query<{ entity: string; id: string }>(
        `SELECT 'import' AS entity,id::text FROM schedule_import_groups WHERE id=$1
         UNION ALL SELECT 'batch',id::text FROM schedule_batches WHERE id=$2
         UNION ALL SELECT 'item',id::text FROM coordinator_schedule_items WHERE id=$3
         UNION ALL SELECT 'appointment',id::text FROM appointments WHERE id=$4
         UNION ALL SELECT 'audit',id::text FROM audit_logs WHERE id=$5
         UNION ALL SELECT 'displacement',id::text FROM appointment_reschedule_events WHERE id=$6
         ORDER BY entity`,
        [importGroupId, batchId, scheduleItemId, appointmentId, auditId, displacementId],
      );
      expect(survivors.rows).toEqual([
        { entity: "appointment", id: appointmentId },
        { entity: "audit", id: auditId },
        { entity: "batch", id: batchId },
        { entity: "displacement", id: displacementId },
        { entity: "import", id: importGroupId },
        { entity: "item", id: scheduleItemId },
      ]);
    });
  });
});
