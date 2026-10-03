# Predeployment Legacy and Dead Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Respect the execution method authorized in the implementation session.

**Goal:** Remove the confirmed obsolete code and contracts identified in the review while preserving the supported first-deployment application.

**Architecture:** Keep the current Next.js/PostgreSQL service boundaries and historical migration chain. Narrow Laboratory document handling, correct current API vocabulary, remove unused islands/tooling, and add two forward cleanup migrations. Preserve active scheduling, certificate, auth, notification and history systems.

**Tech Stack:** Repository-pinned Next.js 16.3.5, React 19.2.4, TypeScript, PostgreSQL/pg, Zod and Vitest; existing private storage, Sharp, PDF and SMTP integrations.

**Spec:** [2026-10-03-predeployment-legacy-cleanup-design.md](../specs/2026-10-03-predeployment-legacy-cleanup-design.md)

**Baseline:** `main` at `f202e5eda2a3a705b886cad2d268b894986abddc`. This is an unchecked implementation handoff, not completed product work.

## Global constraints

- The application has never been deployed and its production database is completely fresh.
- No production-data conversion, legacy-client support layer, backfill service, dual writes, or transition feature flags are required.
- Preserve migrations `001`–`029`; use forward cleanup migrations, not a second bootstrap schema or a squashed baseline.
- Preserve all seven behavior requirements in specification section 3 and every retention boundary in section 5.
- Student verification is required for Laboratory upload/edit work, not authenticated reading or official downloads.
- `max_daily_capacity > 0`; Laboratory precedes PE; First-Year retains the seven-calendar-day PE gap.
- Keep current encryption envelope `v1`, AAD, AES-GCM parameters and key requirements unchanged.
- Do not run developer reset or obsolete cleanup commands against an application database.
- Test database runners require explicit loopback `TEST_DATABASE_URL`, a new `medclinic_test_*` name and `TEST_DATABASE_DISPOSABLE=1`.
- Read `AGENTS.md` and relevant installed `node_modules/next/dist/docs/` guidance before changing framework code. Do not use remembered Next.js APIs in place of the installed version.

## Review focus

- A forged PE upload call must fail before any draft/file/result write; legitimate PE protection and certificates must survive (Task 2).
- A schema cleanup must not erase transaction-internal OVPSA states, document drafts, historical migration coverage or existing developer data (Tasks 5–6).
- A compliance filter must distinguish attendance from document state and preserve latest-appointment versus either-service semantics (Task 4).
- A test-only helper's passing tests must not be mistaken for coverage of the live clinical/report path (Task 1).
- A developer reset and disposable test must not accidentally share a live application target or a currently used integration database (Tasks 7–8).

---

## Preparation

- [ ] Read the spec, current policy index, root instructions and current branch diff. Preserve unrelated work. Use an isolated branch/worktree when needed under the repository's normal workflow.
- [ ] Compare the implementation HEAD with the review baseline. Recheck the listed symbols and live writers. If a finding was already fixed, record that evidence instead of reintroducing/removing code blindly.
- [ ] Install from the lockfile and record lint/typecheck/unit baseline results. Record any environment-only failures explicitly. Do not run destructive acceptance scripts to discover whether they work.
- [ ] Confirm migration numbers 030/031 are unused. If not, assign the next unused pair and update the spec/plan and all expected-ledger references together.

## Task 1: Remove confirmed unused islands and obsolete tooling

**Files:**

- Delete: `src/lib/retired-workflows.ts`.
- Delete: `scripts/browser-automated-scheduling-fixture.ts`.
- Delete: `scripts/db-reference-catalog-cleanup.ts`, `src/test/db-reference-catalog-cleanup.test.ts`, `src/test/db-reference-catalog-cleanup.integration.test.ts`.
- Delete: `public/file.svg`, `public/globe.svg`, `public/next.svg`, `public/vercel.svg`, `public/window.svg`.
- Modify: `src/server/services/priority-displacement.service.ts`, `src/server/laboratory/laboratory-requirements.ts`, `src/server/appointments/appointment-pair-integrity.ts`, `src/components/settings/clinic-calendar-draft.ts`, `src/lib/historical-compliance-report.ts`, `src/server/rule-engine/types.ts`.
- Modify: corresponding helper tests, `package.json`, `package-lock.json`, `README.md`, `database/README.md`.
- Preserve/extend as needed: `src/server/laboratory/laboratory-checklist.integration.test.ts`, `src/server/medical-certificates/certificate.integration.test.ts`, `src/server/repositories/historical-compliance-report.repository.integration.test.ts`, `src/test/reference-catalog.contract.test.ts`.

