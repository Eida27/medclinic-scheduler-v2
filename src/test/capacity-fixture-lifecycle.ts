import type { Pool, PoolClient } from "pg";

const CAPACITY_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('medclinic:test:capacity-settings'))";
const CAPACITY_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('medclinic:test:capacity-settings'))";
const CAPACITY_IDS = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
] as const;

export type CapacitySettingSnapshot = Array<{
  id: string;
  max_daily_capacity: number;
}>;

export type CapacityFixtureLock = {
  client: PoolClient;
  originalCapacities: CapacitySettingSnapshot;
};

function firstFailure(current: unknown, next: unknown) {
  return current ?? next;
}

async function shutdownCapacityFixtureLock(
  pool: Pool,
  client: PoolClient | undefined,
  initialFailure?: unknown,
  unlock = true,
) {
  let failure = initialFailure;
  try {
    if (client && unlock) await client.query(CAPACITY_UNLOCK_SQL);
  } catch (error) {
    failure = firstFailure(failure, error);
  } finally {
    try {
      client?.release();
    } catch (error) {
      failure = firstFailure(failure, error);
    } finally {
      try {
        await pool.end();
      } catch (error) {
        failure = firstFailure(failure, error);
      }
    }
  }
  return failure;
}

export async function restoreCapacitySettings(
  pool: Pool,
  capacities: CapacitySettingSnapshot,
) {
  if (!capacities.length) return;
  await pool.query(
    `UPDATE clinic_capacity_settings setting
        SET safe_daily_capacity=fixture.max_daily_capacity,
            max_daily_capacity=fixture.max_daily_capacity
       FROM UNNEST($1::uuid[], $2::integer[])
         AS fixture(id, max_daily_capacity)
      WHERE setting.id=fixture.id`,
    [
      capacities.map((capacity) => capacity.id),
      capacities.map((capacity) => capacity.max_daily_capacity),
    ],
  );
}

export async function cleanupAndRestoreCapacitySettings(
  pool: Pool,
  capacities: CapacitySettingSnapshot,
  cleanup: () => Promise<void>,
) {
  let failure: unknown;
  try {
    await cleanup();
  } catch (error) {
    failure = error;
  }
  try {
    await restoreCapacitySettings(pool, capacities);
  } catch (error) {
    failure = firstFailure(failure, error);
  }
  if (failure) throw failure;
}

export async function setupCapacityFixtureLock(
  pool: Pool,
  setup: () => Promise<void>,
): Promise<CapacityFixtureLock> {
  let client: PoolClient | undefined;
  let lockAcquired = false;
  try {
    client = await pool.connect();
    await client.query(CAPACITY_LOCK_SQL);
    lockAcquired = true;
    await setup();
    const capacities = await pool.query<{
      id: string;
      max_daily_capacity: number;
    }>(
      `SELECT id, max_daily_capacity
         FROM clinic_capacity_settings
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [CAPACITY_IDS],
    );
    return { client, originalCapacities: capacities.rows };
  } catch (error) {
    await shutdownCapacityFixtureLock(pool, client, error, lockAcquired);
    throw error;
  }
}

export async function teardownCapacityFixtureLock(
  pool: Pool,
  fixture: CapacityFixtureLock,
  cleanup: () => Promise<void>,
) {
  let failure: unknown;
  try {
    await cleanupAndRestoreCapacitySettings(
      pool,
      fixture.originalCapacities,
      cleanup,
    );
  } catch (error) {
    failure = error;
  } finally {
    failure = await shutdownCapacityFixtureLock(pool, fixture.client, failure);
  }
  if (failure) throw failure;
}
