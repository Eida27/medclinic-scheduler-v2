// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { sqlFiles } from "../../../scripts/db-common";
import { runMigrations } from "../../../scripts/db-migration-runner";
import { withDisposableTestDatabase } from "../../../scripts/test-database";

describe("fresh clinic capacity defaults", () => {
  it("seeds both services at 100, defaults omitted maximums, and preserves saved settings on replay", async () => {
    const target = new URL(process.env.TEST_DATABASE_URL!);
    target.pathname = `/medclinic_test_default_capacity_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await withDisposableTestDatabase(async ({ targetUrl }) => {
      const client = new Client({ connectionString: targetUrl });
      try {
        await client.connect();
        await runMigrations(client, await sqlFiles(join(process.cwd(), "database/migrations")), () => {});
        const seed = await readFile(join(process.cwd(), "database/seeds/001_reference_and_users.sql"), "utf8");
        await client.query(seed);
        const capacity = await client.query(
          `SELECT clinic.code, setting.schedule_type, setting.max_daily_capacity
             FROM clinic_capacity_settings setting JOIN clinics clinic ON clinic.id=setting.clinic_id
            ORDER BY clinic.code, setting.schedule_type`,
        );
        expect.soft(capacity.rows).toEqual([
          { code: "CPU_CLINIC", schedule_type: "PHYSICAL_EXAM", max_daily_capacity: 100 },
          { code: "KABALAKA_CLINIC", schedule_type: "LABORATORY", max_daily_capacity: 100 },
        ]);
        expect((await client.query(`SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM students) AS students`)).rows).toEqual([{ users: 0, students: 0 }]);

        const clinicId = randomUUID();
        await client.query("INSERT INTO clinics (id,code,name) VALUES ($1,'TEST_DEFAULT_CAPACITY','Default capacity test clinic')", [clinicId]);
        const omitted = await client.query(
          "INSERT INTO clinic_capacity_settings (clinic_id,schedule_type) VALUES ($1,'LABORATORY') RETURNING max_daily_capacity",
          [clinicId],
        );
        expect.soft(omitted.rows).toEqual([{ max_daily_capacity: 100 }]);
        expect((await client.query(`SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='clinic_capacity_settings' AND column_name='safe_daily_capacity'`)).rows).toEqual([]);
        for (const maximum of [0, -1]) {
          await expect(client.query("UPDATE clinic_capacity_settings SET max_daily_capacity=$2 WHERE clinic_id=$1", [clinicId, maximum]))
            .rejects.toMatchObject({ code: "23514", constraint: "clinic_capacity_settings_max_daily_capacity_positive" });
        }
        await expect(client.query("UPDATE clinic_capacity_settings SET max_daily_capacity=NULL WHERE clinic_id=$1", [clinicId]))
          .rejects.toMatchObject({ code: "23502", column: "max_daily_capacity" });
        await expect(client.query("INSERT INTO clinic_capacity_settings (clinic_id,schedule_type) VALUES ($1,'LABORATORY')", [clinicId]))
          .rejects.toMatchObject({ code: "23505" });

        await client.query(`UPDATE clinic_capacity_settings setting SET max_daily_capacity=CASE clinic.code
          WHEN 'KABALAKA_CLINIC' THEN 80 ELSE 120 END FROM clinics clinic
          WHERE clinic.id=setting.clinic_id AND clinic.code IN ('KABALAKA_CLINIC','CPU_CLINIC')`);
        const saved = (await client.query("SELECT id,clinic_id,schedule_type,max_daily_capacity FROM clinic_capacity_settings ORDER BY id")).rows;
        await client.query(seed);
        expect((await client.query("SELECT id,clinic_id,schedule_type,max_daily_capacity FROM clinic_capacity_settings ORDER BY id")).rows).toEqual(saved);
        expect((await client.query(`SELECT clinic.code, setting.max_daily_capacity
          FROM clinic_capacity_settings setting JOIN clinics clinic ON clinic.id=setting.clinic_id
          WHERE clinic.code IN ('KABALAKA_CLINIC','CPU_CLINIC') ORDER BY clinic.code`)).rows).toEqual([
          { code: "CPU_CLINIC", max_daily_capacity: 120 },
          { code: "KABALAKA_CLINIC", max_daily_capacity: 80 },
        ]);
      } finally {
        await client.end();
      }
    }, target.toString(), "1");
  }, 60_000);
});
