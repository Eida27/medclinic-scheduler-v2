# Migration Transaction Ownership and Empty-Database Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the migration runner the sole owner of migration transactions and prove that migrations `001` through `027` apply atomically and successfully to a completely empty PostgreSQL database.

**Architecture:** Extract the existing migration loop into a small testable runner module while keeping `scripts/db-migrate.ts` as the production CLI. Remove top-level transaction-control statements from historical SQL migrations, add a source guard that rejects future migration-owned transactions, and add a disposable-database verification command that creates a real empty PostgreSQL database, runs the actual migration CLI twice, validates final schema state, and injects a failing synthetic migration to prove rollback atomicity.

**Tech Stack:** Node.js, TypeScript, `pg`, `tsx`, Vitest 4.1.8, PostgreSQL transactional DDL.

**Spec:** Approved migration-hardening design from the 2026-09-01 repository review. This plan is the authoritative implementation specification.

## Global Constraints

- The repository is still pre-production. Editing historical migration files is allowed for this task because no production database is being asked to preserve an already-recorded checksum/history contract.
- There are currently **27** migrations: `001` through `027`. Do not describe the verification target as 26 migrations.
- `scripts/db-migrate.ts` is the sole owner of `BEGIN`, `COMMIT`, and `ROLLBACK` for each migration.
- A migration file under `database/migrations/*.sql` must not open, commit, or roll back its own top-level transaction.
- PostgreSQL PL/pgSQL block `BEGIN ... END` syntax inside function bodies is allowed; the guard must distinguish that from SQL transaction-control statements such as `BEGIN;` and `COMMIT;`.
- The migration SQL and its `schema_migrations` insert must commit or roll back together.
- A failed migration must leave neither partial DDL/data changes nor a `schema_migrations` row for that migration.
- Do not use `npm run db:reset` as migration verification. The test must create and destroy a separate disposable database.
- Never point the disposable-database test at the normal application database for destructive setup/teardown.
- The empty-database verification must execute the actual `scripts/db-migrate.ts` CLI, not merely call migration SQL directly from the test harness.
- The second execution against the same disposable database must be a no-op and must not add duplicate migration records.
- Do not run seeds as a substitute for migration verification. This task verifies schema migrations independently from bootstrap/reference seeding.
- Keep First-Year scheduling, staff-login throttling, result uploads, HTTPS settings, worker topology, and other production-readiness items unchanged.
- Do not introduce a migration framework dependency. The existing lightweight runner remains the migration system.
- Do not add `BEGIN`/`COMMIT` to migration `027_staff_login_brute_force_protection.sql`; it is already correctly runner-owned.

## Current Repository Evidence

At the start of this plan:

- `scripts/db-migrate.ts` creates `schema_migrations`, then wraps each unapplied migration with `BEGIN`, executes the migration SQL, inserts the migration name, and commits; on error it rolls back.
- Seven migration files also contain their own top-level `BEGIN; ... COMMIT;` wrappers:
  - `010_maximum_only_capacity.sql`
  - `011_current_appointment_and_submission_read_indexes.sql`
  - `015_appointment_result_protection.sql`
  - `021_clinic_closure_recovery_policy.sql`
  - `022_schedule_import_year_category_validation.sql`
  - `025_scheduling_integrity_hardening.sql`
  - `026_remove_priority_groups_and_legacy_scheduling.sql`
- Because PostgreSQL does not provide true nested transactions through repeated `BEGIN`/`COMMIT`, an inner `COMMIT` can end the runner-owned transaction before the `schema_migrations` row is written. A later failure can therefore leave schema changes applied but migration history missing.
- Three migration integration suites currently compensate for shared-schema mutation by re-running a later migration in `afterAll`:
  - `appointment-result-protection-migration.integration.test.ts` replays migration `025`;
  - `clinic-closure-recovery-policy-migration.integration.test.ts` replays migration `025`;
  - `mandatory-student-email-verification-notifications-migration.integration.test.ts` replays migration `024`.
- Migration `027_staff_login_brute_force_protection.sql` exists and must be included in the clean-database run.

## File Map

Create:

- `scripts/db-migration-runner.ts`
- `scripts/db-migration-empty-database-test.ts`
- `src/server/db/migration-runner.test.ts`
- `src/server/db/migration-transaction-ownership.test.ts`

Modify:

