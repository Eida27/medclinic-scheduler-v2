# Predeployment Legacy and Dead Code Cleanup — Design Specification

- Date: 2026-10-03 (Asia/Manila)
- Repository: `Eida27/medclinic-scheduler-v2`
- Reviewed branch: `main`
- Reviewed commit: `f202e5eda2a3a705b886cad2d268b894986abddc`
- Status: Proposed implementation specification; this documentation commit does not implement the cleanup.
- Implementation checklist: [2026-10-03-predeployment-legacy-cleanup.md](../plans/2026-10-03-predeployment-legacy-cleanup.md)

## 1. Objective and deployment assumptions

Remove obsolete executable paths, unreachable code, superseded data contracts, and outdated operational tooling before the first production deployment. Preserve the current scheduling, clinical, authentication, reporting, and notification behavior.

The owner explicitly states that the application has never been deployed and its production database is completely fresh. No production-data conversion, legacy-client support layer, backfill service, dual writes, or transition feature flags are required. This assumption does not authorize deleting a developer's existing database, private files, or local work.

This specification defines the cleanup Codex should implement. It is not a deployment approval or a claim that the application is now free of defects. Reconcile this document against the implementation branch before editing: the evidence below is pinned to the reviewed commit.

## 2. Review coverage and evidence limits

The review inventoried all 781 tracked files, including 657 TypeScript/TSX files, 84 API route handlers, 36 pages, 29 SQL migrations, the reference seed, package/lock/configuration files, scripts, CI, public assets, and documentation. Repository-wide text and import/export reference scans were supplemented by manual tracing of the suspected leftovers into their actual callers, writers, database constraints, and current design authorities. There are 211 ordinary test files and 69 integration test files.

| Area | Review performed | Result |
| --- | --- | --- |
| UI, routes, proxy and workers | Framework entrypoints, dynamic imports, component consumers, obsolete redirects and contracts | Most previously retired routes are already absent; worker registration and callable APIs remain live |
| Services and repositories | Import/export references, SQL reads/writes, upload and certificate boundaries, scheduling lineage | Confirmed dead helpers and mixed old/new result contracts remain |
| Database and install tooling | All migration files inventoried; schema changes, current writers, seed and runner paths traced | Deprecated capacity storage and staged-import metadata remain; historical migration chain is still required |
| Tests and fixtures | Ordinary suite run; fixture scripts and old-schema assumptions inspected | An unreferenced fixture still targets the removed calendar schema; some helpers are exercised only by their own tests |
| Dependencies, assets and docs | Direct dependency references, asset references, operational instructions and current-policy index | One unused Vite plugin, five starter SVGs, and contradictory installation guidance found |

Baseline verification in this review checkout:

- `npm ci --ignore-scripts --no-audit --no-fund`: completed from the committed lockfile. Dependency lifecycle scripts were deliberately not run during this review.
- `npm run lint`: exit 0.
- `./node_modules/.bin/tsc --noEmit --incremental false`: exit 0.
- `npm test -- --maxWorkers=2 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000`: 209 files passed, 2 failed; 1,218 tests passed and 5 failed. Failures were the subprocess-based preflight cases and loopback SMTP listener cases under execution-sandbox restrictions.
- Rerunning `scripts/installation-preflight.test.ts` and `scripts/loopback-smtp-sink.test.ts` with subprocess/loopback access: both files and all 9 tests passed, exit 0. This is split-run evidence, not a claimed single all-green aggregate run.
- Production build, database integration/migration execution, browser acceptance, real SMTP delivery, and deployment rehearsal were not performed in this review. They are implementation acceptance gates below.

Static reference analysis is candidate discovery, not proof that every unimported export is dead. Next route/page exports, configuration entrypoints, `src/instrumentation.ts`, dynamic worker imports, CLIs, SQL triggers, types used locally, and dependencies resolved by tools require separate treatment. Binary evidence images and templates were inventoried; this was not a pixel-by-pixel asset or dependency-advisory audit.

## 3. Current behavior that cleanup must preserve

