# Repository Review and First Deployment Readiness — Implementation Spec

**Status:** Proposed fixes for review; this document does not implement them.

**Repository:** `Eida27/medclinic-scheduler-v2`

**Reviewed baseline:** `main` at `684662015f11742d47036861e0ec7b1158a53851` (`fix: preserve snapshot provenance integrity`). Review began September 6 and concluded September 7, 2026, UTC.

**Operating assumption:** The system has never been deployed and the installation database is completely empty. There are no production users, documents, bookmarks, or historical records to migrate. Normal appointment and audit history created after installation must still remain correct.

**Goal:** Correct scheduling and onboarding defects, make workflows recover cleanly from failures, remove verified unused implementations, and define a reproducible first installation.

## 1. Review outcome and evidence limits

The application has a substantial working foundation: an atomic import/publication path, deterministic date-only scheduling, separate student/staff sessions, result ownership checks, revision-based result editing, clinic closure previews, and historical reporting. A rewrite is not justified by this review. The recommended approach is targeted fixes followed by removal of confirmed dead code.

The highest-priority findings concern protected First-Year/OVPSA appointments being eligible for ordinary priority displacement, priority imports failing before considering available displacement, closure recovery escaping its academic cycle, and a documented installation/test workflow that can create unusable onboarding or unwanted test administrators.

### What was inspected

- Repository inventory: 661 tracked files, including 27 migrations and 234 source test files. The dependency lockfile and binary assets were inventoried rather than audited line by line.
- Scheduling: paired generator, standard/First-Year imports, priority victim selection and recovery, reservations, calendar closure/reopening/manual recovery, appointment status and capacity mutations, academic-year boundaries, and relevant recent specs.
- Backend: authentication and authorization, student identity, result uploads/revisions/downloads/invalidation, notifications/outbox/workers, bootstrap/seeding/migrations, and reporting/snapshot read paths.
- Workflows: public entry points, student login/verification/schedule/results, staff forms, imports/history, appointments, calendar/manual queue, settings and reports.
- Dead-code analysis: TypeScript import/reachability inspection covering 305 non-test source files and 114 Next entrypoints, cross-checked against scripts, tests and symbol searches. Convention-based routes and CLI entrypoints were not treated as ordinary unused imports.

### Verification actually performed

| Check | Result and interpretation |
|---|---|
| Install locked dependencies | `npm ci --ignore-scripts --no-audit --no-fund` completed. |
| TypeScript | `npx tsc --noEmit` passed. |
| ESLint | `npm run lint` passed. |
| Broad test run with temporary configuration | 182 test files: 176 passed, 6 failed. 1,017 tests passed, 4 failed, 62 skipped. The temporary configuration disabled database-writing global setup and excluded `*.integration.test.ts`. |
| Test failures | Three assertion failures assume Windows path formatting on Linux. The other failed test and failed suite hooks require PostgreSQL; some database tests use ordinary `.test.ts` filenames. These are not all application regressions. |
| Priority probes | Three assertions passed against actual import/recovery functions with an in-memory SQL client: wrong OVPSA victim, horizon exhaustion without victim lookup, and mixed recovery-order unfairness. SQL eligibility was checked in source; PostgreSQL did not execute these probes. |
| Closure probe | Actual pure allocator returned August 2/3, 2027 after a July 30 closure even when the intended cycle closes July 31. The allocator accepts no cycle-closing bound. |
| Production build | Compilation and build TypeScript completed. Build then failed prerendering `/settings/reference-data` because that page queried the deliberately unavailable database. Build success is not claimed. |
| Browser | A local preview was started, but the browser rejected both local addresses with `ERR_BLOCKED_BY_CLIENT`. No visual/mobile or authenticated browser acceptance is claimed. |
| Database/SMTP/storage deployment | No PostgreSQL integration, empty-database migration execution, real SMTP delivery, or production storage/restart validation was possible in this environment. No application database was modified. |

This is a repository-wide engineering review, not proof that every execution path is bug-free. Confirmed source defects, executable probes, deployment requirements and recommended UX changes are distinguished below.

## 2. Current policies to preserve

Recent repository decisions take precedence over older conversation context and stale README paragraphs.