**Interfaces:** No new runtime interface. Keep all live exports in the affected modules. Keep `cancellationTargetsForPair`, paired-scheduler types, actual calendar draft operations and historical report parsers/labels.

- [ ] Recheck references for `nextDateAfter`, `LABORATORY_REQUIREMENTS_VERSION`, the two unused pair completion assertions, `calendarDraftKey`, `classifyHistoricalCompliance`, and the four unused generic capacity types listed in L09. Distinguish local uses from external exports.
- [ ] Check live regression coverage for incomplete Laboratory blocking PE, completed/certificated PE blocking Laboratory rollback, and all five historical compliance classifications. Add missing cases to the actual service/repository tests and establish their baseline; do not keep an unused duplicate function just to make its tests pass.
- [ ] Delete the confirmed declarations and their obsolete direct-helper tests, keeping unaffected tests in mixed files. Delete the two obsolete scripts and dedicated catalog-conversion tests. Preserve seed/migration catalog tests and current guarded fixtures.
- [ ] Remove `db:reference-catalog-cleanup` from package scripts and remove its current operating instructions. Remove the five starter assets and `@vitejs/plugin-react`; regenerate the lockfile without unrelated upgrades.
- [ ] Run typecheck, affected unit tests and the affected disposable integration tests. Search source/current scripts/current guides for imports or commands pointing at the deleted files; historical design mentions may remain with an appropriate supersession note.
- [ ] Commit: `refactor: remove unused helpers and obsolete predeployment tooling`.

## Task 2: Make document persistence Laboratory-only

**Files:**

- Modify: `src/server/repositories/student-result-submissions.repository.ts`, `src/server/services/student-result-submissions.service.ts`, `src/server/appointments/appointment-result-protection.ts`, `src/server/student-results/admin-student-result-profile.ts`.
- Modify: `src/components/admin-results/StudentResultSection.tsx`, `src/components/admin-results/SubmissionHistory.tsx` and affected result page/API consumers when their DTOs change.
- Test: `src/server/services/student-result-submissions.integration.test.ts`, `src/server/repositories/student-laboratory-documents.integration.test.ts`, `src/server/repositories/student-result-submission-profiles.integration.test.ts`, `src/server/appointments/appointment-result-protection.test.ts`, existing student result route/page tests and certificate integration tests.

**Interfaces:**

- Persisted submission/draft/file DTOs use `resultType: "LABORATORY"`; shared appointment/service DTOs remain two-service models.
- Preserve `finalizeStudentResultDraft(client: PoolClient, submission: { id: string; appointmentId: string; studentNumber: string; resultType: "LABORATORY" }, fileCount: number, totalBytes: number): Promise<void>`.
- Preserve `invalidateFinalizedSubmissionMetadata(client: PoolClient, submission: { id: string; appointmentId: string; resultType: "LABORATORY" }, actorUserId: string, reason: string): Promise<void>`.
- `AdminStudentResultProfile` retains `laboratory`, `certificate`, `history`, identity and progress; remove its PE upload section. `PENDING_PLACEHOLDER.table` is only `"laboratory_results"`.