The [current policy index](../../current-policies.md), September 22 clinical design, September 27 workflow design, and September 29 student-access design remain the behavioral authorities except for the specific cleanup contracts changed here.

1. Standard Regular/OJT/Tour imports and First-Year/OVPSA imports publish atomically. Only configured academic years are selectable. Preserve FCFS/category rules, Manila dates, maximum capacity, Laboratory-before-PE ordering, cycle bounds, and First-Year external Laboratory accounting and seven-calendar-day PE gap.
2. Preserve immutable academic snapshots, import provenance, appointment pairs and lineage, partial Laboratory progress, manual locks, protected results, closure impact review, Manual Resolution and atomic batch replacement/recovery. Emergency closures remain manual; retain the current notice-period policy.
3. Laboratory clinical completion uses CBC, Urine, Stool and applicable X-ray. X-ray applies to first-year students and fourth-year OJT students. Document submission remains separate from clinical completion.
4. PE completion uses the completion dialog, physician/classification selection and immutable private JPG certificate transaction. Preserve correction, revocation, staff history, request replay/idempotency, ownership checks and authorized downloads.
5. Authenticated active students can read Schedule, history, Notifications and Results and download their official files/certificates before email verification. Verification is required for every Laboratory upload/edit workspace and mutation, checked from the current database before body processing. Preserve staff onboarding, session separation, throttling, return-path validation and token protections.
6. Preserve private storage authorization, revision visibility, cleanup intents, encrypted email bodies, notification deduplication, retries, current-state catch-up and the three registered workers.
7. Preserve administrator-only historical Reports/PDF behavior and deleted-staff audit identity. Keep legitimate date-only appointments and historical records; “historical data” is not synonymous with legacy code.

## 4. Findings and required disposition

Priorities describe implementation order/risk, not a vulnerability severity rating. Line references refer to the reviewed commit and are navigational hints.

| ID | Priority | Evidence | Disposition |
| --- | --- | --- | --- |
| L01 | P1 | `scripts/browser-automated-scheduling-fixture.ts:1–22,198–215` connects through application `DATABASE_URL`, uses old fixed staff IDs and writes `clinic_unavailable_dates(clinic_id,start_date,end_date,...)`, removed by migration 014. No current package script, current guide or code imports it. | Delete the obsolete fixture; preserve the current guarded fixtures and cross-feature integration test |
| L02 | P1 | `scripts/db-reference-catalog-cleanup.ts`, its package command, two dedicated tests, `README.md:157–175` and `database/README.md` maintain a destructive old-catalog conversion workflow | Remove the executable old-database conversion tool and current operating instructions; retain canonical seed and migration 012's historical checks |
| L03 | P1 | Migration 028 restricts `student_result_submissions.result_type` to Laboratory, but `student-result-submissions.repository.ts:25–90,483–491,811–820,1038–1119,1642–1647` still models PE uploads, queries PE submission counts, and selects an upload result table dynamically | Make upload storage/mutations Laboratory-only and separate PE certificate projections; retain shared clinical protection reads and `exam_results` |
| L04 | P2 | `src/app/api/compliance/route.ts:13–15` accepts upload-era result filters and `FOLLOW_UP`, while `appointment-summary.repository.ts:69–94` returns attendance statuses and only `COMPLETE`/`INCOMPLETE` | Correct the retained API's filter vocabulary and shared types; preserve its latest-appointment filtering semantics |
| L05 | P2 | Migration 010 calls `safe_daily_capacity` deprecated; `appointments.repository.ts:629`, the seed and many fixtures still write it | Remove the column with a forward migration and retain an explicit positive maximum constraint |
| L06 | P2 | `schedule-imports.repository.ts:28–47,94–108,212–235`, import history/detail UI and `ScheduleImportClinicPanel.tsx` still expose staged states, missing-category/year fallbacks and unused manual week/override/validation-issue metadata | Retire those persisted manual-scheduling contracts, with the narrow schema and presentation changes in section 6 |
| L07 | P2 | No callers of `src/lib/retired-workflows.ts`; `nextDateAfter` in `priority-displacement.service.ts:655` and `LABORATORY_REQUIREMENTS_VERSION` in `laboratory-requirements.ts:4` have no uses | Delete the helper file and these unused declarations |
| L08 | P2 | Only tests call the two completion assertions in `appointment-pair-integrity.ts:25,38`, `calendarDraftKey` in `clinic-calendar-draft.ts:16`, and `classifyHistoricalCompliance` in `historical-compliance-report.ts:124` | Remove test-only alternatives after keeping their meaningful assertions on the live clinical/report/calendar paths |
| L09 | P2 | `rule-engine/types.ts:3–20` contains the isolated `AppointmentScheduleType`/`CapacityStatus`/`CapacitySetting`/`CapacityCheckResult` family left after the generic capacity engine was removed | Remove only this unused family; keep paired-scheduler types and active capacity checks |
| L10 | P2 | `automatic-no-show.ts:4–5,21` accepts the superseded 24-hour note; `verification-body-encryption.ts:71–73` retains aliases used by otherwise current callers | Remove the old no-show recognition branch; migrate callers to canonical encryption names and delete aliases without changing encryption format |
| L11 | P2 | `scripts/db-reset.ts` independently creates the migration ledger and executes SQL without the transaction-owning `runMigrations` path | Keep the guarded developer command but delegate migration execution to the canonical runner; do not execute a reset as part of this review/cleanup |
| L12 | P3 | `@vitejs/plugin-react` is declared but neither Vitest config uses it; `public/{file,globe,next,vercel,window}.svg` have no application references | Remove that direct dev dependency and the five unused starter assets; regenerate lockfile normally |
| L13 | P3 | `database/README.md:10` says 28 migrations while the checked-in runner expects 29; current guides advertise L02, and the policy index omits the September 27 design from its authority table | Align current docs with implemented cleanup; annotate superseded guidance without rewriting evidence |