| Area | Required behavior |
|---|---|
| Scope | Current college scheduling. Do not reintroduce K–12 or `SPECIALIZED`; the August 29 retirement spec explicitly excludes them. |
| Standard imports | Regular, OJT and Tour; atomic validation, student updates, scheduling and publication. Do not reintroduce the retired manual generate/publish pipeline. |
| Dates | Manila calendar dates, Monday–Friday, Laboratory before PE. Preserve current preparation rules. |
| First-Year/OVPSA | Preserve its protected external Laboratory/reservations and current minimum seven-calendar-day PE rule. Do not replace it with the standard next-available-day rule. |
| Capacity | Configured maximum daily service capacity is the ceiling. Preserve the deliberate treatment of external OVPSA Laboratory work. Do not invent a universal new capacity number. |
| Fairness | Select eligible later-accepted Regular victims when priority requires it; allocate their recovery by original acceptance/source-row order across all recovery types. |
| Replacement bounds | Every automatic replacement remains in its original academic cycle. Exhaustion produces Manual Resolution, not a later-cycle appointment. |
| Closures | Unified calendar, impact review, explicit recovery choice, preservation of completed/protected work, manual fallback where necessary. Reopening restores availability only; it does not automatically restore old appointments. |
| Student access | Separate student identity/session and mandatory verified email under the current implemented policy. Middle name remains required and case-insensitive; do not silently weaken identity checks. |
| Attendance/results | Attendance completion and uploaded-result completion remain separate. Completed appointments can accept result drafts; finalized results can be edited through the current revision/resubmit flow. |
| Documents | PDF/JPEG/PNG, 20 MiB per file, 10 files and 50 MiB per submission, ownership checks, private storage and existing integrity validation. |
| History | Keep effective appointment lineage, snapshots, result revisions and audit events that serve current workflows, even though the initial database is empty. |

Relevant policy sources include the August 6 result-editing, August 13 import-consolidation, August 14 closure-recovery, August 22 mandatory-email, August 25 staff-onboarding, August 26 scheduling-integrity, August 29 retirement and September 5 snapshot-provenance specs, plus the August 30 cycle-horizon implementation plan already in this repository.

## 3. Prioritized findings and required fixes

Priority definitions: **P1** affects scheduling correctness, safe installation or database isolation and must be fixed before first deployment. **P2** affects reliability, usability or maintainability and belongs in the same readiness work. No critical remote compromise was established by this review.

| ID | Priority | Finding | Evidence level |
|---|---|---|---|
| R01 | P1 | Ordinary priority displacement can select protected First-Year appointments | Source trace + mocked service probe |
| R02 | P1 | Unscheduled priority requests do not trigger displacement; pair victims need not improve placement | Source trace + mocked import probe |
| R03 | P1 | Pair recovery receives capacity ahead of older PE-only recovery | Executed service probe |
| R04 | P1 | Clinic closure recovery bypasses academic-cycle bounds | Executed allocator probe + source trace |
| R05 | P2 | Capacity changes can contradict published workload and are not atomic with audit | Source trace; concurrent interleaving not executed |
| R06 | P1 | Manual student editing can erase a required login credential | Source/schema trace |
| R07 | P2 | Forms can remain busy or fail silently | Source/control-flow trace |
| R08 | P1 | Documented first install cannot finish onboarding without undocumented prerequisites | Source/documentation contradiction |
| R09 | P1 | Default tests write known-password users into the application database | Direct setup/caller trace |
| R10 | P2 | Reference-data page performs database reads during production build | Observed build failure |
| R11 | P2 | Upload size/count checks occur after multipart and buffer allocation | Source trace; resource exhaustion not attempted |
| R12 | P2 | Dead implementations and duplicate/obsolete navigation obscure the current workflow | Import/caller inventory and route inspection |

### R01 — Exclude OVPSA appointments from ordinary Regular displacement

**Evidence:** `src/server/repositories/priority-displacement.repository.ts:74–83` selects pairs using `import_group.student_category='REGULAR'`; the PE-only selector repeats this at `:191–199`. Neither selector excludes First-Year import mode or OVPSA appointment ownership. `src/server/services/first-year-schedule-import.service.ts:512–517` deliberately stores First-Year imports with category `REGULAR` and mode `FIRST_YEAR_OVPSA`; `:751–772` publishes their appointments with OVPSA lineage and the same category.

**Trigger:** Publish ordinary Regular imports and a later-accepted First-Year batch. An OJT/Tour import needs August capacity. The First-Year pair can match the latest eligible Regular victim query. Its exclusive dates remain blocked, so moving it need not help the incoming import.

**Observed probe:** The actual import function returned `PUBLISHED`, reported one displacement, marked the First-Year pair `RESCHEDULED`, and still reported one pair beyond the preferred window. The standard replacement insertion omitted OVPSA ownership columns. This demonstrates service behavior with the selected row; live SQL/locking reproduction remains an implementation acceptance gate.