- [ ] Add/update live tests named for PE upload rejection and forged wrong-service repository input. Assert the existing PE-upload 422 error contract and zero changes to submissions, file/storage entries, `exam_results`, cleanup intents and notifications.
- [ ] Add/update profile assertions: history contains Laboratory submissions; the certificate card still uses the separate certificate projection; a valid issued certificate remains downloadable by its owner and authorized staff.
- [ ] Narrow upload types and SQL to Laboratory. Remove dynamic upload result-table selection and PE submission joins/counts/branches; keep runtime wrong-service validation before the first mutation.
- [ ] Preserve certificate-aware shared protection reads, remove only the impossible PE pending-placeholder branch, and retain Laboratory pending-placeholder cleanup.
- [ ] Run the focused upload, ownership, verification-before-body, edit/revision, invalidation, certificate and clinical-protection tests. Verify initial Laboratory finalize, edit promotion, invalidation and resubmission still behave identically.
- [ ] Commit: `refactor: separate laboratory submissions from physical exam certificates`.

## Task 3: Remove compatibility aliases without changing live behavior

**Files:**

- Modify: `src/server/appointments/automatic-no-show.ts`, `src/server/email/verification-body-encryption.ts` and every alias consumer in services, fixtures and tests.
- Modify: `src/server/students/student-display-name.ts`, `src/server/repositories/students.repository.ts`, `src/server/repositories/appointments.repository.ts`, `src/server/repositories/appointment-summary.repository.ts`.
- Test: `src/server/repositories/appointment-no-show.integration.test.ts`, `src/server/email/verification-body-encryption.test.ts`, student/staff email/outbox integration tests and existing name-search tests.

**Interfaces:**

- Keep `isAutomaticNoShowLog(log: AutomaticNoShowLog | null | undefined): boolean` and the current `AUTOMATIC_NO_SHOW_NOTE`.
- Keep canonical `encryptEmailOutboxSensitiveBody`/`decryptEmailOutboxSensitiveBody` signatures unchanged; remove only `encryptVerificationEmailBody`/`decryptVerificationEmailBody` aliases.
- Rename `studentLegacyDisplayNameSql(alias: string)` to `studentInitialDisplayNameSql(alias: string)` with identical SQL semantics.

- [ ] Change the old 24-hour note test to expect `false`; retain current-note `true`, null/undefined `false`, wrong actor/status `false`, and clinical correction tests. Establish the intentional failure before changing the recognizer.
- [ ] Remove the old constant/branch. Migrate encryption callers and tests to canonical names, then remove aliases. Preserve known-ciphertext/deterministic-IV and tamper-rejection assertions.
- [ ] Rename the initial-name helper and internal SQL search aliases specified in the design; retain all supported name and suffix searches.
- [ ] Run no-show, encryption and search tests, then email/clinical integration coverage. Confirm no ciphertext-format, worker schedule or correction-policy change beyond refusing the obsolete note.
- [ ] Commit: `refactor: remove obsolete aliases and no-show compatibility`.

## Task 4: Correct the retained compliance contract

**Files:**

- Modify: `src/app/api/compliance/route.ts`, `src/server/repositories/current-effective-appointments.repository.ts`, `src/server/repositories/tracking.repository.ts`, `src/server/repositories/appointment-summary.repository.ts`, `src/components/appointments/appointment-summary.ts`.
- Test: `src/app/api/compliance/route.test.ts`, `src/server/repositories/appointment-summary.integration.test.ts`, `src/server/repositories/appointment-summary.repository.test.ts`, `src/server/services/tracking.integration.test.ts`.

**Interfaces:** Export a readonly `ATTENDANCE_STATUSES` tuple containing the exact seven values in spec section 6.2; derive `AttendanceStatus` from it and consume it in Zod validation. `OverallStatus` is `"COMPLETE" | "INCOMPLETE"`. Rename the internal `legacyAppointmentStatus` property to `latestAppointmentStatus`; public query parameter names and response shape remain unchanged.

- [ ] Add route tests accepting the current attendance vocabulary and rejecting each old service filter (`PENDING_UPLOAD`, `REQUIRES_FOLLOW_UP`, `NOT_APPLICABLE`) and overall `FOLLOW_UP` with 422, without repository access on rejection.
- [ ] Keep/update the mixed-pair integration case: when Laboratory is pending and the latest PE is completed, ordinary either-service `PENDING` matches, retained compliance latest `PENDING` does not, and latest `COMPLETED` with the correct clinic matches.
- [ ] Implement the shared vocabulary and rename the internal filter. Keep the retained endpoint, current effective/year predicates, authentication and pagination.
- [ ] Run the route/unit and focused repository integration tests. Verify current search and both service filters yield actual matching records rather than upload-era empty results.
- [ ] Commit: `fix: align compliance filters with current attendance states`.

