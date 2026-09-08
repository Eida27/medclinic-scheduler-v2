import assert from "node:assert/strict";
import { Client } from "pg";

export function validateTestDatabase(value?: string, consent?: string) {
  if (consent !== "1") throw new Error("TEST_DATABASE_DISPOSABLE=1 is required.");
  if (!value) throw new Error("TEST_DATABASE_URL is required; application DATABASE_URL is never a fallback.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Expected a PostgreSQL URL.");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) throw new Error("Test database must use loopback.");
  if (url.search || url.hash) throw new Error("Test database URL query parameters and fragments are forbidden.");
  if (!url.username) throw new Error("Test database URL must name an explicit PostgreSQL role.");
  if (url.port === "0") throw new Error("Test database port must be between 1 and 65535.");
  url.port ||= "5432";
  const database = url.pathname.slice(1);
  if (!/^medclinic_test_[a-z0-9_]+$/.test(database) || database.length > 63) {
    throw new Error("Use a new medclinic_test_* database with lowercase ASCII letters, digits, underscores (maximum 63 characters).");
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  return { database, targetUrl: url.toString(), adminUrl: adminUrl.toString() };
}

export async function withDisposableTestDatabase<T>(
  callback: (target: ReturnType<typeof validateTestDatabase>) => Promise<T>,
  value = process.env.TEST_DATABASE_URL,
  consent = process.env.TEST_DATABASE_DISPOSABLE,
): Promise<T> {
  const target = validateTestDatabase(value, consent);
  const admin = new Client({ connectionString: target.adminUrl, connectionTimeoutMillis: 5000, options: "" });
  let ownedOid: number | undefined;
  let created = false;
  let primaryFailure: unknown;
  await admin.connect();
  try {
    const existing = await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [target.database]);
    if (existing.rowCount) throw new Error(`Refusing existing database ${target.database}; choose a new target.`);
    // CREATE DATABASE is atomic: a concurrent creator fails this invocation before ownership is acquired.
    await admin.query(`CREATE DATABASE "${target.database}"`);
    created = true;
    ownedOid = (await admin.query<{ oid: number }>("SELECT oid FROM pg_database WHERE datname=$1", [target.database])).rows[0].oid;
    const client = new Client({ connectionString: target.targetUrl, connectionTimeoutMillis: 5000, options: "" });
    try {
      await client.connect();
      const live = (await client.query<{ database: string; address: string; port: number; schema: string; oid: number }>(
        `SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port,
                current_schema() AS schema, (SELECT oid FROM pg_database WHERE datname=current_database()) AS oid`,
      )).rows[0];
      assert.equal(live.database, target.database, "Live database identity mismatch");
      assert.equal(live.oid, ownedOid, "Live database OID mismatch");
      assert.ok(["127.0.0.1", "::1"].includes(live.address), "Live server must use loopback");
      assert.equal(live.port, Number(new URL(target.targetUrl).port), "Live port mismatch");
      assert.equal(live.schema, "public", "Live schema must be public");
    } finally { await client.end(); }
    console.log(`Verified disposable database ${target.database}.`);
    return await callback(target);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (created && ownedOid === undefined) {
        throw new Error("Cannot prove database ownership after creation; inspect possible residue manually.");
      }
      if (ownedOid !== undefined) {
        const current = await admin.query<{ oid: number }>("SELECT oid FROM pg_database WHERE datname=$1", [target.database]);
        assert.equal(current.rows[0]?.oid, ownedOid, "Refusing cleanup: owned database identity changed");
        await admin.query(`DROP DATABASE "${target.database}" WITH (FORCE)`);
        const residue = await admin.query("SELECT oid FROM pg_database WHERE datname=$1", [target.database]);
        assert.equal(residue.rowCount, 0, "Disposable database residue remains");
        console.log(`Dropped disposable database ${target.database}; residue=0.`);
      }
    } catch (error) {
      console.error(`DISPOSABLE DATABASE CLEANUP FAILED: ${target.database}; inspect residue before retrying.`);
      if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, error], "Test execution and disposable database cleanup both failed.");
      throw error;
    } finally { await admin.end(); }
  }
}
