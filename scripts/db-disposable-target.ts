import assert from "node:assert/strict";
import type { Client } from "pg";

export function validateDisposableDatabaseUrl(value: string, variable: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) {
    throw new Error(`${variable} must use loopback.`);
  }
  if (/[?#]/.test(url.href)) {
    throw new Error(`${variable} query parameters and fragments are forbidden.`);
  }
  if (!url.username || decodeURIComponent(url.username).includes("\0")) {
    throw new Error(`${variable} must name an explicit PostgreSQL role.`);
  }
  if (url.port === "0") throw new Error(`${variable} port must be between 1 and 65535.`);
  url.port ||= "5432";
  const database = url.pathname.slice(1);
  if (!/^medclinic_test_[a-z0-9_]+$/.test(database) || database.length > 63) {
    throw new Error("Use a medclinic_test_* database with lowercase ASCII letters, digits, underscores (maximum 63 characters).");
  }
  return { database, url };
}

export async function verifyLiveDisposableDatabase(client: Client, database: string, port: number) {
  const { rows: [live] } = await client.query<{ database: string; address: string | null; port: number | null; schema: string | null; oid: number }>(`
    SELECT pg_catalog.current_database() AS database,
           pg_catalog.host(pg_catalog.inet_server_addr()) AS address,
           pg_catalog.inet_server_port() AS port,
           pg_catalog.current_schema() AS schema,
           (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS oid
  `);
  assert.equal(live.database, database, "Live database identity mismatch");
  assert.ok(live.address === "127.0.0.1" || live.address === "::1", "Live server must use loopback");
  assert.equal(live.port, port, "Live port mismatch");
  return live;
}
