import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { databaseUrl, projectPath, sqlFiles } from "./db-common";
import { applyMigration } from "./db-migration-runner";

const databaseName = `medclinic_migration_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
assert.match(databaseName, /^[a-z0-9_]+$/);

function adminDatabaseUrl() {
  const explicit = process.env.MIGRATION_TEST_ADMIN_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const url = new URL(databaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(adminUrl: string, databaseName: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runMigrationCli(targetDatabaseUrl: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", projectPath("scripts", "db-migrate.ts")],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`db-migrate exited ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

const adminUrl = adminDatabaseUrl();
const targetDatabaseUrl = databaseUrlFor(adminUrl, databaseName);
const migrations = await sqlFiles(projectPath("database", "migrations"));

assert.equal(migrations.length, 27);
assert.ok(migrations[0]?.name.startsWith("001_"));
assert.equal(migrations.at(-1)?.name, "027_staff_login_brute_force_protection.sql");

let databaseCreated = false;
let client: Client | undefined;

try {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      databaseCreated = true;
    } catch (error) {
      if (isPostgresError(error) && error.code === "42501") {
        throw new Error(
          "The empty-database migration test needs a development-only PostgreSQL connection with CREATEDB. Set MIGRATION_TEST_ADMIN_DATABASE_URL for this test if the ordinary development connection lacks that privilege; do not weaken production database privileges.",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    await admin.end();
  }

  const first = await runMigrationCli(targetDatabaseUrl);
  process.stdout.write(first.stdout);
  process.stderr.write(first.stderr);
  const firstAppliedCount = first.stdout.match(/^Applied /gm)?.length ?? 0;
  assert.equal(firstAppliedCount, 27);
  console.log(`First migration CLI applied count: ${firstAppliedCount}`);

  client = new Client({ connectionString: targetDatabaseUrl });
  await client.connect();

  const expectedMigrationNames = migrations.map((migration) => migration.name);
  const firstHistory = await client.query<{ name: string }>(`
    SELECT name
    FROM schema_migrations
    ORDER BY name
  `);
  assert.deepEqual(
    firstHistory.rows.map((row) => row.name),
    expectedMigrationNames,
  );

  const relations = await client.query<{
    staff_login_failures: string | null;
    priority_groups: string | null;
  }>(`
    SELECT to_regclass('public.staff_login_failures')::text AS staff_login_failures,
           to_regclass('public.priority_groups')::text AS priority_groups
  `);
  assert.deepEqual(relations.rows[0], {
    staff_login_failures: "staff_login_failures",
    priority_groups: null,
  });

  const retiredColumn = await client.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='coordinator_schedule_items'
      AND column_name='priority_group_id'
  `);
  assert.equal(retiredColumn.rows[0]?.count, 0);

  const caseSource = await client.query<{ is_nullable: string }>(`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='clinic_closure_manual_cases'
      AND column_name='case_source'
  `);
  assert.deepEqual(caseSource.rows, [{ is_nullable: "NO" }]);

  const staffSecurityColumns = await client.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name IN ('email_verified_at','must_change_password','credential_version','deleted_at','deleted_by')
  `);
  assert.equal(staffSecurityColumns.rows[0]?.count, 5);
  console.log("Final schema and exact 27-entry migration history assertions passed.");

  const second = await runMigrationCli(targetDatabaseUrl);
  process.stdout.write(second.stdout);
  process.stderr.write(second.stderr);
  const secondAppliedCount = second.stdout.match(/^Applied /gm)?.length ?? 0;
  assert.equal(secondAppliedCount, 0);
  console.log(`Second migration CLI applied count: ${secondAppliedCount}`);

  const secondHistory = await client.query<{ name: string }>(`
    SELECT name
    FROM schema_migrations
    ORDER BY name
  `);
  assert.deepEqual(
    secondHistory.rows.map((row) => row.name),
    expectedMigrationNames,
  );

  await assert.rejects(
    applyMigration(client, {
      name: "999_forced_atomicity_failure.sql",
      sql: `
        CREATE TABLE migration_atomicity_probe (id integer);
        SELECT definitely_missing_migration_function();
      `,
    }),
  );

  const atomicityProbe = await client.query<{ probe: string | null }>(`
    SELECT to_regclass('public.migration_atomicity_probe')::text AS probe
  `);
  assert.equal(atomicityProbe.rows[0]?.probe, null);

  const atomicityHistory = await client.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM schema_migrations
    WHERE name='999_forced_atomicity_failure.sql'
  `);
  assert.equal(atomicityHistory.rows[0]?.count, 0);

  const usableConnection = await client.query<{ value: number }>("SELECT 1 AS value");
  assert.deepEqual(usableConnection.rows, [{ value: 1 }]);
  console.log("Atomic DDL/history rollback and post-rollback connection assertions passed.");
} finally {
  try {
    if (client) {
      await client.end();
    }
  } finally {
    if (databaseCreated) {
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query(
          `
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname=$1 AND pid<>pg_backend_pid()
          `,
          [databaseName],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
        console.log(`Dropped disposable migration database ${databaseName}.`);
      } finally {
        await admin.end();
      }
    }
  }
}