## Task 5: Remove deprecated safe capacity storage

**Files:**

- Create: `database/migrations/030_remove_safe_daily_capacity.sql`.
- Create: `src/server/db/predeployment-cleanup-schema.integration.test.ts`.
- Modify: `src/server/repositories/appointments.repository.ts`, `database/seeds/001_reference_and_users.sql`, `src/test/capacity-fixture-lifecycle.ts`, affected current fixtures/tests and `scripts/db-migration-empty-database-test.ts`.

**Interfaces:** `updateCapacitySetting(clinicCode, scheduleType, max, client)` and user-facing `maxDailyCapacity` remain unchanged. Final schema has only the maximum capacity value, with `clinic_capacity_settings_max_daily_capacity_positive` enforcing `> 0`.

- [ ] Add database assertions that `safe_daily_capacity` is absent in the final schema, maximum 1 is valid, and 0/negative values fail. Exercise the actual capacity update service and fixture restore behavior.
- [ ] Add the forward migration, retaining historical files byte-for-byte. Do not use `CASCADE` or replace the table.
- [ ] Update current seed/writers/fixture snapshots/restoration to use only the maximum. Retain old-column references solely in explicit earlier-migration tests.
- [ ] Update the empty-rehearsal ledger/count to include 030 for this independently passing commit. Run capacity, concurrency, Standard/First-Year import and closure integration tests plus the empty migration rehearsal.
- [ ] Commit: `refactor: remove deprecated safe capacity column`.

## Task 6: Retire persisted manual-scheduling metadata

**Files:**

- Create: `database/migrations/031_retire_manual_schedule_metadata.sql`.
- Modify: `src/server/repositories/schedule-imports.repository.ts`, `src/server/services/schedule-imports.service.ts`, `src/components/schedules/ScheduleImportClinicPanel.tsx`, `src/components/schedules/ScheduleImportHistoryTable.tsx`, `src/app/(dashboard)/students/schedule-imports/[importId]/page.tsx`.
- Modify tests/fixtures: existing import detail/lifecycle/schema/component tests, new cleanup schema integration test, current fixture builders that omit required import metadata, and `scripts/db-migration-empty-database-test.ts`.

**Interfaces:** `ScheduleImportStatus = "PUBLISHED" | "CANCELLED" | "NEEDS_REVIEW"`. Import list/detail category and academic year are non-null; obsolete override/week/validation-issue fields are removed. The existing atomic import service entrypoints and successful validation/publication evidence remain.

- [ ] Add database tests for the exact table/column/state contracts in spec section 6.4. Add a migration-isolation test that creates unsupported staged/metadata rows after 030 and proves `UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA`, no partial schema changes and no 031 ledger entry.
- [ ] Implement the migration's precondition guard, nullability, status constraints and narrow column removals. Preserve OVPSA tables/states, appointment `DRAFT`, Laboratory draft state and all provenance relationships.
- [ ] Remove corresponding obsolete DTO/UI branches and status presentation. Keep successful validation summaries and `NEEDS_REVIEW`; remove missing-category/year fallbacks and update First-Year validation copy exactly as specified.
- [ ] Repair current fixture builders by supplying valid current data. Do not disable constraints or weaken a test to keep an invalid legacy fixture working. Keep intentionally old-schema cases isolated at their correct migration boundary.
- [ ] Run Standard/First-Year import, post-publication First-Year lifecycle, import history, provenance, closure/replacement and capacity tests. Confirm atomic failure leaves no partially published import and OVPSA internal `DRAFT`/`VALIDATED` writes still succeed inside their transactions.
- [ ] Update final rehearsal count/end-name to 31/031. Commit: `refactor: retire persisted manual scheduling metadata`.