Two additional uses of the word “legacy” should become accurate names, not feature deletions:

- `studentLegacyDisplayNameSql` generates useful middle-initial search text from current names. Rename it to `studentInitialDisplayNameSql` and update the three repository consumers. Preserve full-name, middle-initial, first/last and suffix search behavior. Rename the internal summary aliases to `studentInitialDisplayName`, `studentGivenNameFirst` and `studentFullNameGivenFirst`.
- Rename `AppointmentSummaryFilters.legacyAppointmentStatus` to `latestAppointmentStatus`. Keep the public `/api/compliance?appointmentStatus=...` parameter and its current latest-appointment semantics. The ordinary summary's `appointmentStatus` filter continues to match either service.

## 5. Removal boundaries and false positives

The following are explicitly retained:

- Migrations `001`–`029`: these establish the current schema and support regression proofs. Prior designs expressly retain them. Use forward cleanup migrations, not a second bootstrap schema or a squashed baseline. Old names inside historical SQL are not a second active scheduling system.
- `schedule_batches` and `coordinator_schedule_items`: both Standard and First-Year atomic imports currently write them; appointments and provenance depend on them.
- `ovpsa_first_year_*`, the separate First-Year planning code, list/detail/reschedule/cancel APIs and reservation-restoration lifecycle: these have current consumers or intentionally retained API contracts. The September 7 design explicitly retains callable APIs even without UI consumers.
- `/api/compliance`, `/api/appointments`, `/api/dashboard` and other callable routes: absence of a `fetch()` reference is insufficient grounds for deletion. L04 corrects `/api/compliance`; it does not remove or merge it into administrator Reports.
- `exam_results`: certificate issue/revoke operations and consistency triggers use this table. Remove PE *upload* branches, not PE clinical records.
- `DRAFT` for student document editing, appointment capacity holds and transaction-internal OVPSA batch/revision construction; `VALIDATED` for transaction-internal OVPSA revisions. Section 6 narrows only the old generic persisted scheduling contract. Preserve `AWAITING_RESCHEDULE`, `SUPERSEDED`, `INVALIDATED`, `OBSOLETE` outbox status and clinical `REQUIRES_FOLLOW_UP` where live.
- Canonical CPU reference catalog, `db:migrate`, `db:seed`, administrator bootstrap, preflight, the guarded disposable database/storage harness and current acceptance fixtures.
- `react-dom`, type packages, Tailwind/PostCSS, PDF fonts, Sharp, ZIP support, `exceljs` and `jszip` template-validation dependencies. They have framework/tool/test consumers. `pdfjs-dist/legacy/build/pdf.mjs` is a used dependency entrypoint, not proof of an obsolete application subsystem.
- Historical design/evidence files, CPU branding, CSV/XLSX templates, authentication redirects, and the currently used submission-detail redirect.

