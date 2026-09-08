import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTestDatabase, withDisposableTestDatabase } from "../../scripts/test-database";

function newTarget() {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/medclinic_test_guard_${randomUUID().replaceAll("-", "")}`;
  return url.toString();
}
async function exists(targetUrl: string) {
  const target = validateTestDatabase(targetUrl, "1");
  const admin = new Client({ connectionString: target.adminUrl });
  await admin.connect();
  try { return (await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [target.database])).rowCount; }
  finally { await admin.end(); }
}

describe("disposable database ownership", () => {
  it("refuses an existing target before fixtures and preserves its sentinel", async () => {
    const url = newTarget();
    await withDisposableTestDatabase(async ({ targetUrl }) => {
      const client = new Client({ connectionString: targetUrl });
      await client.connect();
      try {
        await client.query("CREATE TABLE untouched_sentinel (value text)");
        await client.query("INSERT INTO untouched_sentinel VALUES ('preserve-me')");
        await expect(withDisposableTestDatabase(async () => {
          throw new Error("Fixtures must never run for an existing database");
        }, url, "1")).rejects.toThrow(/refusing existing database/i);
        expect((await client.query("SELECT value FROM untouched_sentinel")).rows).toEqual([{ value: "preserve-me" }]);
      } finally { await client.end(); }
    }, url, "1");
    expect(await exists(url)).toBe(0);
  });
  it("propagates callback failure and still proves target removal", async () => {
    const url = newTarget();
    await expect(withDisposableTestDatabase(async () => {
      throw new Error("injected fixture failure");
    }, url, "1")).rejects.toThrow("injected fixture failure");
    expect(await exists(url)).toBe(0);
  });
  it("reports both the fixture failure and a refused teardown, preserving ownership on identity drift", async () => {
    const url = newTarget();
    const target = validateTestDatabase(url, "1");
    const renamed = `${target.database}_renamed`;
    const admin = new Client({ connectionString: target.adminUrl });
    await admin.connect();
    let oid: number | undefined;
    try {
      let failure: unknown;
      try {
        await withDisposableTestDatabase(async () => {
          oid = (await admin.query<{ oid: number }>("SELECT oid FROM pg_database WHERE datname=$1", [target.database])).rows[0].oid;
          await admin.query(`ALTER DATABASE "${target.database}" RENAME TO "${renamed}"`);
          throw new Error("injected fixture failure before identity drift cleanup");
        }, url, "1");
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(String).join(" ")).toMatch(/fixture failure.*identity changed/);
      expect((await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [renamed])).rows).toEqual([{ oid }]);
    } finally {
      if (oid !== undefined) {
        const owned = await admin.query<{ oid: number }>("SELECT oid FROM pg_database WHERE datname=$1", [renamed]);
        expect(owned.rows[0]?.oid).toBe(oid);
        await admin.query(`DROP DATABASE "${renamed}" WITH (FORCE)`);
        expect((await admin.query("SELECT oid FROM pg_database WHERE oid=$1", [oid])).rowCount).toBe(0);
      }
      await admin.end();
    }
  });
});