**Required change:** Make standard victim eligibility explicitly require the standard Regular import mode and absence of OVPSA ownership on both appointments. Apply the same rule to pair and PE-only selectors. Keep protection checks under the existing transaction/locks. Preserve all First-Year reservations, appointment lineage and external-verification behavior.

**Acceptance:** A real PostgreSQL fixture containing both standard Regular and First-Year records must show that OJT/Tour displacement selects only eligible standard Regular records. With only First-Year or otherwise protected records available, it must use allowed undisplaced capacity or fail clearly without mutating those records. Verify reservation and OVPSA IDs remain unchanged.

### R02 — Plan priority displacement from unmet demand and require a real benefit

**Evidence:** `src/server/repositories/schedule-imports.repository.ts:601–612` calculates displacement demand only from successfully assigned pairs beyond the preferred month. Requests in `unscheduledRequestIds` are omitted. They are rejected later at `:671–677`. Pair candidates are subtracted and scheduling reruns at `:613–623`, but unlike the PE-only check at `:650–664`, there is no check that each retained pair victim improves the result.

**Trigger/probe:** At one slot per service/day, fill the cycle with valid Regular pairs. The priority import raises `SCHEDULE_CAPACITY_EXHAUSTED` and performs zero victim lookups. Freeing one eligible August 2/3, 2027 Regular pair makes the same incoming OJT pair schedulable.

**Required change:** Represent both unassigned demand and preferred-window overflow in the priority planner. Evaluate candidate capacity at the relevant dates and service, rerun allocation, and retain only a necessary set of victims that actually resolves demand or reduces the approved overflow. Do not move a student merely because a query returned that student. If no useful eligible victim exists, preserve current appointments and report the actual conflict. Keep import publication atomic; a displaced victim lacking same-cycle recovery must enter the approved Manual Resolution flow.

**Acceptance:** Cover completely full cycles, partially unassigned imports, PE-only pressure, exclusive reserved dates, protected victims and capacity exhausted only after the preferred month. An import that can use eligible displacement must consider it before rejecting. A no-benefit candidate must produce no appointment mutation, displacement event or student schedule-change notice.

### R03 — Use one FCFS queue for all displaced students

**Evidence:** `src/server/services/priority-displacement.service.ts:168–172` defines FCFS ordering, but `:181–213` allocates all pair replacements first and `:220–239` allocates all PE-only replacements afterward. Sorting inside each subset does not preserve ordering across subsets.

**Executed probe:** An older PE-only candidate and a later accepted pair compete for the final PE slot on July 31, 2028. The later pair receives Laboratory July 28/PE July 31; the older PE-only student is sent to Manual Resolution.

**Required change:** Sort all bounded candidates once by accepted time, source row, and deterministic student tie-breaker. Process each entry in that order, applying the appropriate pair or PE-only allocator to shared occupancy. Preserve a completed Laboratory for PE-only cases.

**Acceptance:** Reverse input order repeatedly and obtain the same allocation. The older PE-only candidate must receive the contested slot ahead of the later pair. Test the opposite age ordering as well. Validate deterministic manual fallback, no duplicate allocation, and correct notification/history outcomes.

### R04 — Apply shared destination bounds to every closure recovery path

**Evidence:** `src/server/services/clinic-calendar-planner.ts:239–267` searches `366 * 5` days after the closure; its public allocator at `:270–295` accepts no closing date. `clinic-calendar.service.ts:1743–1771` permits same-day manual closure replacements and checks no cycle bound. At `:1928–1938`, only cases sourced from `AUTOMATIC_DISPLACEMENT` use the stricter shared destination validator; ordinary closure cases use the weaker one. Coordinated OVPSA closure recovery at `:2123–2259` also searches five years and does not enforce the batch cycle closing date.

**Executed probe:** A complete-pair allocation after July 30, 2027 returns Laboratory August 2 and PE August 3. A July 31 cycle close cannot stop it because that value is absent from the interface.

**Required change:** Read/lock the configured academic-year boundary and pass it explicitly through preview and confirmation. Reuse the current shared future-date and pair-order policy for ordinary automatic recovery, individual manual closure resolution, and coordinated OVPSA recovery. Preserve the existing OVPSA seven-day minimum. Same-day *closure* remains permitted where policy allows; it does not imply permission to bypass the replacement-date rule.

When no complete safe replacement fits, retain/create a manual case with `NO_VALID_REPLACEMENT_WITHIN_CYCLE` or the existing equivalent and do not fabricate a date. Preview and confirmation must share the planner; confirmation revalidates against current state.