The ignored directories mentioned in the latest evidence commits belonged to an earlier local machine/session. They are not tracked repository code. Do not attempt to delete them or reinterpret that earlier approval rejection as a reason to change application behavior.

## 6. Target design

### 6.1 Laboratory submissions and PE certificates

Narrow stored submission/draft/file metadata and mutation inputs to `resultType: "LABORATORY"`. `finalizeStudentResultDraft` and `invalidateFinalizedSubmissionMetadata` must operate on `laboratory_results` directly and reject a wrong service before writing; TypeScript narrowing alone is insufficient for a forged runtime call. Maintain the service/route denial for a PE upload request and its existing error contract.

Remove upload-specific PE branches from draft creation/loading, edit/finalize/invalidate operations, profile list joins/counts, history models and labels. A PE upload must never create a draft, stage a file, modify `exam_results`, or enqueue cleanup/notification work. Keep Laboratory draft/revision/invalidation behavior unchanged.

Make `AdminCurrentResultSection` and `AdminResultSubmission` describe Laboratory documents. Remove the unused `physicalExam` upload section from `AdminStudentResultProfile`; keep its separate `certificate` projection and the PE certificate card/download. Generic appointment/service types and the student Results certificate projection still support both clinical services.

Keep certificate-aware shared protection in `getAppointmentResultProtectionStates` and `getAppointmentResultCorrectionState`. `PENDING_PLACEHOLDER` can name only `laboratory_results` after migration 028; the PE `PENDING_UPLOAD` deletion branch is impossible and must be removed. An issued/revoked certificate or protected PE result must still prevent an unsafe Laboratory rollback or displacement.

### 6.2 Retained compliance API

Create a single current attendance vocabulary in the existing current-effective-appointments module: `PENDING`, `COMPLETED`, `NO_SHOW`, `RESCHEDULED`, `CANCELLED`, `AWAITING_RESCHEDULE`, `UNSCHEDULED`. Use it to validate the API's service and appointment status filters and to type the summary inputs. Keep the SQL's current effective/year scope.

`overallStatus` accepts only `COMPLETE` or `INCOMPLETE`. Reject old upload values `PENDING_UPLOAD`, `REQUIRES_FOLLOW_UP`, `NOT_APPLICABLE` and the old overall filter `FOLLOW_UP` with the ordinary 422 validation response. Do not silently map clinical findings to attendance. Preserve authentication, pagination, search, clinic filtering and the latest-versus-either-service distinction described above. Do not broaden clinical access or change administrator Reports authorization.

### 6.3 Capacity migration

Add `database/migrations/030_remove_safe_daily_capacity.sql` at this baseline. Add `clinic_capacity_settings_max_daily_capacity_positive CHECK (max_daily_capacity > 0)` before removing `safe_daily_capacity` and its obsolete comparison constraint. Keep `max_daily_capacity` non-null, defaults, uniqueness and service/clinic identity intact. No data rewrite or `CASCADE` is required.

Update current writers, seed, shared capacity restoration helpers, fixtures and final-schema tests together. Historical migration-isolation tests may still mention the old column when they intentionally exercise a pre-030 schema. They must not introduce a compatibility writer into current application code.

### 6.4 Persisted import contract migration

Add `database/migrations/031_retire_manual_schedule_metadata.sql` after 030. This is deliberately distinct from the active in-transaction OVPSA construction states.

