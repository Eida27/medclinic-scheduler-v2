# Repository Review and First Deployment Readiness Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development and test-driven-development. This is the user-approved plan, divided into independently reviewable implementation tasks within the five specified stages.

**Goal:** Implement R01-R12 and verify the complete first-install workflow.
**Architecture:** Preserve the existing services, transactional scheduler, private local storage, and supervised persistent Node workers. Establish disposable database testing before application changes.
**Tech stack:** Existing Next.js 16.2.6, React 19.2.4, TypeScript, PostgreSQL, Vitest, Nodemailer.
**Spec:** `docs/superpowers/specs/2026-09-07-repository-review-first-deployment-design.md` (binding authority).

## Global constraints

- Work only in the isolated codex/repository-first-deployment-readiness worktree. No merge, push, deployment, production-data backfill, or migration-chain rewrite.
- Preserve college-only scheduling; no K-12, SPECIALIZED, or retired generate/publish workflow.
- Preserve mandatory email verification, case-insensitive required middle-name login, separate student/staff sessions and authorization.
- Manila dates, Monday-Friday, Laboratory before PE; First-Year/OVPSA minimum seven-calendar-day PE gap, ownership, reservations and external Laboratory accounting remain protected.
- Configured service capacity is the ceiling. Every automatic/manual replacement stays in its original configured academic cycle; exhaustion is Manual Resolution.
- Preserve effective appointment lineage, immutable snapshots/provenance, result revisions, private downloads, audit events, outbox encryption/retry and worker registration.
- Result files: PDF/JPEG/PNG, 20 MiB/file, 10 files and 50 MiB/submission; 51 MiB actual multipart request limit.
- TDD: observe regression failures before behavior changes; verify focused tests then relevant complete suites. Never run the old application-DB-writing default tests.
- Database writes and SMTP acceptance use owned disposable resources only, never ordinary application data or external recipients. All child scripts must inherit the explicit test target.
- No database migration is currently required. Existing manual resolution reason NO_VALID_REPLACEMENT_WITHIN_CYCLE is available.
- Each task ends with a commit, implementation report, spec/quality review and any required fixes. Final acceptance gates are not implied by a unit test pass.

## Task 1: Guarded test isolation (stage 1, R09)

- [ ] Make npm test/test:watch database-free and independent of .env.local/application secrets. Supply synthetic configuration before imports and fail immediately on unintended database access.
- [ ] Add test:integration requiring TEST_DATABASE_URL plus TEST_DATABASE_DISPOSABLE=1. URL names a new loopback medclinic_test_* database. Refuse existing targets and unsafe identities before fixtures. Create target, verify live identity, migrate, seed only reference data, run fixtures/integration suite serialized, and drop only the target owned by this invocation. Report failures/residue, including teardown failures.
- [ ] Propagate target URL/configuration to every child process. Remove application DATABASE_URL fallback from test:migrations:empty; preserve real production CLI, exact 27 then 0 migrations, synthetic atomic rollback, usable connection, and drop proof.
- [ ] Classify all actual database tests, including email-outbox.worker.test.ts, result-draft-cleanup.worker.test.ts and database portion of staff-fixtures.test.ts. Keep pure portions in units. Audit misnamed tests rather than relying only on existing filenames.
- [ ] Fix native path assertions in db-reference-catalog-cleanup, browser-appointment-protection-fixture and browser-scheduling-integrity-fixture tests. Use path.win32 only for Windows semantics.
- [ ] Add Windows/Linux database-free unit CI workflow. No remote dispatch/push. Preserve meaningful authorization/scheduling/storage coverage.
- [ ] Prove unit execution without reachable DB or application secrets, unsafe-target refusal before writes, disposable migrate/seed/tests/cleanup, and application DB unchanged. Full integration may reveal baseline defects; record exact evidence and fix harness issues within scope, leave application behavior fixes for their tasks.

## Task 2: Installation preflight, request boundaries and SMTP harness (stage 1, R08/R10)

