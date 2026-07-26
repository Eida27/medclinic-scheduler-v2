// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import * as unavailableDateRepository from "./clinic-unavailable-dates.repository";

const reasonPrefix = "TEST-CALENDAR-CONTRACT";
const exactUpdatedAt = "2048-07-15T09:10:11.123456Z";

type ClinicUnavailableDateRepositoryContract = typeof unavailableDateRepository & {
  listActiveClinicUnavailableDateRecords: () => Promise<Array<{
    id: string;
    updatedAt: string;
  }>>;
  lockActiveClinicUnavailableDates: (
    client: PoolClient,
    ids: string[],
  ) => Promise<Array<{
    id: string;
    updatedAt: string;
  }>>;
  insertClinicUnavailableDate: (
    client: PoolClient,
    input: {
      action: "BLOCK";
      clinicId: string;
      date: string;
      category: "CLOSURE";
      reason: string;
    },
    actorUserId: string,
    batchId: string,
  ) => Promise<string>;
  softUnblockClinicUnavailableDate: (
    client: PoolClient,
    input: {
      id: string;
      expectedUpdatedAt: string;
      actorUserId: string;
      batchId: string;
    },
  ) => Promise<boolean>;
};

const repository = unavailableDateRepository as ClinicUnavailableDateRepositoryContract;

async function insertFixtureBlock(input: {
  date: string;
  reason: string;
  updatedAt?: string;
  unblocked?: boolean;
}) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by,
       updated_at, unblocked_at, unblocked_by, unblocked_batch_id
     ) VALUES ($1,$2,$2,'CLOSURE',$3,$4,$5::timestamptz,$6::timestamptz,$7,$8)
     RETURNING id::text`,
    [
      TEST_REFERENCE_IDS.physicalExamClinic,
      input.date,
      input.reason,
      TEST_REFERENCE_IDS.adminUser,
      input.updatedAt ?? "2048-07-15T09:10:11.000000Z",
      input.unblocked ? "2048-07-16T09:10:11.000000Z" : null,
      input.unblocked ? TEST_REFERENCE_IDS.adminUser : null,
      input.unblocked ? randomUUID() : null,
    ],
  );
  return result.rows[0].id;
}

async function cleanup() {
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE $1", [`${reasonPrefix}%`]);
}

afterEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
});

describe("clinic unavailable-date repository contracts", () => {
  it("lists only active records and preserves the exact optimistic token", async () => {
    const activeId = await insertFixtureBlock({
      date: "2048-07-15",
      reason: `${reasonPrefix} active`,
      updatedAt: exactUpdatedAt,
    });
    const unblockedId = await insertFixtureBlock({
      date: "2048-07-16",
      reason: `${reasonPrefix} unblocked`,
      unblocked: true,
    });

    expect(repository.listActiveClinicUnavailableDateRecords).toEqual(expect.any(Function));
    const active = await repository.listActiveClinicUnavailableDateRecords();
    expect(active.some((record) => record.id === activeId)).toBe(true);
    expect(active.some((record) => record.id === unblockedId)).toBe(false);
    expect(active.find((record) => record.id === activeId)).toMatchObject({
      updatedAt: exactUpdatedAt,
    });

    await expect(unavailableDateRepository.listClinicUnavailableDateRecords()).resolves.toEqual(active);
  });

  it("writes separate batch provenance and accepts only the exact active version when unblocking", async () => {
    expect(repository.insertClinicUnavailableDate).toEqual(expect.any(Function));
    expect(repository.lockActiveClinicUnavailableDates).toEqual(expect.any(Function));
    expect(repository.softUnblockClinicUnavailableDate).toEqual(expect.any(Function));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const createdBatchId = randomUUID();
      const activeId = await repository.insertClinicUnavailableDate(
        client,
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2048-07-17",
          category: "CLOSURE",
          reason: `${reasonPrefix} created`,
        },
        TEST_REFERENCE_IDS.adminUser,
        createdBatchId,
      );
      const unblockedId = await insertFixtureBlock({
        date: "2048-07-18",
        reason: `${reasonPrefix} previously unblocked`,
        unblocked: true,
      });

      const locked = await repository.lockActiveClinicUnavailableDates(client, [activeId, unblockedId]);
      expect(locked).toEqual([expect.objectContaining({ id: activeId, updatedAt: expect.any(String) })]);

      await expect(repository.softUnblockClinicUnavailableDate(client, {
        id: activeId,
        expectedUpdatedAt: "2048-07-17T00:00:00.000000Z",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
        batchId: randomUUID(),
      })).resolves.toBe(false);

      const unblockedBatchId = randomUUID();
      await expect(repository.softUnblockClinicUnavailableDate(client, {
        id: activeId,
        expectedUpdatedAt: locked[0].updatedAt,
        actorUserId: TEST_REFERENCE_IDS.adminUser,
        batchId: unblockedBatchId,
      })).resolves.toBe(true);
      await client.query("COMMIT");

      await expect(pool.query(
        `SELECT created_batch_id::text, unblocked_at, unblocked_by::text, unblocked_batch_id::text
           FROM clinic_unavailable_dates
          WHERE id=$1`,
        [activeId],
      )).resolves.toMatchObject({
        rows: [expect.objectContaining({
          created_batch_id: createdBatchId,
          unblocked_at: expect.any(Date),
          unblocked_by: TEST_REFERENCE_IDS.adminUser,
          unblocked_batch_id: unblockedBatchId,
        })],
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