| Object | Final contract |
| --- | --- |
| `schedule_import_groups.student_category` | Non-null `REGULAR`, `OJT` or `TOUR`; retain existing mode/category/month rules |
| `schedule_import_groups.academic_year_start` | Non-null; preserve existing range and provenance protections |
| `schedule_batches.status` | Only `PUBLISHED` or `CANCELLED`; remove the `DRAFT` default and require explicit writes |
| `schedule_batches.override_reason`, `overridden_by`, `overridden_at` | Remove; drop their obsolete completeness constraint |
| `coordinator_schedule_items.target_date` | Non-null authoritative imported service date |
| `coordinator_schedule_items.target_week_start`, `target_week_end` | Remove, together with the obsolete target-choice/week-order constraints |
| `coordinator_schedule_items.status` | Only `SCHEDULED`; remove the `PENDING` default and require explicit writes |
| `coordinator_schedule_items.validation_issues` | Remove the unused persisted failed-validation collection |

Do not remove successful `validation_summary`, `validated_by/at`, `published_by/at`, source-row order, cycle, relationships or audit records. Validation/review failures must still be returned before publication; successful immutable provenance remains useful.

The migration must fail atomically with `UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA` if it encounters retired staged states, missing required provenance/date, nonempty validation issues or populated manual override/week fields. Do not discard those values, fabricate a category/year, convert a draft to published, or reset a database. Fresh installation contains no such records and passes. Disposable tests may construct old data specifically to prove refusal and rollback.

Remove matching repository projections, dead view types, obsolete status colors, exception/capacity-warning rendering with no surviving writer, and “Legacy import”/“Legacy”/“No academic year” fallbacks. Use non-null current DTOs. `ScheduleImportStatus` becomes `PUBLISHED | CANCELLED | NEEDS_REVIEW`; preserve `NEEDS_REVIEW` as a defensive inconsistent-child-state result, not a revived staging workflow. First-Year remains mode `FIRST_YEAR_OVPSA` with stored category `REGULAR`; replace “compatibility category” validation copy with “First Year imports use the Regular category.”

### 6.5 Dead code, aliases and tooling

Delete L07–L09's confirmed islands. Do not delete a whole module merely because some exports are unused: pair cancellation, calendar draft state, report labels/parsers and paired scheduling remain live. Move meaningful test expectations onto the live service/repository path before deleting test-only alternatives. Do not add new tests whose only purpose is asserting that an unused constant/file disappeared.

Use `encryptEmailOutboxSensitiveBody` and `decryptEmailOutboxSensitiveBody` everywhere, including student/staff verification, outbox delivery, fixtures and tests. Preserve the `v1` envelope, AAD, AES-GCM parameters, key requirements, error handling and deterministic/tamper tests. No encryption-key rotation or ciphertext conversion is part of cleanup.

Remove `LEGACY_AUTOMATIC_NO_SHOW_NOTE` and its recognition branch. Keep the current Manila-midnight note and the existing actor/status checks. Verify current automatic no-shows can still be corrected with the required reason; the old 24-hour note and manually authored no-shows must not qualify.

Delete L01's fixture and L02's command/script/dedicated tests. Preserve catalog identity assertions on migration 012 and the reference seed. Current integration fixtures already provide disposable database ownership and supported synthetic journeys.

Retain `db:reset` only as the existing explicitly guarded developer action. Replace its duplicate migration loop/ledger initialization with `runMigrations`; keep reset consent, protected-database refusal and seeding order. Document that this is not an installation or upgrade step. Never run it on the application database to validate this cleanup.

Remove the unused Vite React plugin and starter SVGs. Do not perform unrelated dependency upgrades or classify transitive npm deprecation notices as confirmed application vulnerabilities.

### 6.6 Documentation and CI

Update `README.md`, `database/README.md`, `docs/installation.md`, `docs/e2e.md` and `docs/current-policies.md` when implementation lands. The fresh path is preflight, migrations, reference seed, first administrator bootstrap/onboarding, configured academic year and acceptance. Remove the old catalog-conversion runbook; distinguish developer reset from installation.