## Task 7: Consolidate the developer reset migration executor

**Files:** Modify `scripts/db-reset.ts`; create `scripts/db-reset.integration.test.ts`; keep `scripts/db-migration-runner.ts` and its current transactional tests.

**Interfaces:** Reuse `runMigrations(client: MigrationClient, migrations: MigrationFile[], log?): Promise<string[]>`. Keep existing reset consent, protected database-name checks, command name and reference seeding order.

- [ ] Replace the handwritten ledger and SQL application loop with the canonical runner after the explicitly authorized developer schema reset. Do not change installation to use reset.
- [ ] Test reset only in a separately owned disposable database created by `withDisposableTestDatabase`, with its own unique target, never the enclosing suite's shared database. Assert the complete current ledger and canonical seed after the CLI succeeds; a second explicit developer reset produces the same empty operational/reference state.
- [ ] Assert missing consent and protected names are rejected before connecting/destructive work. Retain the existing migration-runner failure/rollback and empty-rehearsal tests as the transaction proof.
- [ ] Run those focused tests. Commit: `refactor: reuse transactional migration runner in developer reset`.

## Task 8: Align operational docs, CI and final evidence

**Files:** Modify `README.md`, `database/README.md`, `docs/installation.md`, `docs/e2e.md`, `docs/current-policies.md`, `.github/workflows/unit-tests.yml`; add a dated implementation evidence file under `docs/superpowers/evidence/`.

**Interfaces:** Supported install uses preflight → `db:migrate` → `db:seed` → first administrator bootstrap/onboarding → academic-year configuration. The existing disposable runners remain the only integration/migration test setup entrypoints.

- [ ] Update current docs to 31 migrations through 031 and zero replay, reflect actual command availability and max-only fixtures, distinguish developer reset, and index the September 27 design. Add precise historical notices where old plans otherwise appear authoritative.
- [ ] Retain Windows/Linux unit CI; add lint/typecheck and a Linux PostgreSQL service job. Use explicit disposable names, consent and synthetic configuration; choose a fresh database name for each migration/integration invocation. Do not use an existing application database or real-recipient SMTP settings.
- [ ] Run the final gates and record exit codes:

```text
npm ci
npm run lint
npx tsc --noEmit
npm test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run test:migrations:empty
npm run test:integration
npm run build
```

The database commands require the explicit disposable environment above. Build/preflight/browser checks require dedicated synthetic configuration and private test storage; never commit an environment file or credential. If generated Next types are needed for typecheck, generate them using the installed framework's documented command before that gate.

- [ ] Perform the browser journeys in spec section 7 using supported fixtures: Standard and First-Year import, First-Year lifecycle, checklist/PE dialog/certificates, Laboratory revisions, batch manual recovery, and unverified reading versus verified upload. Capture representative narrow-screen and download behavior.
- [ ] Finish a source/command/schema removal audit. Exclude unchanged historical migrations/docs and negative tests when interpreting old strings; do not set an indiscriminate “zero legacy words” goal. Check dynamic workers, CLI/config entrypoints and active APIs before accepting any additional deletion.
- [ ] Record the final commit, commands, passing/failing counts, fixture ownership/cleanup proof, browser evidence and remaining limits. Do not reuse this review's baseline checks as proof of the implementation. Commit: `docs: align first deployment guidance and verify legacy cleanup`.

## Completion checklist

- [ ] Every L01–L13 finding is implemented or demonstrably already resolved at the implementation HEAD, with a recorded reference.
- [ ] Current behavior and explicitly retained systems pass their acceptance criteria.
- [ ] Migration history is unchanged, forward migrations are atomic, and unsupported existing data is refused rather than rewritten/deleted.
- [ ] Obsolete tests are removed only where the associated obsolete behavior is removed; live clinical, identity, history and storage coverage remains.
- [ ] Final guides/CI/ledger agree and all unresolved failures are disclosed.
- [ ] The final diff contains no unrelated user work, credentials, generated environment files, private clinical data or local fixture artifacts.
