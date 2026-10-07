# Default Clinic Daily Capacity of 100 — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox syntax for tracking. Read the spec first. This commit supplies documents for later implementation; do not treat it as completed product work.

**Goal:** Initialize KABALAKA Laboratory and CPU Physical Examination to a maximum of 100 students per day on the first fresh deployment.

**Architecture:** Change the two explicit production seed values and append a migration changing the final SQL column default to 100. Keep every runtime consumer reading the stored maximum. Adjust dependent test fixtures and current installation/policy documentation.

**Tech stack:** Next.js 16.3.5, React 19.2.4, TypeScript, PostgreSQL/`pg`, `tsx`, Vitest and Testing Library; use the existing locked dependencies.

**Spec:** [Default clinic capacity design](../specs/2026-10-07-default-clinic-capacity-100-design.md)

**Reviewed baseline:** `main` at `62b780bcb5cb7f9adb6176b4dcd4dd579cb6c62c`.

## Global constraints

- Fresh first deployment; no production data migration or appointment rewrite.
- Default maximum: 100 students per day for KABALAKA Laboratory and 100 for CPU Physical Examination.
- Administrator-configured positive integer maximums remain supported, including values above 100.
- Preserve migrations 001–031; append the next unused migration after 031.
- Maximum-only capacity; do not restore safe capacity or capacity environment settings.
- Preserve existing scheduling, service accounting, authorization, audit and fixture ownership contracts.
- No dependency upgrades, new infrastructure or unrelated refactoring.

## Review focus

- Seed replay after an Administrator saves a custom maximum must preserve the saved row.
- Final-schema inserts omitting the maximum must receive 100 rather than the historical 150.
- Pre-030 migration tests must remain valid despite the current seed no longer satisfying their retired safe-default comparison.
- A First-Year/OVPSA external Laboratory cohort above 100 must retain its authoritative date while CPU PE uses 100 per day.
- Calendar/full-day acceptance must use the configured service maximum, and intentional custom-150 fixtures must restore the actual baseline.

Each condition has a check in the task owning it.

## Preparation

- [ ] Inspect the current branch, working tree, `AGENTS.md` and linked spec. Use an isolated implementation checkout if necessary; preserve unrelated work.
- [ ] Confirm the current migration inventory. At this baseline create 032; if another migration has landed, choose the next unused number and update all count/end-name references in this spec, plan and the implementation.
- [ ] Install with `npm ci`. Before modifying application code, follow `AGENTS.md` and read the applicable installed Next.js guides under `node_modules/next/dist/docs/`.
- [ ] Use the existing `npm run test:integration` and `npm run test:migrations:empty` owned runners. Each invocation requires a new loopback `medclinic_test_*` target via `TEST_DATABASE_URL` and `TEST_DATABASE_DISPOSABLE=1`. The PostgreSQL role must be able to create/drop the owned test database. Never substitute application `DATABASE_URL`.

## Task 1: Align final-schema defaults and fresh seed values

**Files**

- Create: `database/migrations/032_default_clinic_capacity_100.sql`.
- Modify: `database/seeds/001_reference_and_users.sql`.
- Modify: `scripts/db-migration-empty-database-test.ts`.
- Modify: `src/server/db/database.integration.test.ts`.
- Create: `src/server/db/default-clinic-capacity.integration.test.ts`.

**Interfaces**

- Preserve table/column names, canonical row IDs and `UNIQUE (clinic_id, schedule_type)`.
- Consume `sqlFiles(directory)`, `runMigrations(client, migrations, log?)` and `withDisposableTestDatabase(callback, value?, consent?)` from existing scripts.
- Produce a final-schema SQL default of 100 and both canonical seeded maximums of 100. No application API changes.

- [ ] Add real PostgreSQL coverage in the new test file using a uniquely named nested disposable database and a `pg.Client`, following the predeployment schema test's ownership pattern. Close the client in `finally`; let `withDisposableTestDatabase` prove removal. Apply all migrations, execute the unmodified production seed SQL, and assert the ordered capacity result exactly:

```ts
expect(capacity.rows).toEqual([
  { code: "CPU_CLINIC", schedule_type: "PHYSICAL_EXAM", max_daily_capacity: 100 },
  { code: "KABALAKA_CLINIC", schedule_type: "LABORATORY", max_daily_capacity: 100 },
]);
```

- [ ] In that fresh target, assert zero production-seeded users/students. Create a disposable test clinic and insert its capacity row omitting `max_daily_capacity`; assert `RETURNING max_daily_capacity` is 100. Assert the safe column is absent and 0, -1 and null fail with their existing database constraints.
- [ ] Save custom maximums of 80 for KABALAKA and 120 for CPU in that target, rerun the exact production seed SQL, and assert both custom values and row identities/counts are unchanged.
- [ ] Update the existing database seed expectation from 150 to 100 for both canonical rows.
- [ ] Update the empty-migration gate's expected count to 32, last filename to `032_default_clinic_capacity_100.sql`, first-apply count to 32 and its success text to 32 entries. Preserve exact-ledger comparison, zero replay, forced atomic rollback, reusable connection and owned-target removal.
- [ ] Run the focused database tests and empty-migration command before implementing the defaults. Expected red evidence: current seeded/omitted values are 150 and the migration inventory is 31. Record actual failures, not a guessed assertion message.
- [ ] Add migration 032 with exactly `ALTER TABLE clinic_capacity_settings ALTER COLUMN max_daily_capacity SET DEFAULT 100;`. Use runner-owned transactions; no row updates.
- [ ] Change only the two capacity literals in the production seed to 100. Preserve `ON CONFLICT (id) DO NOTHING` and the reference catalog.
- [ ] With separate fresh target names, run:

```bash
npm run test:integration -- src/server/db/default-clinic-capacity.integration.test.ts src/server/db/database.integration.test.ts
npm run test:migrations:empty
```

Expected: focused tests pass; first apply 32/replay 0, exact ledger and atomicity checks pass, and every owned target reports removal.
- [ ] Commit: `feat: default both clinic capacities to 100`.

## Task 2: Verify scheduling, settings and calendar consume the new defaults

**Files**

- Modify: `src/server/services/schedule-import-lifecycle.integration.test.ts`.
- Modify: `src/server/services/first-year-schedule-import.integration.test.ts`.
- Modify: `src/components/settings/CapacityForm.test.tsx`.
- Modify: `src/server/services/calendar-occupancy.test.ts`.

**Interfaces**

- Preserve `acceptAndScheduleImport(raw, actor)`, `reviewFirstYearScheduleImport(raw, actor)`, `changeCapacity(raw, actorUserId)`, `getCapacitySettings()`, `CapacityForm({ settings })` and `occupancyTone(input)`.
- Consume persisted settings from Task 1. Existing scheduling/planning and service-occupancy implementations remain the reference behavior.

- [ ] Add a Standard-import case using 101 valid, unique nine-column CSV rows and an isolated open academic year within the existing cleanup patterns. Restore the captured Task-1 capacity baseline without setting an artificial test maximum. Assert both captured defaults are 100; import once.
- [ ] Query published current internal appointments by service/date. Assert each service's sorted daily counts are `[100, 1]`, there are 202 appointments and 101 complete pairs, every Laboratory date precedes its paired PE date, and CSV allocation/FCFS order is preserved. Use the computed eligible dates rather than wall-clock-sensitive hard-coded “today” dates.
- [ ] Add a First-Year/OVPSA case with 280 valid unique rows under the existing owned 2095 cycle. Temporarily restore the captured CPU default of 100 for this case; other existing cases retain their explicit maximum of 3. Assert review reports maximum 100 and PE counts `[100, 100, 80]`; publication/history preserve those counts, CSV order, the fixed external Laboratory date and the seven-day minimum gap. Review creates no rows; publication remains atomic. Restore the test suite's maximum of 3 in `finally` and its original 100 baseline on teardown.
- [ ] Extend CapacityForm coverage with the canonical `KABALAKA_CLINIC` and `CPU_CLINIC` mappings supplied at 100. Assert both maximum inputs show 100. Keep custom-value submit/refresh coverage (such as 130) to prove 100 is not an HTML/API cap. Correct the old `UNIVERSITY_CLINIC` identifier in the touched test fixture to `CPU_CLINIC`; do not add alias handling.
- [ ] Add parameterized calendar cases for each service: 99 used with maximum 100 is `GREEN`; 100 and 101 used are `RED`. Keep the other service configured and below its maximum. Retain the existing empty, missing-capacity and external-only cases.
- [ ] Run focused checks:

```bash
npm test -- src/components/settings/CapacityForm.test.tsx src/server/services/calendar-occupancy.test.ts
npm run test:integration -- src/server/services/schedule-import-lifecycle.integration.test.ts src/server/services/first-year-schedule-import.integration.test.ts src/server/services/capacity-integrity.integration.test.ts
```

Expected: all focused tests pass, existing reductions/conflicts/audit rollback/concurrency cases pass, and fixture cleanup restores the actual baseline. New consumer coverage may already pass after Task 1; do not refactor working runtime code to manufacture an implementation step.
- [ ] Commit: `test: verify scheduling at default capacity 100`.

## Task 3: Repair dependent acceptance and historical migration fixtures

**Files**

- Modify: `scripts/browser-scheduling-integrity-fixture.ts`.
- Modify: `src/server/acceptance/browser-scheduling-integrity-fixture.test.ts`.
- Modify: `src/server/acceptance/browser-scheduling-integrity-fixture.integration.test.ts`.
- Modify: `src/server/db/priority-groups-retirement-migration.integration.test.ts`.

**Interfaces**

- Preserve `SCHEDULING_INTEGRITY_FIXTURE`, `assertSchedulingIntegrityPreparedCounts(counts)` and existing setup/status/cleanup exports and ownership guards.
- Add only a file-local test helper `seedHistoricalReferenceData(client: PoolClient): Promise<void>` in the migration-026 test. It targets disposable historical schemas, not production.