At this baseline, final rehearsal applies exactly 31 migrations through `031_retire_manual_schedule_metadata.sql`, then 0 on replay. Update `scripts/db-migration-empty-database-test.ts` and every current count/end-name statement. If the implementation branch already contains a new migration, use the next unused numbers and update this specification, plan, expected ledger and docs together; do not overwrite another migration.

Add the September 27 workflow design to the current authority index. Mark specifically superseded compatibility guidance as historical; do not rewrite past evidence or mark proposed work implemented before it passes. Keep current historical migrations on the supported install path.

Extend the existing CI workflow with lint and TypeScript checks and a Linux disposable PostgreSQL integration/migration job. Retain Windows/Linux database-free unit coverage. Give the DB job an explicit loopback `medclinic_test_*` target and `TEST_DATABASE_DISPOSABLE=1`, using a distinct not-yet-existing name for each runner invocation; reuse the owned test harness and synthetic `.test` configuration. A build gate may use synthetic configuration and must not load production secrets or send real email.

## 7. Acceptance criteria

| Scenario | Required proof |
| --- | --- |
| Empty installation and replay | All migrations apply; exact ledger; reference seed succeeds without implicit human/test accounts; second migration run applies 0; injected failure leaves no partial migration or ledger row |
| Compatibility fields | Final schema lacks the removed capacity/manual metadata columns; positive maximum enforced; unsupported predeployment scheduling rows make migration 031 fail and roll back |
| Standard and First-Year imports | Both persist complete published pairs and non-null import provenance; rejected input leaves no partial students/import/schedules; First-Year reservations and lifecycle still work |
| Upload/certificate separation | Laboratory initial/edit/resubmit/invalidate/download works; direct PE upload attempts change no state/storage; certificate issue, correction, revocation and download still work |
| Clinical protection | PE requires completed applicable Laboratory checklist; protected PE/certificate history blocks unsafe rollback/displacement; partial Laboratory progress survives supported replacement |
| Student access | Unverified students retain reading/official downloads; upload/edit routes require verification before body/storage work; cross-student and invalidated/draft file access denied |
| Compliance and search | Attendance filters return matching records; obsolete filter values return 422; latest/either-service distinction preserved; name/initial/suffix searches and pagination unchanged |
| Scheduling safety | Capacity is max-only; FCFS/category/OVPSA rules, cycle bounds, closure/manual recovery, replay/conflict rollback, notifications and history unchanged |
| Dead paths | No supported command imports deleted tooling; no PE upload table-selection branches; no removed encryption aliases or 24-hour recognition; remaining old strings have an explicit historical/protection purpose |
| Operations | Preflight, staff onboarding, real SMTP acceptance, persistent workers, backups/private storage and supported fixture ownership/cleanup remain valid |

Run lint, typecheck, ordinary unit tests, full serialized disposable integration tests, empty-database rehearsal and production build. Then exercise the actual Standard import, First-Year import/lifecycle, Laboratory checklist/upload, PE completion/certificate, manual batch recovery, and unverified-student read/verified-upload browser journeys. Capture exit codes and limitations; test count reduction is acceptable only where obsolete tests were removed and live behavior coverage remains.

## 8. Delivery and scope control

Implement in the task order of the linked plan, with separate reviewable commits for dead-code/tooling cleanup, Laboratory boundaries, compliance vocabulary, capacity schema, persisted import schema, and operational documentation/verification. Keep all runtime removals out of this documentation-only commit.

Preferred approach: targeted cleanup plus forward schema narrowing. A file-only cleanup would leave live obsolete branches and database contracts. A wholesale rewrite or migration squash would expand risk and contradict the repository's retained migration policy without helping the confirmed removals.

Completion means the removal ledger is satisfied, the explicitly retained systems still pass acceptance, current guides agree, and outstanding failures are disclosed. It does not mean zero occurrences of words such as “legacy”, “draft”, “historical” or “obsolete” across Git history, SQL history and negative regression tests.