- [ ] Add actionable installation preflight command for DB/configuration, distinct secrets, APP_URL, Asia/Manila, durable private upload directory and SMTP prerequisites. Missing SMTP must be caught before bootstrap; temporary delivery outages preserve transactional outbox retries and unrelated scheduling commits.
- [ ] Add local loopback SMTP acceptance sink using a dev-only smtp-server dependency, with test delivery inspectable only locally. Never log secrets or verification URLs in routine output. No verification bypass.
- [ ] Require ADMIN authorization before reference-data reads and explicit request-time rendering, using await connection() and the existing requireUser pattern. Audit all database-backed settings pages.
- [ ] Rewrite README/.env.example and installation guide around seven steps: compatible runtimes/dependencies; DB/secrets/URL/timezone/storage/SMTP; migrations/reference seeds without people; bootstrap admin/receive verification/change temporary password; configure intended academic year/closing date/capacity/reference data; onboard coordinator and clinic staff/import CSV/both clinics; student email verification/schedule/attendance/results/edit/download/notifications.
- [ ] Document persistent supervised Node execution, private durable storage shared consistently by instances, restart/release durability and catch-up, and coordinated DB/file backup restore. No selected hosting vendor or claim of cloud storage. Serverless requires separate durable workers/object storage before deployment.
- [ ] Correct stale optional verification, permanently locked results, separate calendars, blanket closure rollback and automatic restoration guidance. Current-policy index and historical document labels are completed in Task 6.
- [ ] Prove preflight failures and successful local SMTP receipt, bootstrap prerequisite handling, authorization before queries, and production build with syntactically valid config and unreachable operational DB. Full seven-step Browser/runtime acceptance belongs to Task 7.

## Task 3: Priority integrity (stage 2, R01-R03)

- [ ] Add real PostgreSQL regressions first. Pair/PE-only victim selectors require standard Regular import mode and no OVPSA ownership on either appointment; retain result/manual-lock/publication/transaction protections.
- [ ] Include unassigned requests and preferred-window overflow in displacement demand; search relevant service/date capacity across remaining cycle for unassigned demand.
- [ ] Evaluate allocation simulation before mutation. Rank outcomes by fewer unassigned requests, then fewer pairs exceeding preferred window (either service).
- [ ] Consider useful combinations of released slots; prune redundant victims while preferring later-accepted eligible students. Candidate combinations must not overlap appointment IDs. No-benefit candidates receive no mutation/event/notification.
- [ ] Recover all victims in a single ascending accepted-time/source-row/student queue with shared occupancy; preserve completed Laboratory for PE-only cases.
- [ ] Preserve atomic publication. Incoming exhaustion rolls back; displaced student without safe same-cycle recovery enters existing Manual Resolution.
- [ ] Test protected First-Year lineage/reservations, full and partially full cycles, PE-only pressure, blocked/exclusive dates, capacity only after preferred month, combination benefit, no-benefit preservation, input-order permutations and mixed FCFS contention. Assert DB/history/notification outcomes and clean fixtures.

## Task 4: Closure and capacity integrity (stage 3, R04/R05)

- [ ] Regressions first: explicit cycle bounds through ordinary closure preview/confirmation, individual manual and coordinated OVPSA recovery; academic boundary reads/locks follow existing queue lock order.
- [ ] Share destination policy: strictly future Manila weekday, original configured cycle, service availability/capacity, Laboratory before PE, OVPSA seven-calendar-day minimum. Same-day closure does not permit same-day replacement.
- [ ] Missing/closed/expired/exhausted cycles produce existing Manual Resolution without fabricated dates; confirmation revalidates current state and matches unchanged preview.
- [ ] Simulate moves against copied occupancy, release only genuinely retired appointments of accepted moves, then reserve replacements. Preserve completed/protected work and discard occupancy changes for failed moves. Reopening availability never restores appointments automatically.
- [ ] Serialize capacity settings with medclinic:schedule-import-queue. Check committed current/future workload using consistent service accounting, exclude external OVPSA Laboratory, update plus audit in one transaction. Reject conflict with HTTP 409 and affected dates/counts, no rescheduling side effect.
- [ ] Test last weekday/custom closing date/no pair fits/expired and missing cycles/OVPSA gap crossing boundary/pair preservation/released-slot reuse; PostgreSQL two-client reduction-vs-import race, final-slot integrity, safe reduction/increase and forced audit rollback.

## Task 5: Identity, interaction recovery and upload bounds (stage 4, R06/R07/R11)

- [ ] Require trimmed nonblank middleName in manual create/edit matching CSV normalization and length; field-specific errors before writes and existing login matching preserved. Invalid edits keep prior credentials.
- [ ] Repair LoginForm, StudentLoginForm, StudentForm, AppointmentActions, DeactivateStudentButton and analogous logout handlers: safe non-JSON parsing, accessible feedback, synchronous duplicate guard, try/catch/finally. Preserve input; no automatic ambiguous retry; existing student can save twice without reload with success feedback.
- [ ] Bound actual streamed multipart bytes to 51 MiB before full parsing, irrespective of Content-Length; cancel over-limit stream and return HTTP 413. Before file.arrayBuffer validate count <=10, type PDF/JPEG/PNG, size <=20 MiB each and aggregate <=50 MiB. Materialize sequentially.
- [ ] Preserve existing draft transaction aggregate limits, signatures/checksums, ownership, storage cleanup and official revision protection.
- [ ] Test success/JSON 4xx and 5xx/HTML 502/fetch rejection/duplicate click for each affected handler; middle-name null/omitted/whitespace rejection, Unicode length parity, valid create/edit/import/login. Upload declared/chunked limits, eleven files, oversize file, no early buffers or mutation, valid multi-file atomic edit/resubmit and failure preservation.