- [ ] Change scheduling-integrity test expectations to 100 capacity students, 100 capacity appointments and 104 academic snapshots. Assert its full-day metadata/counts report maximum and used load of 100. Retain zero-residue, unrelated-sentinel preservation, identity validation and cleanup retry assertions.
- [ ] Run the affected tests before fixture implementation. Expected: the old 150 fixture/counts disagree with the new expectations or the seeded-100 prerequisite; the historical 025/026 seed encounters its obsolete safe-capacity comparison.
- [ ] Change `CAPACITY_STUDENT_COUNT` from 150 to 100. Keep generated student IDs, derived counts, the equal-to-configured-capacity prerequisite and all clinical/protection scenarios intact.
- [ ] Implement `seedHistoricalReferenceData` in the migration-026 test: read the production seed, assert/find its `INSERT INTO clinic_capacity_settings` block boundary, execute the preceding clinic/college/program reference statements, then explicitly insert the two canonical test capacity rows with `safe_daily_capacity=150` and `max_daily_capacity=150`. Use the existing seed IDs and service mappings. Replace both pre-030 production-seed calls with this helper.
- [ ] Preserve the fresh-through-026 and upgrade-from-025 test meaning. Do not apply later migrations early, remove constraints or add conditional retired-column writers to application/seed code.
- [ ] Audit remaining 150 references by meaning. Preserve the explicit First-Year browser 150/130 scenario, capacity-integrity reduction cases, pagination and string limits. Verify custom fixture cleanup restores the captured 100 baseline.
- [ ] Run:

```bash
npm test -- src/server/acceptance/browser-scheduling-integrity-fixture.test.ts src/test/capacity-fixture-lifecycle.test.ts
npm run test:integration -- src/server/acceptance/browser-scheduling-integrity-fixture.integration.test.ts src/server/db/priority-groups-retirement-migration.integration.test.ts
```

Expected: setup/status/cleanup and both historical scenarios pass; final database/file/state residue is zero.
- [ ] Commit: `test: align capacity fixtures with fresh defaults`.

## Task 4: Update operation guides and complete acceptance

**Files**

- Modify: `README.md`, `database/README.md`, `docs/installation.md`, `docs/e2e.md`, `docs/current-policies.md`.
- Create: `docs/superpowers/evidence/2026-10-07-default-clinic-capacity-100.md` with actual verification results.

- [ ] Document the two independent default maximums of 100, Administrator configurability, migrate-before-seed ordering, and preservation of custom values on seed replay.
- [ ] Update active count/end-name statements to the 001–032 chain, exactly 32 first-applied migrations through 032 and 0 on replay. Keep old design/evidence files as historical records.
- [ ] Add the new capacity design/plan authority to the policy index, superseding default-150 guidance only. Describe previously seeded developer databases accurately: new defaults alone do not rewrite saved rows; ordinary first installation does not use reset.
- [ ] Search for remaining active assumptions using `rg -n '150|154|31|031_|max_daily_capacity|MAX_.*DAILY_CAPACITY' database scripts src README.md docs/installation.md docs/e2e.md docs/current-policies.md`. Classify each relevant hit; avoid blanket number replacement.
- [ ] Run the complete final gates once on final code, with a new owned target for each database command:

```bash
npx next typegen
npx tsc --noEmit --incremental false
npm run lint
npm test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run test:integration
npm run test:migrations:empty
npm run build
git diff --check
```

Expected: exit 0 for each command; all suites pass, the migration CLI reports 32/0 with the exact ledger, and owned database/storage cleanup succeeds. Use the repository's existing synthetic build/test environment and private storage requirements. Report a blocked command honestly; do not claim a production build or hosted CI pass from another gate.
- [ ] On an owned fresh local acceptance installation, migrate/seed/bootstrap/onboard using the existing workflow. Confirm the Administrator capacity page and settings GET both show 100/100; import the synthetic 101-row Standard file and inspect persisted 100/1 loads. Verify a occupied date is green at 99 and red at 100. Save one service to 120, refresh/reread, and verify the other stays 100. Restore through the normal settings flow and remove only owned fixtures.
- [ ] Verify the custom-150 First-Year scenario separately on the owned acceptance installation: choose a currently eligible Laboratory date, import a synthetic 280-row First-Year CSV with CPU capacity explicitly set to 150, confirm PE allocations of 150/130, then restore 100. Preserve the existing fixture's explicit-150 semantics; its historical fixed dates must not be mistaken for currently eligible dates. Never combine acceptance fixtures that mutate the same capacities concurrently.
- [ ] Record commands, actual exit codes/counts, 32/0 migration proof, UI/API observations and owned residue/restore results in the evidence file. Include no credentials or real student/medical data.
- [ ] Review the final diff against AC1–AC9. Confirm migrations 001–031 are unchanged, there is no appointment rewrite, new environment setting, hard-coded runtime cap or dependency drift.
- [ ] Commit: `docs: record default capacity 100 acceptance`.

## Completion boundary

Implementation is complete only when the spec's acceptance criteria have evidence. Commit/push the scoped product changes through the repository workflow; deployment remains a separate user request.

The document-only commit containing this plan and its spec does not run any task above or claim any product test has passed.
