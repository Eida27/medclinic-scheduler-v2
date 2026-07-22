// @vitest-environment node
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "./capacity-fixture-lifecycle";

const fixtureFiles = [
  "src/server/services/schedule-import-lifecycle.integration.test.ts",
  "src/server/services/priority-displacement.integration.test.ts",
  "src/server/services/clinic-calendar.integration.test.ts",
  "src/test/automated-scheduling-student-portal.e2e.integration.test.ts",
];

describe("capacity-mutating fixture lifecycle", () => {
  it.each(fixtureFiles)("uses failure-safe setup and teardown in %s", async (file) => {
    const source = await readFile(file, "utf8");

    expect(source).toContain("setupCapacityFixtureLock");
    expect(source).toContain("teardownCapacityFixtureLock");
  });

  it("restores schedule-import capacity after every test", async () => {
    const source = await readFile(
      "src/server/services/schedule-import-lifecycle.integration.test.ts",
      "utf8",
    );

    expect(source).toMatch(/afterEach\(async \(\) => \{[\s\S]*cleanupAndRestoreCapacitySettings/);
  });

  it("ends the pool while preserving a connection failure", async () => {
    const connectionFailure = new Error("connection failed");
    const pool = {
      connect: vi.fn().mockRejectedValue(connectionFailure),
      end: vi.fn().mockRejectedValue(new Error("pool end failed")),
    } as unknown as Pool;

    await expect(setupCapacityFixtureLock(pool, vi.fn())).rejects.toBe(connectionFailure);

    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("releases the lock and pool while preserving a setup failure", async () => {
    const setupFailure = new Error("setup failed");
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;

    await expect(setupCapacityFixtureLock(
      pool,
      vi.fn().mockRejectedValue(setupFailure),
    )).rejects.toBe(setupFailure);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(client.query).mock.calls[1][0])).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("releases the client and pool while preserving a lock failure", async () => {
    const lockFailure = new Error("lock failed");
    const client = {
      query: vi.fn().mockRejectedValue(lockFailure),
      release: vi.fn(() => {
        throw new Error("release failed");
      }),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
      end: vi.fn().mockRejectedValue(new Error("pool end failed")),
    } as unknown as Pool;

    await expect(setupCapacityFixtureLock(pool, vi.fn())).rejects.toBe(lockFailure);

    expect(client.query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("restores capacity even when per-test cleanup fails", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await expect(cleanupAndRestoreCapacitySettings(
      pool,
      [{ id: "capacity-1", max_daily_capacity: 150 }],
      vi.fn().mockRejectedValue(cleanupFailure),
    )).rejects.toBe(cleanupFailure);

    expect(pool.query).toHaveBeenCalledOnce();
  });

  it("runs every teardown step and preserves the cleanup failure", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const restoreFailure = new Error("restore failed");
    const client = {
      query: vi.fn().mockRejectedValue(new Error("unlock failed")),
      release: vi.fn(() => {
        throw new Error("release failed");
      }),
    } as unknown as PoolClient;
    const pool = {
      query: vi.fn().mockRejectedValue(restoreFailure),
      end: vi.fn().mockRejectedValue(new Error("pool end failed")),
    } as unknown as Pool;
    const fixture: CapacityFixtureLock = {
      client,
      originalCapacities: [{ id: "capacity-1", max_daily_capacity: 150 }],
    };

    await expect(teardownCapacityFixtureLock(
      pool,
      fixture,
      vi.fn().mockRejectedValue(cleanupFailure),
    )).rejects.toBe(cleanupFailure);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