- `scripts/db-migrate.ts`
- `package.json`
- `database/migrations/010_maximum_only_capacity.sql`
- `database/migrations/011_current_appointment_and_submission_read_indexes.sql`
- `database/migrations/015_appointment_result_protection.sql`
- `database/migrations/021_clinic_closure_recovery_policy.sql`
- `database/migrations/022_schedule_import_year_category_validation.sql`
- `database/migrations/025_scheduling_integrity_hardening.sql`
- `database/migrations/026_remove_priority_groups_and_legacy_scheduling.sql`
- `src/server/db/appointment-result-protection-migration.integration.test.ts`
- `src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts`
- `src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts`

Do not create migration `028` for this task. The fix is to correct transaction ownership in the existing pre-production migration history.

---

### Task 1: Extract and test the runner-owned transaction boundary

**Files:**
- Create: `scripts/db-migration-runner.ts`
- Create: `src/server/db/migration-runner.test.ts`
- Modify: `scripts/db-migrate.ts`

**Interfaces:**
- Produces:

```ts
export type MigrationFile = {
  name: string;
  sql: string;
};

export type MigrationClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
};

export async function ensureSchemaMigrations(client: MigrationClient): Promise<void>;

export async function applyMigration(
  client: MigrationClient,
  migration: MigrationFile,
): Promise<boolean>;

export async function runMigrations(
  client: MigrationClient,
  migrations: MigrationFile[],
  log?: (message: string) => void,
): Promise<string[]>;
```

`applyMigration` returns `false` when the migration was already recorded and `true` when it was applied in this call. `runMigrations` returns the names applied in order.

- Consumes: `sqlFiles(...)`, `projectPath(...)`, and `withClient(...)` from `scripts/db-common.ts`.

- [ ] **Step 1: Write failing runner unit tests**

Create `src/server/db/migration-runner.test.ts` with a small fake client that records query order.

Test successful ownership:

```ts
it("commits migration SQL and its migration-history row in one runner-owned transaction", async () => {
  const client = fakeMigrationClient();

  await expect(applyMigration(client, {
    name: "999_test.sql",
    sql: "CREATE TABLE runner_probe (id integer);",
  })).resolves.toBe(true);

  expect(client.sql()).toEqual([
    "SELECT 1 FROM schema_migrations WHERE name = $1",
    "BEGIN",
    "CREATE TABLE runner_probe (id integer);",
    "INSERT INTO schema_migrations (name) VALUES ($1)",
    "COMMIT",
  ]);
});
```

Test failure ownership:

```ts
it("rolls back when migration SQL fails and never records the migration", async () => {
  const client = fakeMigrationClient({
    rejectSql: "SELECT forced_migration_failure()",
  });

  await expect(applyMigration(client, {
    name: "999_failure.sql",
    sql: "SELECT forced_migration_failure()",
  })).rejects.toThrow("forced migration failure");

  expect(client.sql()).toEqual([
    "SELECT 1 FROM schema_migrations WHERE name = $1",
    "BEGIN",
    "SELECT forced_migration_failure()",
    "ROLLBACK",
  ]);
  expect(client.sql()).not.toContain("INSERT INTO schema_migrations (name) VALUES ($1)");
  expect(client.sql()).not.toContain("COMMIT");
});
```

Test already-applied behavior:

```ts
it("skips a migration already present in schema_migrations", async () => {
  const client = fakeMigrationClient({ applied: new Set(["001_existing.sql"]) });

  await expect(applyMigration(client, {
    name: "001_existing.sql",
    sql: "SELECT 1",
  })).resolves.toBe(false);

  expect(client.sql()).toEqual([
    "SELECT 1 FROM schema_migrations WHERE name = $1",
  ]);
});
```

The fake may normalize whitespace before recording so formatting in production code does not make assertions brittle. Do not mock PostgreSQL behavior beyond what these ownership tests need; real rollback behavior is tested in Task 4.

