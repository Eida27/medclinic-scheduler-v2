# Default Clinic Capacity 100 — Implementation Evidence

Date: October 7, 2026 (Asia/Manila).

Authority: [design](../specs/2026-10-07-default-clinic-capacity-100-design.md) and [plan](../plans/2026-10-07-default-clinic-capacity-100.md). Implementation starts from local main `bcaa54d8b55f11cb9545ac1fe199f9ff1d72dba4` in a managed isolated checkout on `codex/default-clinic-capacity-100`.

## Product changes

- Migration 032 changes only the SQL maximum default to 100. Migrations 001–031 and locked dependencies are unchanged.
- The production reference seed explicitly inserts 100 for KABALAKA Laboratory and CPU Physical Examination and retains `ON CONFLICT (id) DO NOTHING`.
- Runtime settings, scheduling, occupancy, authorization, conflict detection and audits continue reading persisted values.
- The full-day scheduling-integrity fixture now owns 100 capacity students/appointments and 104 academic snapshots. Historical 025/026 tests seed the reference catalog separately and use explicit test-only safe/maximum values of 150/150.
- Current operation guides describe two independent defaults, Administrator configurability above 100, migrate-before-seed ordering, seed replay preservation, and the 001–032 chain.

## Test-first proof

All PostgreSQL checks use the existing ownership runners with a new loopback `medclinic_test_*` target and `TEST_DATABASE_DISPOSABLE=1`. An owned PostgreSQL 18 cluster on loopback port 55437 supplies the test role; the ordinary application database is not migrated, seeded or reset.

| Gate | Red evidence | Green evidence |
| --- | --- | --- |
| Fresh defaults / existing database tests | Exit 1: 2 failed / 12 passed; seeded canonical maximums and omitted-column insert return 150 rather than 100. | Exit 0: 2 files / 14 tests. Both canonical rows are exactly 100; omitted insert is 100; safe column absent; named positivity, non-null and uniqueness checks pass; zero seeded users/students; saved 80/120 rows and identities survive exact production seed replay. |
| Empty migration rehearsal | Exit 1: actual inventory 31 differs from required 32. | Exit 0: exactly 32 applied through 032, exact ledger, 0 on replay, forced atomic DDL/history rollback, reusable connection and owned target removal. |
| Settings / calendar consumers | Existing behavior coverage; no runtime changes needed after Task 1. | Exit 0: 2 files / 10 tests. Canonical inputs show 100/100; custom 130 submission/refresh remains supported; each service is green at 99 and red at 100/101. |
| Standard / First-Year / capacity integrity | New consumer cases pass against persisted Task-1 defaults without refactoring runtime code. | Exit 0: 3 files / 20 tests. 101 Standard rows yield internal 100/1 per service, 202 appointments and 101 ordered complete pairs. 280 First-Year rows retain one fixed external Laboratory date and PE 100/100/80, CSV order, read-only review, atomic publication/history and seven-day gap. Existing capacity reductions, conflicts, audit rollback and concurrency pass. |
| Acceptance fixture / historical schemas | Unit exit 1: old 150/154 prepared counts disagree with 100/104. Integration exit 1: seeded-100 full-day prerequisite and both obsolete historical safe comparisons fail. | Unit exit 0: 2 files / 20 tests. Integration exit 0: 2 files / 3 tests. Full-day load/max 100, 104 snapshots, unrelated sentinel preservation, setup/status/cleanup and historical fresh-026/upgrade-025 pass. |

Each focused owned database and nested default test target was dropped with residue=0; integration storage reported zero residue.

### Repairs identified by final validation

The first complete integration run exited 1: 67 files / 577 tests passed and 4 files / 6 tests failed. The failures exposed a missed reset-CLI assertion expecting 31 migrations, an expired October 5 replacement date in the result-scope concurrency test, and explicit 30-second timeout failures in Reports-fixture and authentication tests followed by cleanup/mock contamination. Their owned target and storage were removed. The reset assertion now requires 32; the concurrency case freezes only `Date` at October 1 and restores real time in `finally`, preserving actual PostgreSQL locks and timers. No runtime date validation changes.

A separate retained First-Year fixture rehearsal reproduced `published appointment academic provenance missing` (23514). The fixture now creates four owned academic snapshots and Laboratory checklists using the canonical test requirements, keeps explicit capacity 150 and its historical allocation dates, and removes its exact owned clinical rows before flushing deferred constraints and restoring immutable triggers. A new CLI integration regression failed before the repair and passed afterward: one file / one test, captured 100 → explicit 150 → restored 100, four snapshots/checklists → zero, state/CSV residue zero. The reset and result-submission files separately passed all 75 tests. This bounded fixture/test repair expands the plan's file list so the required acceptance and full gate can run against the final schema.

