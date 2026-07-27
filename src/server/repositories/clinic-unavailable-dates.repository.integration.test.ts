// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  createClosureGroupWithDates,
  listActiveClinicUnavailableDateRecords,
  listUnifiedBlockedDateSet,
  lockActiveUnavailableDates,
  reopenUnavailableDate,
} from "./clinic-unavailable-dates.repository";

const reasonPrefix = "TEST-UNIFIED-REPOSITORY";

async function cleanup() {
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE $1)`,
    [`${reasonPrefix}%`],
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE $1", [`${reasonPrefix}%`]);
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("unified unavailable-date repository", () => {
  it("returns one date-only active set without a clinic scope", async () => {
    await transaction(async (client) => {
      await createClosureGroupWithDates(client, {
        startDate: "2050-09-05",
        endDate: "2050-09-06",
        dates: ["2050-09-05", "2050-09-06"],
        category: "CLOSURE",
        reason: `${reasonPrefix} active`,
      }, TEST_REFERENCE_IDS.adminUser, randomUUID());
    });
    const records = (await listActiveClinicUnavailableDateRecords())
      .filter((record) => record.reason.startsWith(reasonPrefix));
    expect(records).toEqual([
      expect.objectContaining({ blockedDate: "2050-09-05", groupStartDate: "2050-09-05", groupEndDate: "2050-09-06" }),
      expect.objectContaining({ blockedDate: "2050-09-06", groupStartDate: "2050-09-05", groupEndDate: "2050-09-06" }),
    ]);
    expect([...await listUnifiedBlockedDateSet()]).toEqual(expect.arrayContaining(["2050-09-05", "2050-09-06"]));
    expect(records[0]).not.toHaveProperty("clinicId");
  });

  it("uses the exact optimistic token and excludes reopened dates", async () => {
    await transaction(async (client) => {
      const created = await createClosureGroupWithDates(client, {
        startDate: "2050-09-07",
        endDate: "2050-09-07",
        dates: ["2050-09-07"],
        category: "HOLIDAY",
        reason: `${reasonPrefix} stale`,
      }, TEST_REFERENCE_IDS.adminUser, randomUUID());
      const locked = await lockActiveUnavailableDates(client, [created.dates[0].id]);
      await expect(reopenUnavailableDate(client, {
        id: created.dates[0].id,
        expectedUpdatedAt: "2000-01-01T00:00:00.000000Z",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
        batchId: randomUUID(),
      })).resolves.toBe(false);
      await expect(reopenUnavailableDate(client, {
        id: created.dates[0].id,
        expectedUpdatedAt: locked[0].updatedAt,
        actorUserId: TEST_REFERENCE_IDS.adminUser,
        batchId: randomUUID(),
      })).resolves.toBe(true);
    });
    expect((await listActiveClinicUnavailableDateRecords()).filter((record) => record.reason.startsWith(reasonPrefix))).toEqual([]);
  });
});
