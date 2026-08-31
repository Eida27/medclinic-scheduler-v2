// @vitest-environment node
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  clearStaffEmailFailures,
  getStaffLoginThrottle,
  lockStaffLoginBuckets,
  normalizeStaffLoginEmail,
  pruneExpiredStaffLoginFailures,
  recordStaffLoginFailure,
} from "./staff-login-throttle.repository";

const email = "staff-throttle@security.test";
const normalizedEmail = "staff-throttle@security.test";
const normalizedEmailVariant = " Staff-Throttle@Security.Test ";
const ipAddress = "198.51.100.20";
const independentIpAddress = "198.51.100.21";
const retentionEmail = "staff-throttle-retention@security.test";
const retentionIpAddress = "198.51.100.22";
const bucketKeys = [
  normalizedEmail,
  "other-staff-throttle@security.test",
  ipAddress,
  independentIpAddress,
  retentionEmail,
  retentionIpAddress,
  ...Array.from({ length: 25 }, (_, index) => `staff-throttle-ip-${index}@security.test`),
];

async function cleanupThrottleFixtures() {
  await pool.query(
    "DELETE FROM staff_login_failures WHERE bucket_key=ANY($1::varchar[])",
    [bucketKeys],
  );
}

async function waitForAdvisoryLockWaiter(observer: PoolClient, clientPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const locks = await observer.query<{ waiting: number }>(
      `SELECT COUNT(*)::integer AS waiting
         FROM pg_locks
        WHERE pid=$1 AND locktype='advisory' AND granted=FALSE`,
      [clientPid],
    );
    if (locks.rows[0].waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the second transaction to block on a staff-login advisory lock.");
}

beforeEach(cleanupThrottleFixtures);
afterEach(cleanupThrottleFixtures);

afterAll(async () => {
  try {
    await cleanupThrottleFixtures();
  } finally {
    await pool.end();
  }
});

describe("staff-login throttle repository", () => {
  it("normalizes email variants into the same email bucket", async () => {
    expect(normalizeStaffLoginEmail(normalizedEmailVariant)).toBe(normalizedEmail);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await recordStaffLoginFailure(client, normalizeStaffLoginEmail(normalizedEmailVariant), ipAddress);
      await recordStaffLoginFailure(client, normalizeStaffLoginEmail(email), independentIpAddress);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await expect(getStaffLoginThrottle(pool, normalizedEmail, ipAddress)).resolves.toMatchObject({
      emailFailureCount: 2,
      ipFailureCount: 1,
      throttled: false,
    });
  });

  it("counts EMAIL and IP failures independently", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await recordStaffLoginFailure(client, normalizedEmail, ipAddress);
      await recordStaffLoginFailure(client, "other-staff-throttle@security.test", ipAddress);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await expect(getStaffLoginThrottle(pool, normalizedEmail, ipAddress)).resolves.toMatchObject({
      emailFailureCount: 1,
      ipFailureCount: 2,
      throttled: false,
    });
  });

  it("throttles on the fifth email failure", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < 5; index += 1) {
        await recordStaffLoginFailure(client, normalizedEmail, independentIpAddress);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await expect(getStaffLoginThrottle(pool, normalizedEmail, ipAddress)).resolves.toMatchObject({
      emailFailureCount: 5,
      ipFailureCount: 0,
      throttled: true,
    });
  });

  it("throttles on the twenty-fifth IP failure across distinct email buckets", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < 25; index += 1) {
        await recordStaffLoginFailure(client, `staff-throttle-ip-${index}@security.test`, ipAddress);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await expect(getStaffLoginThrottle(pool, normalizedEmail, ipAddress)).resolves.toMatchObject({
      emailFailureCount: 0,
      ipFailureCount: 25,
      throttled: true,
    });
  });

  it("ignores failures older than fifteen minutes", async () => {
    await pool.query(
      `INSERT INTO staff_login_failures (scope,bucket_key,occurred_at)
       VALUES ('EMAIL',$1,clock_timestamp()-INTERVAL '15 minutes 1 second'),
              ('IP',$2,clock_timestamp()-INTERVAL '15 minutes 1 second')`,
      [normalizedEmail, ipAddress],
    );

    await expect(getStaffLoginThrottle(pool, normalizedEmail, ipAddress)).resolves.toEqual({
      throttled: false,
      emailFailureCount: 0,
      ipFailureCount: 0,
      retryAfterSeconds: 0,
    });
  });

  it("clears only EMAIL failures for a successful account", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await recordStaffLoginFailure(client, normalizedEmail, ipAddress);
      await clearStaffEmailFailures(client, normalizedEmail);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const failures = await pool.query<{ scope: "EMAIL" | "IP"; count: number }>(
      `SELECT scope,COUNT(*)::integer AS count
         FROM staff_login_failures
        WHERE bucket_key=ANY($1::varchar[])
        GROUP BY scope
        ORDER BY scope`,
      [[normalizedEmail, ipAddress]],
    );
    expect(failures.rows).toEqual([{ scope: "IP", count: 1 }]);
  });

  it("prunes rows older than twenty-four hours without affecting recent failures", async () => {
    await pool.query(
      `INSERT INTO staff_login_failures (scope,bucket_key,occurred_at)
       VALUES ('EMAIL',$1,clock_timestamp()-INTERVAL '24 hours 1 second'),
              ('IP',$2,clock_timestamp()-INTERVAL '23 hours 59 minutes')`,
      [retentionEmail, retentionIpAddress],
    );

    await pruneExpiredStaffLoginFailures(pool);

    const remaining = await pool.query<{ bucketKey: string }>(
      `SELECT bucket_key AS "bucketKey"
         FROM staff_login_failures
        WHERE bucket_key=ANY($1::varchar[])
        ORDER BY bucket_key`,
      [[retentionEmail, retentionIpAddress]],
    );
    expect(remaining.rows).toEqual([{ bucketKey: retentionIpAddress }]);
  });

  it("blocks a concurrent transaction until the first holds and releases both bucket locks", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    let firstCommitted = false;
    let secondSettled = false;
    try {
      await first.query("BEGIN");
      await lockStaffLoginBuckets(first, normalizedEmail, ipAddress);

      await second.query("BEGIN");
      const secondPid = await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const secondLock = lockStaffLoginBuckets(second, normalizedEmail, ipAddress).then(
        () => { secondSettled = true; },
        (error: unknown) => { secondSettled = true; throw error; },
      );

      await waitForAdvisoryLockWaiter(observer, secondPid.rows[0].pid);
      expect(secondSettled).toBe(false);

      await first.query("COMMIT");
      firstCommitted = true;
      await expect(secondLock).resolves.toBeUndefined();
      await second.query("ROLLBACK");
    } finally {
      if (!firstCommitted) await first.query("ROLLBACK");
      if (!secondSettled) await second.query("ROLLBACK");
      first.release();
      second.release();
      observer.release();
    }
  });
});