Also reconcile capacity changes inside the simulated plan: the current `loadCapacity`/`reserveCapacity` pair (`clinic-calendar.service.ts:533–560`) loads original appointments and only adds replacements. Remove occupancy for appointments actually retired by each accepted move so later students do not encounter stale reservations in that in-memory map. Do not free preserved, completed or protected appointments, or release slots for a move that rolls back.

**Acceptance:** Test the last weekday of the cycle, an earlier configured closing date, closed/unconfigured cycles, no complete pair fitting, an OVPSA seven-day gap crossing the boundary, expired manual cases, and preserved Laboratory/PE ordering. No successful path may insert a replacement outside its original cycle. A multi-student closure must reuse legitimately released future capacity in the same operation while respecting recovery order.

### R05 — Make capacity changes consistent and transactional

**Evidence:** `src/server/services/appointments.service.ts:851–856` updates capacity, then writes audit separately. `src/server/repositories/appointments.repository.ts:568–574` performs an unconditional setting update without the scheduling mutation lock or a published-load check.

**Impact:** Lowering a configured maximum below a published daily load immediately contradicts the advertised ceiling. An import can also read the old maximum while a concurrent settings request installs a lower one. An audit-write failure can report an error after the setting has already changed. The concurrent sequence is a source-established risk, not a reproduced PostgreSQL race.

**Proposed behavior:** Serialize capacity mutation with the scheduling queue and perform update plus audit in one transaction. Reject a reduction below already committed current/future workload with a clear conflict containing affected dates/counts. Do not silently move existing students as a side effect of saving settings. Preserve the special external-Laboratory accounting rule. Increases and safe reductions remain straightforward.

**Acceptance:** Reducing capacity 150→120 with 130 booked returns a conflict and changes nothing. A reduction with all affected daily loads at or below 120 succeeds. Force an audit failure and prove rollback. Race a last-slot import against a reduction using two real PostgreSQL clients and verify a serializable user-visible outcome under the chosen locks.

### R06 — Align manually maintained student identity with login/import rules

**Evidence:** `src/server/services/students.service.ts:15–23` converts blank middle names to `null`; create and update both accept this schema. `src/components/students/StudentForm.tsx:64` does not require the field. `student-auth.service.ts:17–20,52–53` requires a nonempty middle name and rejects stored null; CSV import already requires it.

**Trigger:** An administrator creates a student with a blank middle name or clears an imported student's middle name. Saving succeeds, but the student cannot subsequently authenticate.

**Required change:** Require a nonblank full middle name in manual creation and editing, and make the form show that requirement. Use consistent length/normalization rules with import. Preserve the established matching semantics instead of compensating by weakening login. Update schema tests that currently approve null. No legacy-null backfill is required for the assumed empty installation.

**Acceptance:** Omitted/null/whitespace middle names fail before a database write, with a field-specific error. A valid middle name survives create/edit/import and permits login using the established case rules. A rejected edit preserves the prior working credentials.

### R07 — Recover forms from success, HTTP failure and network failure

**Evidence:** `src/components/auth/LoginForm.tsx:15–32`, `src/components/student/StudentLoginForm.tsx:15–36`, `src/components/students/StudentForm.tsx:36–54`, and `src/components/appointments/AppointmentActions.tsx:33–55` await requests/JSON without complete error/finally handling. `StudentForm` only resets pending on non-success; after editing an existing record it pushes the same detail URL and refreshes, leaving the unkeyed component busy. `DeactivateStudentButton.tsx:19–20` provides no visible error for unsuccessful responses.

**Required change:** Put mutations in a consistent `try/catch/finally` pattern, parse unexpected/non-JSON responses safely, and always restore an actionable state. Preserve user input on failure. Show a useful accessible error and allow an explicit retry. For existing-student save, reset pending and show success without depending on component unmount. Audit analogous logout/deactivation handlers while making this change. Do not automatically retry a non-idempotent mutation after an ambiguous network response.

**Acceptance:** For each affected form, test successful responses, JSON 4xx/5xx, HTML 502, rejected fetch and duplicate click while pending. Controls must remain locked only during the actual operation. A second valid edit after saving an existing student must work without a page reload. Deactivation failure must be visible.

### R08 — Make a clean installation usable and document the real runtime contract

**Evidence:** `.env.example:5`, `README.md:124,141` describe optional email/SMTP. Bootstrap creates an unverified administrator and queues verification (`staff-bootstrap.service.ts:42–43`), while `email-outbox.service.ts:170–172` skips sending without SMTP host/from. Operational staff access requires onboarding completion, and verified student access is enforced. An empty database also has no academic-year row: first standard import is rejected at `schedule-imports.repository.ts:369–379`; First-Year import rejects an unconfigured year at `first-year-schedule-import.service.ts:185–194`. README omits the administrator's required year-configuration step.

