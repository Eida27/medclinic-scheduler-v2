// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";
import { changeCapacity } from "@/server/services/appointments.service";
import { restoreCapacitySettings } from "@/test/capacity-fixture-lifecycle";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

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
