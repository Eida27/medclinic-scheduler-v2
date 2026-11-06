import { Client } from "pg";
import { projectPath, sqlFiles } from "./db-common";
import { validateDisposableDatabaseUrl, verifyLiveDisposableDatabase } from "./db-disposable-target";
import { runMigrations } from "./db-migration-runner";

if (process.env.ALLOW_DB_RESET !== "true") {
  throw new Error("Set ALLOW_DB_RESET=true to reset a disposable database");
}

const value = process.env.DB_RESET_DATABASE_URL;
if (!value) throw new Error("DB_RESET_DATABASE_URL is required to reset a disposable database");
const { database, url } = validateDisposableDatabaseUrl(value, "DB_RESET_DATABASE_URL");

// pg and libpq can fill in connection and session settings from PG* variables.
const overrides = Object.keys(process.env).filter(name => /^PG/i.test(name));
if (overrides.length) {
  throw new Error(`Unset PostgreSQL environment overrides before reset: ${overrides.sort().join(", ")}`);
}

const port = Number(url.port);
const client = new Client({
  host: url.hostname.replace(/^\[|\]$/g, ""),
  port,
  database,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  connectionTimeoutMillis: 5000,
  options: "-c search_path=public",
});
await client.connect();
try {
  await verifyLiveDisposableDatabase(client, database, port);
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  await runMigrations(client, await sqlFiles(projectPath("database", "migrations")));

  for (const seed of await sqlFiles(projectPath("database", "seeds"))) {
    await client.query(seed.sql);
    console.log(`Applied ${seed.name}`);
  }
} finally {
  await client.end();
}