**Required setup sequence:**

1. Install the documented compatible Node/PostgreSQL versions and locked dependencies.
2. Configure the application database, strong separate secrets, correct `APP_URL`, Manila timezone, private durable result directory, and working SMTP. For local acceptance use a local mail catcher; do not bypass verification.
3. Apply migrations and reference seeds to the empty database. Confirm no human/test staff or students were seeded.
4. Bootstrap one administrator, start the application/delivery worker, receive the verification message, verify, replace the temporary password and confirm administrative access.
5. Create the intended academic year and closing date, then review capacity/reference data. Do not seed an arbitrary calendar year.
6. Create/onboard coordinator and clinic staff accounts; import the first valid CSV; verify publication in both clinic views.
7. Sign in as an imported student, verify email, view the schedule, complete appointments as authorized staff, upload/finalize/edit results, and verify private downloads and notification delivery.

Configuration/preflight should clearly report missing delivery prerequisites before the installation is presented as ready. Delivery outages after configuration must keep existing transactional outbox/retry behavior; do not roll back unrelated scheduling just because SMTP is temporarily unavailable.

**Deployment contract:** Current `src/instrumentation.ts` starts in-process timers; worker files use unreferenced recurring timers. `src/server/storage/local-result-storage.ts` is the live default filesystem adapter. The currently supported architecture therefore requires supervised persistent Node execution and durable private storage shared consistently by app/worker instances. Verify existing uploads survive a restart/release and queued work catches up after restart. Backups must restore database and file state together.

This spec does not select a hosting vendor. If a serverless/ephemeral-filesystem deployment is selected, durable object storage and externally scheduled/durable worker execution become explicit prerequisites before that deployment. Installing a PostgreSQL database alone does not provide either capability. Do not advertise the current local adapter as cloud storage.

**Documentation cleanup:** Replace stale statements about optional verification, permanently locked final submissions, separate clinic calendars, blanket HTTP-409 closure rollback and automatic restoration. Add a current-policy index and mark superseded design documents as historical rather than leaving readers to reconcile them. Retain useful design history; do not delete documentation merely because it describes a past change.

**Acceptance:** An operator following only the revised guide must complete all seven steps on an empty database without SQL edits, known test accounts, or hidden environment values. Demonstrate real verification delivery with a test SMTP sink and absence of secrets/verification links in routine logs.

### R09 — Separate database-free unit tests from guarded disposable-database tests

**Evidence:** `package.json:11` runs tests using `.env.local`; `vitest.config.ts:13` invokes `vitest.global-setup.ts:5`; `src/test/staff-fixtures.ts:32–53` upserts known-password staff, verifies their email, clears onboarding/deletion flags and resets credential versions in the ordinary application `DATABASE_URL`. No database identity gate or automatic teardown exists in that chain.

**Fresh-install consequence:** Running the documented tests can leave known-password operational staff behind. Running them before bootstrap can make bootstrap refuse to create the real first administrator because an administrator already exists.

**Required change:** Default unit/component tests must not connect to or mutate an application database. Put database tests in an explicit integration project/command requiring a separate `TEST_DATABASE_URL` and disposable-database opt-in/identity validation before any fixtures execute. Wire the integration process to that database consistently, including child scripts; never silently fall back to ordinary `.env.local` `DATABASE_URL`. Keep production bootstrap credentials independent. Teardown must remove owned fixtures and report residue/failure.

Fix classification of `email-outbox.worker.test.ts`, `result-draft-cleanup.worker.test.ts`, and the database portion of `staff-fixtures.test.ts`, which were not excluded by the `*.integration.test.ts` pattern. Fix Windows-only path expectations in `src/test/db-reference-catalog-cleanup.test.ts:53`, `src/server/acceptance/browser-appointment-protection-fixture.test.ts:45`, and `src/server/acceptance/browser-scheduling-integrity-fixture.test.ts:173`. Generate native paths for native-path assertions; exercise `path.win32` explicitly only when testing Windows semantics.

**Acceptance:** Unit tests pass without PostgreSQL or application secrets. Integration tests refuse the application database before their first write. A disposable empty database supports migrate→seed→fixtures→tests→cleanup with no residue, while a separate application DB remains unchanged. Run the platform-sensitive tests on Windows and Linux. Preserve meaningful tests for active authorization, scheduling, file integrity and transactional behavior when removing dead exports.

