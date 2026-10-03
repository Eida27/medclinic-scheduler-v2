// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";
import { changeCapacity } from "@/server/services/appointments.service";
import { restoreCapacitySettings } from "@/test/capacity-fixture-lifecycle";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { sqlFiles } from "../../../scripts/db-common";
import { applyMigration, runMigrations } from "../../../scripts/db-migration-runner";
import { withDisposableTestDatabase } from "../../../scripts/test-database";

afterAll(async () => { await pool.end(); });

describe("predeployment capacity schema", () => {
  it("stores only the maximum with a named positive constraint", async () => {
    const columns = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='clinic_capacity_settings'`);
    expect(columns.rows.map(row => row.column_name)).not.toContain("safe_daily_capacity");
    const constraint = await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid='clinic_capacity_settings'::regclass AND conname='clinic_capacity_settings_max_daily_capacity_positive'");
    expect(constraint.rowCount).toBe(1);
  });
  it("allows maximum one through the capacity service and restores the fixture snapshot", async () => {
    const saved = (await pool.query<{ id: string; max_daily_capacity: number }>("SELECT id,max_daily_capacity FROM clinic_capacity_settings ORDER BY id")).rows;
    try {
      expect(await changeCapacity({ clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY", maxDailyCapacity: 1 }, TEST_REFERENCE_IDS.adminUser))
        .toMatchObject({ scheduleType: "LABORATORY", maxDailyCapacity: 1 });
    } finally { await restoreCapacitySettings(pool, saved); }
    expect((await pool.query("SELECT id,max_daily_capacity FROM clinic_capacity_settings ORDER BY id")).rows).toEqual(saved);
  });
  it.each([0, -1])("rejects persisted nonpositive maximum %s", async (maximum) => {
    await expect(pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=$1", [maximum]))
      .rejects.toMatchObject({ code: "23514", constraint: "clinic_capacity_settings_max_daily_capacity_positive" });
  });
});

const schedulingTables = ["schedule_import_groups", "schedule_batches", "coordinator_schedule_items"];
const retiredSchedulingColumns = ["override_reason", "overridden_by", "overridden_at", "target_week_start", "target_week_end", "validation_issues"];

describe("predeployment scheduling schema", () => {
  it("requires current provenance and explicit publication/date states without manual metadata", async () => {
    const columns = (await pool.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name=ANY($1)`, [schedulingTables],
    )).rows;
    expect(columns.filter(column => retiredSchedulingColumns.includes(column.column_name))).toEqual([]);
    for (const [table, name] of [["schedule_import_groups", "student_category"], ["schedule_import_groups", "academic_year_start"], ["coordinator_schedule_items", "target_date"]]) {
      expect(columns.find(column => column.table_name === table && column.column_name === name)).toMatchObject({ is_nullable: "NO" });
    }
    for (const table of ["schedule_batches", "coordinator_schedule_items"]) {
      expect(columns.find(column => column.table_name === table && column.column_name === "status")).toMatchObject({ column_default: null });
    }
  });

  it("refuses each unsupported 030 row atomically, then preserves supported publication evidence", async () => {
    const target = new URL(process.env.TEST_DATABASE_URL!);
    target.pathname = `/medclinic_test_cleanup_guard_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withDisposableTestDatabase(async database => {
      const client = new Client({ connectionString: database.targetUrl });
      await client.connect();
      try {
        const migrations = await sqlFiles(join(process.cwd(), "database/migrations"));
        await runMigrations(client, migrations.filter(file => Number(file.name.slice(0, 3)) <= 30), () => {});
        await client.query(await readFile(join(process.cwd(), "database/seeds/001_reference_and_users.sql"), "utf8"));
        const actor = randomUUID();
        await client.query("INSERT INTO users (id,full_name,email,password_hash,role) VALUES ($1,'Cleanup Guard','guard@example.test','hash','ADMIN')", [actor]);
        await client.query("INSERT INTO students (student_number,first_name,last_name,college_id,program_id,year_level) VALUES ('99-3101-01','Cleanup','Guard',$1,$2,3)", [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program]);
        const migration = migrations.find(file => file.name === "031_retire_manual_schedule_metadata.sql")!;
        const schemaSnapshot = async () => ({
          columns: (await client.query("SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position", [schedulingTables])).rows,
          constraints: (await client.query("SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid,conname", [schedulingTables])).rows,
        });
        const cases = [
          { name: "missing category", category: null },
          { name: "missing academic year", year: null },
          ...["DRAFT", "VALIDATED", "GENERATED"].map(batchStatus => ({ name: `batch ${batchStatus}`, batchStatus })),
          ...["PENDING", "VALID", "WARNING", "CONFLICT", "UNSCHEDULED"].map(itemStatus => ({ name: `item ${itemStatus}`, itemStatus })),
          { name: "manual override", override: true },
          { name: "week-only target", week: true },
          { name: "nonempty validation issues", issues: [{ severity: "CONFLICT", message: "Old manual conflict" }] },
        ] as Array<{ name: string; category?: string | null; year?: number | null; batchStatus?: string; itemStatus?: string; override?: boolean; week?: boolean; issues?: unknown[] }>;
        for (const invalid of [...cases, { name: "supported" }]) {
          const group = randomUUID(), batch = randomUUID(), item = randomUUID();
          await client.query(`INSERT INTO schedule_import_groups (id,import_name,source_filename,total_rows,matched_student_count,created_by,student_category,academic_year_start)
            VALUES ($1,'Cleanup Guard','guard.csv',1,1,$2,$3,$4)`, [group, actor, invalid.category === undefined ? "REGULAR" : invalid.category, invalid.year === undefined ? 2027 : invalid.year]);
          await client.query(`INSERT INTO schedule_batches (id,clinic_id,batch_name,status,created_by,import_group_id,validation_summary,validated_by,validated_at,published_by,published_at,override_reason,overridden_by,overridden_at)
            VALUES ($1,$2,'Cleanup Guard',$3,$4,$5,'{"totalItems":1,"validCount":1,"conflictCount":0}',$4,NOW(),$4,NOW(),$6,$7,$8)`,
          [batch, TEST_REFERENCE_IDS.laboratoryClinic, invalid.batchStatus ?? "PUBLISHED", actor, group, invalid.override ? "Old manual override" : null, invalid.override ? actor : null, invalid.override ? new Date() : null]);
          await client.query(`INSERT INTO coordinator_schedule_items (id,batch_id,clinic_id,student_number,schedule_type,target_date,target_week_start,target_week_end,status,validation_issues,source_row_order,schedule_cycle_start)
            VALUES ($1,$2,$3,'99-3101-01','LABORATORY',$4,$5,$6,$7,$8,1,2027)`,
          [item, batch, TEST_REFERENCE_IDS.laboratoryClinic, invalid.week ? null : "2027-08-15", invalid.week ? "2027-08-15" : null, invalid.week ? "2027-08-21" : null, invalid.itemStatus ?? "SCHEDULED", JSON.stringify(invalid.issues ?? [])]);
          const evidence = async () => ({
            group: (await client.query("SELECT id,student_category,academic_year_start,accepted_at,created_by FROM schedule_import_groups WHERE id=$1", [group])).rows,
            batch: (await client.query("SELECT id,status,validation_summary,validated_by,validated_at,published_by,published_at,import_group_id FROM schedule_batches WHERE id=$1", [batch])).rows,
            item: (await client.query("SELECT id,batch_id,student_number,source_row_order,schedule_cycle_start FROM coordinator_schedule_items WHERE id=$1", [item])).rows,
          });
          const before = await schemaSnapshot(), beforeEvidence = await evidence();
          if (invalid.name !== "supported") {
            await expect(applyMigration(client, migration), invalid.name).rejects.toMatchObject({ message: expect.stringContaining("UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA") });
            expect(await schemaSnapshot(), invalid.name).toEqual(before);
            expect((await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [migration.name])).rowCount).toBe(0);
            expect(await evidence(), invalid.name).toEqual(beforeEvidence);
          } else {
            expect(await applyMigration(client, migration)).toBe(true);
            expect(await evidence()).toEqual(beforeEvidence);
            await expect(client.query("UPDATE schedule_batches SET status='DRAFT' WHERE id=$1", [batch])).rejects.toMatchObject({ code: "23514" });
            await expect(client.query("UPDATE coordinator_schedule_items SET status='PENDING' WHERE id=$1", [item])).rejects.toMatchObject({ code: "23514" });
          }
          await client.query("DELETE FROM coordinator_schedule_items WHERE id=$1", [item]);
          await client.query("DELETE FROM schedule_batches WHERE id=$1", [batch]);
          await client.query("DELETE FROM schedule_import_groups WHERE id=$1", [group]);
        }
      } finally { await client.end(); }
    }, target.toString(), "1");
  }, 60_000);
});