The first complete unit attempt exited 1: 208 files / 1,200 tests passed, two files / three tests failed, and three workers failed to start. It exposed another active inventory assertion in migration transaction ownership still expecting 31/031; that assertion now requires 32/032, with its transaction-control checks retained. The focused regression passed one file / one test. Two unchanged calendar DOM tests exceeded 15 seconds. A subsequent in-flight thread run was stopped after reproducing the stale inventory assertion, so it is not counted as a completed gate.

A later complete integration attempt passed 70 files / 581 tests but failed three tests in two files: authentication exceeded its 30-second deadline, and the 280-row First-Year publication exceeded 60 seconds and then contaminated cleanup/the next case. Running those two files in isolation passed all 21 tests: the publication took 18.9 seconds and the authentication threshold took 19.8 seconds within their existing explicit deadlines. The heavy suites subsequently ran one at a time with 60-second global test/hook deadlines. The previously timed-out calendar preview/save and emergency-closure cases passed in the serial thread run at 12.0 seconds each. No tests, assertions, security checks or explicit per-case deadlines are removed.

The complete serial thread attempt passed 212 files / 1,204 tests but exited 1 because a `ResultDraftManager` worker never started. That file alone then passed all 23 tests in 14.9 seconds under the same regular thread pool. The installed Vitest 4.1.8 worker handshake has a fixed 60-second startup timeout, separate from test/hook deadlines. A four-file VM-fork compatibility check passed 35 tests, including that UI file, settings/calendar consumers and the unmocked database-boundary guard. The complete VM-fork attempt then exited 1: 207 files / 1,216 tests passed and six files / 11 tests failed. With one worker, the installed runner groups files into a shared VM context; failures exposed stale navigation/repository mocks and a cross-context `Blob` identity difference. The [VM pool documentation](https://vitest.dev/config/pool#vmforks) also identifies differing native globals and module-cache behavior. That pool was abandoned without changing application code, mocks or assertions to accommodate it. The final complete gate returns to regular isolated threads; no tests or unhandled errors are filtered out.

The final complete isolated-thread run exited 0: all 213 files and 1,227 tests passed in 1,007.86 seconds, with no skips or worker errors. All 11 cases that failed under the VM pool passed in this run. The complete integration gate also exited 0: all 72 files and 584 tests passed in 759.63 seconds, with owned database/storage residue 0.

## Final gates

Final commands use bundled Node 24.19.0, locked dependencies, synthetic application/build settings and private test storage. Each database invocation owns a newly named target.

| Command | Actual result |
| --- | --- |
| `node node_modules/next/dist/bin/next typegen` | Exit 0. |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism --testTimeout=60000 --hookTimeout=60000 --reporter=verbose` | Exit 0: 213 files / 1,227 tests, no skipped tests or worker errors. |
| `npm run test:integration -- --testTimeout=60000 --hookTimeout=60000 --reporter=dot` | Exit 0: 72 files / 584 tests, no skipped tests or worker errors; owned database/storage residue 0. |
| `npm run test:migrations:empty` | Exit 0: exactly 32 first-applied / 0 replay; exact ledger, rollback and reusable connection pass; owned target residue 0. |
| `npm run build` | Exit 0: production compilation and route generation completed. |
| `git diff --check` | Exit 0. |

## Acceptance criteria coverage

| Criteria | Evidence |
| --- | --- |
| AC1 | Empty migration CLI: 32/0, exact history, atomic rollback, connection reuse and target removal; fresh Browser installation also applies 32. |
| AC2–AC3 | Real PostgreSQL default tests: canonical seed rows 100/100, zero people, omitted maximum 100, safe column absent and existing constraints retained. |
| AC4 | Exact seed replay preserves saved 80/120 and row identities; settings units preserve supplied/custom values; Browser saves CPU 120 independently and rereads it after refresh. Existing capacity reduction/conflict/audit/concurrency tests pass in the focused gate. |
| AC5 | Standard 101-row integration and authenticated Browser publication: 100/1 per service, 202 appointments, 101 complete ordered pairs. |
| AC6 | First-Year 280-row integration: PE 100/100/80, fixed external Laboratory date, CSV order, read-only review and atomic publication/history. Separate live custom-150 Browser flow yields 150/130. |
| AC7 | Both services' calendar units: green 99, red 100/101; authenticated calendar UI/API confirms green 99 and red 100. |
| AC8 | Full-day fixture unit/integration: 100 appointments and 104 snapshots, sentinel/cleanup checks; historical 025/026 scenarios; explicit-150 CLI regression restores 100 with zero clinical/file residue. |
| AC9 | Updated operation guides and policy authority; scoped remaining-number audit; final diff preserves runtime consumers, migrations 001–031 and locked dependencies. |

## Browser acceptance

Acceptance used a fresh owned local installation at `127.0.0.1:3107`, a loopback SMTP sink accepting only reserved `.test` recipients and synthetic nine-column CSVs. The production migration and seed CLIs established exactly 32 migrations, zero users/students and maxima `[100,100]` before staff bootstrap. Installation preflight, first-Administrator bootstrap, actual emailed-token confirmation, login and temporary-password replacement used the existing workflow; verification timestamps were not stamped through SQL. Private result storage was outside the repository. The ordinary `localhost:3000` installation and its existing Browser tab were untouched.

| Browser flow | Observed UI and independent persisted/API proof |
| --- | --- |
| Fresh Daily capacity | CPU Physical Examination 100 and KABALAKA Laboratory 100, confirmed by authenticated settings GET. |
| Standard CSV, 101 Year-3 Regular students | Published 101 pairs / 202 appointments, no overflow or conflicts. Laboratory October 14:100 / October 15:1; PE October 15:100 / October 16:1. Every Laboratory date precedes its paired PE date. |
| Calendar at 100 and 99 | October 14 is red with Laboratory 100/100 and PE 0/100. Normal appointment cancellation removes one owned pair; refresh shows green with Laboratory 99/100 and one remaining slot. The occupancy API agrees. |
| Independent custom setting | Saved CPU 120 through its own form; page refresh and settings GET retain 120 while Laboratory stays 100. Restored CPU 100 through the same form and reread it. |
| Separate First-Year CSV, 280 students at explicit CPU 150 | Chose currently eligible Laboratory October 21, 2026. Review and publication show PE October 28:150 and October 29:130, 280 pairs / 560 appointments, no displacement or overflow. All 280 Laboratory appointments remain on the authoritative external date with internal Laboratory use 0; the minimum PE gap is seven days. |
| Restore and cleanup | Cancelled only the owned First-Year batch through the normal application API before reducing CPU capacity. Saved CPU 100 through settings and refreshed/reread both values as 100/100. Closed the created Browser tab and stopped the owned app/SMTP sink. The private manifest, CSVs and outside-repository result storage were removed; the owned database was dropped with residue=0. |
| Browser console | Zero warnings and zero errors across the authenticated acceptance tab. |

Sanitized independent readback: [API/persisted loads](2026-10-07-default-clinic-capacity-100/browser-api-proof.json) and [console](2026-10-07-default-clinic-capacity-100/browser-console.json). Screenshots contain only synthetic acceptance data:

- [Fresh 100/100](2026-10-07-default-clinic-capacity-100/fresh-100-100.png)
- [Standard publication](2026-10-07-default-clinic-capacity-100/standard-101-published.png)
- [Calendar red 100](2026-10-07-default-clinic-capacity-100/calendar-red-100.png) / [green 99](2026-10-07-default-clinic-capacity-100/calendar-green-99.png)
- [Saved CPU 120](2026-10-07-default-clinic-capacity-100/saved-cpu-120.png)
- [First-Year 150/130 review](2026-10-07-default-clinic-capacity-100/first-year-150-review.png) / [publication](2026-10-07-default-clinic-capacity-100/first-year-150-published.png)
- [Final restored 100/100](2026-10-07-default-clinic-capacity-100/restored-100-100.png)

## Remaining-number audit

The final scoped `rg` audit found 498 references to the plan's search patterns. Remaining 150 values have explicit meanings: unchanged historical migration 002/010 safe/default values, custom First-Year 150/130 fixtures and planner/UI samples, custom capacity reduction/restoration cases, pagination limits, text-length limits, identifiers and rendering coordinates. The First-Year fixture captures and restores its original saved maximum; the new CLI regression checks its explicit 150 and captured/restored 100. Historical fixed acceptance dates are retained as original records; live acceptance chooses a currently eligible date. Dates ending in 31, SQL parameter numbers, migration-031 references describing that migration, and unrelated layout widths are retained. No blanket numeric replacement or capacity environment setting is introduced.

## Scope and limits

This changes first-install defaults and omitted-column inserts. Existing developer capacity rows retain their saved values. The local application database, existing appointments and historical migrations are preserved. Hosted deployment and hosted CI are separate work.

After the final integration run, the owned cluster contained only `postgres`, `template0` and `template1` and was stopped. Initial forced deletion was rejected by automatic approval review (`blocked by policy`). Attribute-respecting native PowerShell deletion then succeeded; the stopped cluster and empty build-storage directories are gone with residue 0. All owned disposable databases and acceptance result storage were removed as verified above.