### R10 — Keep reference-data reads behind an explicit request/authorization boundary

**Evidence:** `src/app/(dashboard)/settings/reference-data/page.tsx:5–7` immediately reads colleges/programs without a page-level authorization call. Other settings pages explicitly await `requireUser(["ADMIN"])`. During the review, `next build` attempted to prerender this page and failed on the unavailable database after successful compilation.

**Required change:** Require the intended administrator authorization before page data reads and make request-time rendering explicit using the existing authenticated-page pattern. Do not rely on the parent layout to serialize the child page's database work. Keep service/API authorization too. Do not replace a failed database read with a misleading empty catalog just to pass the build.

**Acceptance:** With syntactically valid environment configuration and no reachable application database, the production build does not query operational reference data. At runtime an administrator receives current data; other roles get the intended denial; changing reference data and refreshing shows the update. Check other database-backed settings pages for the same boundary.

Framework references: [Next.js data-fetching concurrency](https://nextjs.org/docs/app/getting-started/fetching-data), [authentication and layout limitations](https://nextjs.org/docs/app/guides/authentication), and [request-time connection boundary](https://nextjs.org/docs/app/api-reference/functions/connection). The observed build failure is repository evidence, not inferred solely from these documents.

### R11 — Enforce upload limits before expensive materialization

**Evidence:** `src/app/api/student/result-submissions/[appointmentId]/files/route.ts:27–37` parses the entire multipart body and creates every file buffer with `Promise.all`. Per-file validation occurs later in `student-result-submissions.service.ts:317`, with count/aggregate checks at `:340–348`. Authentication is already required, so this is an authenticated resource-consumption issue, not a demonstrated unauthenticated upload bypass.

**Required change:** Enforce a 51 MiB actual request-body limit before full parsing, including requests without `Content-Length`: 50 MiB maximum file content plus 1 MiB allowance for multipart metadata. After parsing, reject more than 10 files, oversized `File.size`, invalid types and excessive aggregate size before `arrayBuffer()` calls. Convert accepted files sequentially or with a concurrency limit of two. Keep transactional existing-draft aggregate checks and signature/checksum validation; metadata alone is not sufficient.

**Acceptance:** Over-limit declared bodies and streamed/chunked bodies abort safely with a clear error and no files/DB mutations. Eleven files and a single file over 20 MiB are rejected before buffers are materialized. Valid multi-file uploads remain atomic and editable. A failure leaves the previous official submission and valid draft state intact.

### R12 — Remove dead implementations and simplify entry points

Use the inventory in Section 5. Delete genuinely unreachable code rather than maintaining duplicate implementations with divergent tests. Move useful assertions to the live implementation before deleting test-only production helpers. Do not remove a route merely because an import graph cannot see Next's routing convention.

The landing page changes are specified in Section 4. Runtime cleanup must not drop live First-Year reservations/lifecycle, history/snapshots, workers or bootstrap support.

**Acceptance:** Re-run type checking, lint, unit/integration suites and route/caller searches. No removed export remains imported. Current routes still satisfy the first-install workflow. Retired route tests are updated to the intentionally chosen absence, rather than retaining obsolete functionality solely to keep old tests green.

## 4. UX decision: one student entry point

**Recommendation: remove the duplicate “Find my schedule” button.** `src/app/page.tsx:29–45` sends both it and “Student sign in” to `/student/login`. It is not a separate quick lookup and does not avoid authentication.

The landing page should present:

| Control | Destination | Supporting text |
|---|---|---|
| Primary: **Student sign in** | `/student/login` | “View your schedule and submit results.” |
| Secondary: **Staff sign in** | `/login` | “For administrators, coordinators and clinic staff.” |

Keep the primary student action visually prominent and keyboard accessible. Removing one button must not remove schedule visibility from the student portal or expose schedules publicly. Avoid an additional authentication choice screen.

The public lookup compatibility page/API can be removed for this never-deployed system after confirming no current links/tests require their behavior. There is no need to preserve hypothetical public bookmarks. Other aliases should be handled as an explicit route cleanup, not a blanket directory deletion.

The central workflows are understandable, but their failure/recovery states need improvement. Keep atomic import publication, calendar preview/confirmation, understandable manual-resolution outcomes, and result revision/resubmission. These confirmations serve real changes and should not all be removed for the sake of fewer clicks.

Before deployment, perform visual acceptance at desktop and a narrow mobile viewport: sign-in field labels and errors, keyboard focus, long confirmation content, import progress/retry, calendar review actions, result editing, and table filters. The shared `ConfirmDialog` currently has no explicit height/overflow containment (`src/components/ui/ConfirmDialog.tsx:86–100`); test long content at small heights and add containment if controls become unreachable. This is an unverified visual risk, not a claimed reproduced layout defect.

## 5. Dead-code and compatibility inventory

Locations are baseline references. Verify callers again at implementation time in case another branch changes them.

### Confirmed unused modules or export islands

| Candidate | Why it is removable / boundary |
|---|---|
| `src/lib/dates.ts` | No imports; its four helpers only call within the same unused module. |
| `src/server/repositories/clinic-calendar-restoration.repository.ts` | No callers of `lockRestorationEventsForUnavailableDates` at line 17. Current reopening does not automatically restore appointments. |
| `src/server/rule-engine/capacity-rules.ts` and `index.ts` | Capacity helper is only referenced by its own test/barrel; barrel is only imported by a retired-export test. Keep the directly used paired generator and types. |
| `src/server/auth/current-user.ts:30` — `optionalUser` | No callers. Keep active `optionalAuthenticatedStaff` and authorization functions. |
| `src/server/repositories/students.repository.ts:144` — `registeredStudentNumbers` | No callers. |
| `src/server/clinics.ts:37–47` — `clinicCodeByScheduleType`, `clinicForScheduleType`, `clinicConfigForCode` | Unused helper island; retain live clinic configuration exports. |
| `src/components/settings/clinic-calendar.ts:71` — `shiftMonth` | No callers; keep annual grid builders. |
| `src/server/ovpsa/ovpsa-first-year.repository.ts:109,161` — `loadEligibleFirstYearStudents`, `loadCurrentMemberAppointments` | No callers. Other module exports are live. |
| `src/server/ovpsa/ovpsa-first-year-lifecycle.ts:351` — `invalidateOvpsaReservationsForClosuresWithClient` | No callers; current calendar service implements closure recovery. |
| `src/server/services/student-result-submissions.service.ts:618` — `listAdminStudentResultSubmissions` | No callers; live API uses `listAdminStudentResultProfiles`. Its repository-only dependency `listAdminStudentResultSubmissionRows` at line 1404 can be removed with it. |
| `staff-login-throttle.repository.ts:25` — `normalizeStaffLoginEmail` | No production callers; retain the live normalization policy. |
| `schedule-imports.service.ts:219` — `importNameFromFileName` | No production callers. |
| `email-outbox.service.ts:162` — `obsoleteEmailOutboxMessage` | No production callers; retain active outbox invalidation functions used elsewhere. |

### Test-only alternatives to consolidate onto live paths

| Candidate | Live behavior whose coverage must remain |
|---|---|
| `student-result-submissions.service.ts:590` — `getAdminStudentResultFile` | `getAdminSubmissionResultFile`, used by the submission/file route. |
| Same service `:630` — buffered `createAdminSubmissionZip` | `createAdminSubmissionZipStream`, used by the live ZIP route. |
| `student-result-submissions.repository.ts:1460` — `lockFinalizedSubmissionForInvalidation` | Current-finalized revision-aware invalidation lock. |
| `clinic-closure-recovery-policy.ts:157` — `planMinimalClosureRecovery` | Actual calendar evaluation/allocation path. Tests of an unused helper do not prove that path correct. |
| `priority-displacement.service.ts:597` — `publishDisplacedRegularReplacements` | Production uses `publishDisplacedRegularReplacementsWithLockedScopes`. |
| `student-notifications.service.ts:13` — `createStudentNotifications` | Live singular/transactional notification paths; keep repository insertion used by admin email delivery. |
| `src/components/appointments/status-labels.ts:29,33` — result/overall label helpers and their maps | Labels used by current attendance/report/result components. Remove only the unused maps/helpers. |

### Live entrypoints that must not be mistaken for dead code

- Bootstrap CLI, migration runner, test fixtures, worker registration and migration files have non-page entrypoints.
- Schedule import/history components remain mounted in `/students` and import detail pages.
- `ovpsa_first_year_*` tables are created and populated by fresh First-Year imports; this subsystem is not legacy-only.
- First-Year list/detail/reschedule/cancel APIs are callable Next routes even though the current UI has no callers. Existing specs/tests intentionally retain post-publication lifecycle operations. Keep them in this cleanup; any later removal is a product/API decision with its own acceptance criteria.
- `/api/compliance` is a callable API, not proven dead functionality merely because the current UI does not call it.
- Compatibility aliases such as `/student-lookup`, `/settings/first-year-ovpsa`, `/compliance`, `/appointments`, `/results` and clinic `/appointments` aliases are live redirects. For this first deployment, remove aliases with no current internal consumers as a bounded route cleanup, updating proxy matchers, links and tests together. Preserve aliases still used by the application until their callers are updated.

Do not squash/drop database tables solely because their names appear historical. First audit current writes, reads, foreign keys and operational history. A fresh database removes migration-of-production-data requirements; it does not make currently used audit/revision structures unnecessary. A complete migration-chain rewrite is not needed to resolve these findings.

## 6. Implementation sequence and review boundaries

Implement in separate reviewable changes; this is not authorization to deploy or merge all code automatically.

1. **Safe verification and setup:** R09, then R08/R10. Establish guarded disposable database testing, platform-correct assertions, request-bound settings reads and the first-install guide/smoke flow.
2. **Priority integrity:** R01–R03 together where selection/allocation interfaces overlap. Introduce real PostgreSQL regression fixtures before changing behavior; verify the whole standard and First-Year publication sequence.
3. **Closure/capacity integrity:** R04/R05. Share bounds and capacity accounting across preview/confirmation/manual recovery, then prove concurrency and rollback with PostgreSQL.
4. **Identity and interaction reliability:** R06/R07/R11. Align schemas, recover pending states, bound upload materialization and keep existing ownership/revision guarantees.
5. **Cleanup and navigation:** R12 and Section 4. Remove verified dead paths, transfer meaningful tests, consolidate the landing CTA and retire unused aliases. Keep cleanup diffs separate from scheduling fixes where possible.

Use the existing technologies and service boundaries. Extract shared policy/occupancy helpers where they remove demonstrable divergence; do not add a new scheduler framework or reintroduce retired features. No production-data backfill, legacy-user migration, or automatic deployment is part of this work.

## 7. Required acceptance matrix before first deployment

| Scenario | Required result |
|---|---|
| Truly empty PostgreSQL database | Migrations apply, second run is a no-op, reference seed succeeds, no human/test staff or students appear implicitly. |
| First administrator | Working verification delivery, temporary-password replacement and administrative access without SQL intervention. |
| First academic year/import | Guide includes year creation; standard and First-Year imports publish complete valid records. |
| First-Year protection | OJT/Tour never move First-Year appointments through the ordinary Regular displacement path. |
| Full preferred month / full cycle | Necessary eligible displacement is considered; ineffective victims stay untouched; exhausted recovery becomes manual. |
| Mixed recovery types | One global FCFS order, deterministic results, completed Laboratory preserved for PE-only recovery. |
| Last day / custom closing date | Every automatic/manual closure and OVPSA recovery path honors the same-cycle bound and appropriate date gap. |
| Closures and reopening | Preview agrees with unchanged-state confirmation; protected work preserved; reopened dates do not automatically restore appointments. |
| Concurrent scheduling/settings | No double-claimed final slot, invalid capacity reduction or partial audit mutation. |
| Manual student maintenance | Required identity cannot be erased; valid save succeeds twice without reload. |
| Failure recovery | JSON error, HTML error, rejected request and duplicate click result in useful UI state and no unintended repeat mutation. |
| Result lifecycle | Multi-upload, finalize, edit/resubmit, invalidation, ownership denial, file limits and old-official-revision preservation all pass. |
| Historical reporting | Snapshot provenance, effective appointment selection and report/PDF assertions continue to pass after replacements and cleanup. |
| Test isolation | Unit tests need no DB; integration tests refuse unsafe DB identity and leave no fixtures in the application DB. |
| Build and deployment runtime | Production build completes without reading operational DB rows; configured runtime delivers queued mail/no-show/cleanup work and retains files across restart/release. |
| Navigation and accessibility | One clear student entry; intended routes available; controls usable at narrow widths, short heights and by keyboard. |

Record command outputs and fixture identities for the final verification run. A green unit suite alone does not satisfy the PostgreSQL, browser, SMTP or durable-storage gates above.

## 8. Decisions proposed for approval

- Use targeted fixes and verified cleanup rather than a scheduler rewrite.
- Keep current mandatory email verification and document/provision its prerequisites.
- Enforce the same future/cycle rules for closure replacements as other replacements.
- Reject capacity reductions that conflict with committed current/future workload; do not silently reschedule from settings.
- Replace the two student landing CTAs with one prominent **Student sign in** action.
- Remove verified dead code and unused predeployment compatibility aliases; keep live First-Year, history, revision and audit behavior.

This specification is complete as a review proposal. Its implementation, real-database regression verification and deployment acceptance remain subsequent work.