## Task 6: Verified cleanup and navigation (stage 5, R12)

- [ ] Recheck every candidate in spec Section 5. Remove unreachable modules/export islands, transferring meaningful test-only helper assertions onto live paths before removal. Keep cleanup separate from scheduling changes.
- [ ] Landing primary Student sign in -> /student/login with “View your schedule and submit results.” Secondary Staff sign in -> /login with “For administrators, coordinators and clinic staff.” Remove duplicate Find my schedule.
- [ ] Retire /student-lookup and /api/student-lookup, /settings/first-year-ovpsa list/detail redirects, /compliance page, /appointments generic list/detail redirects, /results page, and clinic /appointments aliases after updating default internal destinations/callers. Update proxy matchers/fixtures/tests together. Retain /api/compliance and all First-Year lifecycle APIs.
- [ ] Preserve worker/CLI/migration entrypoints, First-Year reservations/lifecycle, schedule import/history, report snapshots and result revision/audit behavior. No table squashing.
- [ ] Current-policy documentation index and historical labels for superseded design guidance; retain useful history.
- [ ] Verify dead callers absent via searches/typecheck, live paths retain meaningful tests, removed aliases have intentional route absence. Long ConfirmDialog containment change only if actual narrow/short visual inspection proves unreachable controls.

## Task 6b: Targeted runtime dependency security correction

The pre-acceptance audit found a critical Windows-hosted Next.js vulnerability in the original pinned runtime. This bounded correction is separate from R12 cleanup and must precede final-build acceptance.

- [ ] Capture the existing audit failure before dependency changes. Preserve the audit JSON and exit code as the security regression; do not add a test that only asserts package version strings or attempt exploitation.
- [ ] Update Next.js and eslint-config-next together to 16.3.5, and the direct Sharp fixture dependency to 0.35.4, matching the patched Sharp range used by Next. Check maintainer release guidance and engine/peer compatibility. Retain the existing React version, application routing/configuration, Node supervision and storage contracts. No blanket audit fix, unrelated major upgrade, migration or production behavior redesign.
- [ ] Regenerate the lockfile through npm and inspect the resolved Next/Sharp dependency trees for vulnerable duplicate copies. Verify installation consistency, native Sharp loading/image generation and the existing result-editing fixture coverage on Windows.
- [ ] Run the relevant request-boundary/auth/proxy/upload unit coverage, guarded result-editing fixture integration coverage, TypeScript and lint affected by the matching framework configuration. Use explicit new disposable databases and retain cleanup proof. Complete suites, production build and authenticated Browser acceptance belong to Task 7 after this task's review.
- [ ] Re-run the audit, require the targeted Next and Sharp findings to be absent, and record all remaining findings accurately. Do not claim a clean dependency audit if unrelated baseline findings remain. Update the current installation/runtime documentation to distinguish the newly tested versions from prior evidence.
- [ ] Commit separately, report exact before/after evidence and compatibility concerns, then complete a task-scoped review before final acceptance.

## Task 7: Complete acceptance and final verification (all stages)

- [ ] Prepare isolated Browser app/SMTP/private files using owned disposable data and synthetic accounts. Never use root application database. Exercise real first install without SQL edits: bootstrap verification/password replacement/admin/year configuration/staff onboarding/imported student verification.
- [ ] In-app Browser acceptance: imports/both clinics/priority and closure/manual recovery/capacity conflicts/student edit twice/result upload-finalize-edit-resubmit/private downloads. Correlate UI with authenticated HTTP and DB evidence; keep JSON-only probes distinct from Browser evidence.
- [ ] Desktop, narrow mobile and short-height checks: keyboard focus, labels/errors, long dialogs, progress/retry, result editing, table filters, no overflow/unreachable actions. Inspect rendered report PDF and preserve snapshot provenance/effective appointments.
- [ ] Production restart/release with pending work and existing uploaded files: prove mail/no-show/cleanup catch-up and intact private downloads. Test SMTP sink only, no external recipient.
- [ ] Run complete units, serial integration suite, empty-database verification, TypeScript, lint, build with unreachable operational database, git diff --check. Require final exit codes, logs, fixture identity and cleanup proof. Linux CI execution remains unavailable until a runner produces results; no false deployment-readiness claim.
- [ ] Final branch review; fix substantive findings; leave isolated branch/worktree for user review, no merge/push/deploy.