- [ ] **Step 2: Run the focused unit test and confirm RED**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/db/migration-runner.test.ts
```

Expected: FAIL because `scripts/db-migration-runner.ts` does not exist.

- [ ] **Step 3: Implement `scripts/db-migration-runner.ts`**

Use this control flow:

```ts
export async function ensureSchemaMigrations(client: MigrationClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function applyMigration(
  client: MigrationClient,
  migration: MigrationFile,
) {
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE name = $1",
    [migration.name],
  );
  if (applied.rowCount) return false;

  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [migration.name],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(
  client: MigrationClient,
  migrations: MigrationFile[],
  log: (message: string) => void = console.log,
) {
  await ensureSchemaMigrations(client);
  const appliedNames: string[] = [];
  for (const migration of migrations) {
    if (await applyMigration(client, migration)) {
      appliedNames.push(migration.name);
      log(`Applied ${migration.name}`);
    }
  }
  return appliedNames;
}
```

Keep ownership exactly here. Do not add `SAVEPOINT` complexity; no nested transaction behavior is required.

- [ ] **Step 4: Rewire `scripts/db-migrate.ts` without changing CLI semantics**

Replace the inline loop with:

```ts
import { projectPath, sqlFiles, withClient } from "./db-common";
import { runMigrations } from "./db-migration-runner";

await withClient(async (client) => {
  const migrations = await sqlFiles(projectPath("database", "migrations"));
  await runMigrations(client, migrations);
});
```

Do not change the `db:migrate` package script yet.

- [ ] **Step 5: Run the focused runner test GREEN**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/db/migration-runner.test.ts
```

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/db-migration-runner.ts scripts/db-migrate.ts src/server/db/migration-runner.test.ts
git commit -m "refactor: centralize migration transaction ownership"
```

---

### Task 2: Remove migration-owned transaction wrappers and prevent regression

**Files:**
- Create: `src/server/db/migration-transaction-ownership.test.ts`
- Modify the seven migration files listed below.

**Interfaces:**
- Produces a repository invariant: migration files contain no top-level SQL transaction-control statements.
- Consumes `sqlFiles(projectPath("database", "migrations"))`.

- [ ] **Step 1: Write the source-level ownership guard first**

Create `src/server/db/migration-transaction-ownership.test.ts`.

The test must load every `.sql` migration and reject standalone transaction-control statements while allowing PL/pgSQL block `BEGIN` syntax.

Use a line-anchored expression such as:

```ts
const transactionControl = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;\s*(?:--.*)?$/gim;
```

Test:

```ts
it("keeps migration transaction ownership in the TypeScript runner", async () => {
  const migrations = await sqlFiles(projectPath("database", "migrations"));
  expect(migrations).toHaveLength(27);
  expect(migrations[0]?.name.startsWith("001_")).toBe(true);
  expect(migrations.at(-1)?.name).toBe("027_staff_login_brute_force_protection.sql");

  const violations = migrations.flatMap((migration) =>
    [...migration.sql.matchAll(transactionControl)].map((match) => ({
      migration: migration.name,
      statement: match[0].trim(),
    })),
  );

  expect(violations).toEqual([]);
});
```

Do not reject plain `BEGIN` without a semicolon inside PL/pgSQL function bodies.

- [ ] **Step 2: Run the guard and verify RED with the known seven migrations**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/db/migration-transaction-ownership.test.ts
```

Expected: FAIL and list transaction-control violations from:

```text
010_maximum_only_capacity.sql
011_current_appointment_and_submission_read_indexes.sql
015_appointment_result_protection.sql
021_clinic_closure_recovery_policy.sql
022_schedule_import_year_category_validation.sql
025_scheduling_integrity_hardening.sql
026_remove_priority_groups_and_legacy_scheduling.sql
```

If additional migration files are reported, inspect them and remove only genuine top-level transaction-control statements. Do not alter PL/pgSQL block control flow.

- [ ] **Step 3: Remove only the outer transaction wrappers**

For each of these files:

```text
database/migrations/010_maximum_only_capacity.sql
database/migrations/011_current_appointment_and_submission_read_indexes.sql
database/migrations/015_appointment_result_protection.sql
database/migrations/021_clinic_closure_recovery_policy.sql
database/migrations/022_schedule_import_year_category_validation.sql
database/migrations/025_scheduling_integrity_hardening.sql
database/migrations/026_remove_priority_groups_and_legacy_scheduling.sql
```

remove the file-level opening:

```sql
BEGIN;
```

and the file-level trailing:

```sql
COMMIT;
```

Do not change any DDL, DML, constraints, functions, triggers, comments, or business rules inside the migration.

For migration `021`, preserve the PL/pgSQL function body containing:

```sql
BEGIN
  ...
END;
```

That is procedural block syntax, not transaction ownership.

- [ ] **Step 4: Run the ownership guard GREEN**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/db/migration-transaction-ownership.test.ts
```

- [ ] **Step 5: Search the migration directory manually as a second guard**

```bash
rg -n '^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;' database/migrations
```

Expected: no output. If `rg` reports a PL/pgSQL false positive, inspect it rather than deleting valid function syntax.

- [ ] **Step 6: Commit Task 2**

```bash
git add \
  database/migrations/010_maximum_only_capacity.sql \
  database/migrations/011_current_appointment_and_submission_read_indexes.sql \
  database/migrations/015_appointment_result_protection.sql \
  database/migrations/021_clinic_closure_recovery_policy.sql \
  database/migrations/022_schedule_import_year_category_validation.sql \
  database/migrations/025_scheduling_integrity_hardening.sql \
  database/migrations/026_remove_priority_groups_and_legacy_scheduling.sql \
  src/server/db/migration-transaction-ownership.test.ts

git commit -m "fix: make migration runner sole transaction owner"
```

---

### Task 3: Stop migration tests from repairing the shared schema afterward

**Files:**
- Modify: `src/server/db/appointment-result-protection-migration.integration.test.ts`
- Modify: `src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts`
- Modify: `src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts`

**Interfaces:**
- Produces tests that either execute historical migration SQL inside an outer test transaction that is rolled back, or test the already-current schema without replaying historical migrations globally.
- No test may restore the shared schema by manually re-running a later migration in `afterAll`.

- [ ] **Step 1: Add regression expectations before removing the repair hooks**

For each of the three files, structure schema-mutating migration replay so it occurs under an explicit test-owned `BEGIN`/`ROLLBACK` on one `PoolClient`.

The test-owned transaction is intentionally allowed: the prohibition applies to `database/migrations/*.sql`, not tests.

For `appointment-result-protection-migration.integration.test.ts`, preserve the populated-schema behavior by using one client:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(migration015);

  // Insert the student/appointment/manual-case fixture through this same client.
  // Re-apply migration015 through this same client.
  // Assert the manual lock fields are unchanged and DRAFT_RESULT_FILES_EXIST is accepted.
} finally {
  await client.query("ROLLBACK");
  client.release();
}
```

Replace `insertTestStudent(...)` in this test with a direct `client.query(...)` insert using the existing `TEST_REFERENCE_IDS`, so every fixture mutation is inside the same rollback boundary.

For `clinic-closure-recovery-policy-migration.integration.test.ts`, run the migration `021` replay and its schema/data assertions inside a client transaction and roll it back. Leave the separate immutability and index behavior tests transactionally isolated as they already are or make their cleanup explicit.

For `mandatory-student-email-verification-notifications-migration.integration.test.ts`, remove the file-wide `beforeAll` migration replay. The clean-database harness in Task 4 will prove that migration `023` applies in sequence. If the first contract test still needs to prove idempotent reapplication, run `023` inside a one-test transaction and roll it back. The concurrency and behavior tests should run against the current final schema without globally replaying `023`.

- [ ] **Step 2: Remove manual latest-migration restoration**

Delete these restoration constants and hooks:

```text
latestSchedulingMigrationPath -> 025_scheduling_integrity_hardening.sql
latestStaffSecurityMigrationPath -> 024_staff_account_security_onboarding_deletion.sql
```

No `afterAll` should execute migration `024` or `025` merely to repair schema state left by another test.

Keep `pool.end()` in the suite cleanup where required by the current integration-test pattern.

- [ ] **Step 3: Run the three focused migration suites**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/db/appointment-result-protection-migration.integration.test.ts \
  src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts \
  src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts
```

Expected: PASS without replaying migrations `024`/`025` from `afterAll`.

- [ ] **Step 4: Verify the shared schema remains on the latest contract after those tests**

Run the existing migration-ownership guard and one current-schema test that depends on migration `025`/`027`, for example:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/db/migration-transaction-ownership.test.ts \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts
```

This is a regression check that the historical migration suites no longer leave the configured development/test database at an older schema contract.

- [ ] **Step 5: Commit Task 3**

```bash
git add \
  src/server/db/appointment-result-protection-migration.integration.test.ts \
  src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts \
  src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts

git commit -m "test: isolate historical migration replays"
```

---

### Task 4: Verify migrations 001–027 against a real empty PostgreSQL database

**Files:**
- Create: `scripts/db-migration-empty-database-test.ts`
- Modify: `package.json`
- Uses: `scripts/db-migration-runner.ts`, `scripts/db-common.ts`, and the real `scripts/db-migrate.ts` CLI.

**Interfaces:**
- New command:

```bash
npm run test:migrations:empty
```

- Optional environment variable:

```text
MIGRATION_TEST_ADMIN_DATABASE_URL
```

If supplied, it must point to the same PostgreSQL server using credentials allowed to `CREATE DATABASE` and `DROP DATABASE`. If omitted, derive an administrative connection from `DATABASE_URL` by keeping protocol/host/port/user/password/query parameters and replacing only the database path with `/postgres`.

The disposable target database URL must be derived from the administrative URL by replacing only its database name with the generated test database name.

- [ ] **Step 1: Add the package command first**

Add:

```json
"test:migrations:empty": "tsx --env-file=.env.local scripts/db-migration-empty-database-test.ts"
```

Do not add this command to production startup.

- [ ] **Step 2: Create the disposable-database harness**

Create `scripts/db-migration-empty-database-test.ts` using:

```ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { databaseUrl, projectPath, sqlFiles } from "./db-common";
import { applyMigration } from "./db-migration-runner";
```

Generate a safe database identifier only from lowercase letters, digits, and underscores:

```ts
const databaseName = `medclinic_migration_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
assert.match(databaseName, /^[a-z0-9_]+$/);
```

Because PostgreSQL identifiers cannot be parameter placeholders, only interpolate this internally generated, regex-validated identifier into `CREATE DATABASE`, `DROP DATABASE`, and `pg_terminate_backend` statements. Never interpolate user input.

Implement URL helpers:

```ts
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
```

If `CREATE DATABASE` fails with PostgreSQL error `42501`, throw a message explaining that the migration test needs a development-only connection with `CREATEDB`, and that `MIGRATION_TEST_ADMIN_DATABASE_URL` may be set for this test. Do not weaken production DB privileges.

- [ ] **Step 3: Execute the actual migration CLI as a child process**

Do not call `runMigrations(...)` for the primary clean-database success path. Spawn the same CLI entry point used by developers:

```ts
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
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
```

Do not include `--env-file=.env.local` in the child process. The parent command already loaded `.env.local`, and the child must receive the overridden disposable `DATABASE_URL` through `env` without an env-file replacing it.

- [ ] **Step 4: Assert that all current migration files are exercised**

Before running the CLI:

```ts
const migrations = await sqlFiles(projectPath("database", "migrations"));
assert.equal(migrations.length, 27);
assert.ok(migrations[0]?.name.startsWith("001_"));
assert.equal(migrations.at(-1)?.name, "027_staff_login_brute_force_protection.sql");
```

After the first CLI run, connect to the disposable database and query:

```sql
SELECT name
FROM schema_migrations
ORDER BY name;
```

Assert the result exactly equals:

```ts
migrations.map((migration) => migration.name)
```

Also assert `stdout` contains exactly 27 `Applied ...` lines.

- [ ] **Step 5: Assert representative final-schema contracts**

Against the same disposable database verify at least:

```sql
SELECT to_regclass('public.staff_login_failures')::text AS staff_login_failures,
       to_regclass('public.priority_groups')::text AS priority_groups;
```

Expected:

```ts
{
  staff_login_failures: "staff_login_failures",
  priority_groups: null,
}
```

Verify the retired column is gone:

```sql
SELECT COUNT(*)::integer AS count
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='coordinator_schedule_items'
  AND column_name='priority_group_id';
```

Expected `0`.

Verify scheduling integrity hardening exists:

```sql
SELECT is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='clinic_closure_manual_cases'
  AND column_name='case_source';
```

Expected one row with `is_nullable = 'NO'`.

Verify staff-security tombstone schema exists:

```sql
SELECT COUNT(*)::integer AS count
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='users'
  AND column_name IN ('email_verified_at','must_change_password','credential_version','deleted_at','deleted_by');
```

Expected `5`.

These assertions are representative smoke checks. The exact `schema_migrations` equality is the authoritative proof that all 27 files were executed and recorded.

- [ ] **Step 6: Prove a second real CLI run is a no-op**

Run `runMigrationCli(targetDatabaseUrl)` again.

Assert:

```ts
assert.equal(second.stdout.match(/^Applied /gm)?.length ?? 0, 0);
```

Query `schema_migrations` again and assert it still contains exactly the same 27 names with no duplicates.

- [ ] **Step 7: Prove failed DDL and history insertion roll back together**

Use the exported `applyMigration(...)` against the same disposable database with a synthetic migration that is not stored in the repository:

```ts
await assert.rejects(
  applyMigration(client, {
    name: "999_forced_atomicity_failure.sql",
    sql: `
      CREATE TABLE migration_atomicity_probe (id integer);
      SELECT definitely_missing_migration_function();
    `,
  }),
);
```

Then assert:

```sql
SELECT to_regclass('public.migration_atomicity_probe')::text AS probe;
```

returns `null`, and:

```sql
SELECT COUNT(*)::integer AS count
FROM schema_migrations
WHERE name='999_forced_atomicity_failure.sql';
```

returns `0`.

Finally run `SELECT 1` on the same client to prove `applyMigration` issued a rollback and returned the connection to a usable transaction state before propagating the error.

This is the regression that proves the original transaction-ownership defect is actually fixed rather than merely hidden by removing warnings.

- [ ] **Step 8: Always destroy the disposable database**

Use `try/finally`. In cleanup, connect to the admin database, terminate only sessions for the generated database name, then drop it:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname=$1 AND pid<>pg_backend_pid();
```

Then execute validated-identifier SQL:

```ts
await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
```

Ensure application/test clients are closed before this cleanup.

Never drop the database named by ordinary `DATABASE_URL`.

- [ ] **Step 9: Run the empty-database command**

```bash
npm run test:migrations:empty
```

Expected successful output includes 27 applied migrations on the first internal run, zero on the second, successful rollback assertions, and final cleanup of the generated database.

If the local PostgreSQL user lacks `CREATEDB`, configure a development-only `MIGRATION_TEST_ADMIN_DATABASE_URL` with that privilege and rerun. Do not grant `CREATEDB` to the production application account merely to satisfy this test.

- [ ] **Step 10: Commit Task 4**

```bash
git add scripts/db-migration-empty-database-test.ts package.json
git commit -m "test: verify migrations from an empty database"
```

---

### Task 5: Full regression and production-readiness verification

**Files:**
- No new files expected.
- Review every file changed in Tasks 1–4.

**Interfaces:**
- Final proof commands: migration ownership guard, empty-database migration run, complete test suite, lint, and production build.

- [ ] **Step 1: Confirm all migration files remain runner-owned**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/db/migration-runner.test.ts \
  src/server/db/migration-transaction-ownership.test.ts
```

Then:

```bash
rg -n '^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;' database/migrations
```

Expected: no top-level transaction-control matches in migration files.

- [ ] **Step 2: Run the real empty-database migration verification again**

```bash
npm run test:migrations:empty
```

This command is mandatory before declaring this production blocker resolved.

- [ ] **Step 3: Run focused historical migration suites**

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/db/appointment-result-protection-migration.integration.test.ts \
  src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts \
  src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts
```

- [ ] **Step 4: Run the entire automated suite**

```bash
npm test
```

Do not infer full-suite success from the focused migration tests.

- [ ] **Step 5: Run lint**

```bash
npm run lint
```

- [ ] **Step 6: Run the production build**

```bash
npm run build
```

- [ ] **Step 7: Review migration diff for accidental business-rule changes**

```bash
git diff <BASE_SHA>...HEAD -- database/migrations scripts/db-migrate.ts scripts/db-migration-runner.ts scripts/db-migration-empty-database-test.ts src/server/db package.json
```

For the seven historical migration files, the only intended SQL-content changes are removal of the outer `BEGIN;` and `COMMIT;` lines. Any other SQL change requires explicit justification and review.

- [ ] **Step 8: Verify migration count and names from disk**

```bash
ls database/migrations/*.sql
```

Confirm the sequence is `001` through `027` with no duplicate numeric prefix or accidental `028` added by this task.

On PowerShell, equivalent verification is acceptable:

```powershell
Get-ChildItem database/migrations/*.sql | Sort-Object Name | Select-Object -ExpandProperty Name
```

- [ ] **Step 9: Final implementation commit if work was not committed incrementally**

```bash
git add \
  scripts/db-migration-runner.ts \
  scripts/db-migrate.ts \
  scripts/db-migration-empty-database-test.ts \
  package.json \
  database/migrations/010_maximum_only_capacity.sql \
  database/migrations/011_current_appointment_and_submission_read_indexes.sql \
  database/migrations/015_appointment_result_protection.sql \
  database/migrations/021_clinic_closure_recovery_policy.sql \
  database/migrations/022_schedule_import_year_category_validation.sql \
  database/migrations/025_scheduling_integrity_hardening.sql \
  database/migrations/026_remove_priority_groups_and_legacy_scheduling.sql \
  src/server/db/migration-runner.test.ts \
  src/server/db/migration-transaction-ownership.test.ts \
  src/server/db/appointment-result-protection-migration.integration.test.ts \
  src/server/db/clinic-closure-recovery-policy-migration.integration.test.ts \
  src/server/db/mandatory-student-email-verification-notifications-migration.integration.test.ts

git commit -m "fix: enforce atomic database migrations"
```

---

## Acceptance Criteria

1. `scripts/db-migrate.ts` remains the production migration CLI.
2. One shared runner implementation owns `BEGIN`, migration execution, `schema_migrations` insertion, `COMMIT`, and failure `ROLLBACK`.
3. Migration SQL and its history row are committed in the same PostgreSQL transaction.
4. Migration files do not contain top-level `BEGIN;`, `START TRANSACTION;`, `COMMIT;`, or `ROLLBACK;` statements.
5. PL/pgSQL function-body `BEGIN ... END` blocks remain valid and are not mistaken for transaction ownership.
6. The outer transaction wrappers are removed from migrations `010`, `011`, `015`, `021`, `022`, `025`, and `026` without changing their business DDL/DML.
7. Migration `027_staff_login_brute_force_protection.sql` remains included and runner-owned.
8. A permanent regression test scans all current migration files and fails if migration-owned transaction control is reintroduced.
9. The source guard explicitly observes 27 current migrations ending at `027_staff_login_brute_force_protection.sql`.
10. Historical migration integration tests no longer repair shared schema state by re-running migrations `024` or `025` in `afterAll`.
11. Any direct historical migration replay that mutates schema is enclosed by a test-owned transaction and rolled back, or removed when the new clean-database test supplies the migration-application proof.
12. `npm run test:migrations:empty` creates a genuinely separate empty PostgreSQL database.
13. The empty-database test uses the actual `scripts/db-migrate.ts` CLI for the success path.
14. First execution applies and records exactly all 27 migrations in filename order.
15. `schema_migrations` exactly matches the 27 SQL filenames after the clean run.
16. Representative final schema objects from migrations `024`–`027` are validated.
17. `priority_groups` and `coordinator_schedule_items.priority_group_id` are absent after migration `026`.
18. `staff_login_failures` exists after migration `027`.
19. A second migration CLI run succeeds without applying anything new.
20. A synthetic migration that creates DDL then fails leaves neither its DDL object nor its migration-history row behind.
21. The database connection remains usable after the forced failure, proving rollback occurred.
22. The disposable database is removed in `finally`, including after test failure.
23. The test never drops or resets the ordinary application database.
24. Lack of local `CREATEDB` privilege produces a clear setup error and does not justify granting elevated privileges to the production application user.
25. Existing migration-specific integration tests remain green.
26. `npm test` passes.
27. `npm run lint` passes.
28. `npm run build` passes.
29. No scheduling, authentication, result-upload, notification, or application business logic is changed by this task.

## Codex Scope Guard

Do **not** opportunistically combine this migration-hardening task with other production-readiness work. Specifically do not change:

- First-Year Laboratory → Physical Examination timing;
- academic-year closing-date mutation policy;
- staff-login throttle limits or proxy-IP policy;
- production HTTPS/secure-cookie enforcement;
- result-upload memory/storage behavior;
- PostgreSQL pool sizing;
- worker/process topology;
- CI/CD configuration;
- seed/bootstrap credentials or admin onboarding;
- scheduling engine behavior;
- clinic closure recovery rules.

Do not create a new migration solely to remove transaction wrappers from historical migrations. This repository is pre-production, so correct the existing migration files in place.

## Codex Execution Instruction

Use this exact handoff after the plan is committed:

> Implement `docs/superpowers/plans/2026-09-01-migration-transaction-ownership-and-empty-database-verification.md` exactly as written. Follow the TDD sequence and Codex Scope Guard. Treat the migration runner as the sole transaction owner, preserve all migration business SQL, and verify the real migration CLI against a disposable empty PostgreSQL database containing migrations 001–027. Before declaring completion, run `npm run test:migrations:empty`, `npm test`, `npm run lint`, and `npm run build`, and report the exact command outcomes.
