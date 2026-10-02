# Whole-branch review: student portal upload-only email verification

Reviewed 2026-10-02. Base `7940f3e`; implementation head `311682e`. Scope includes all 49 changed code/test/document files, the binding September 29 design, October 1 plan and controller rulings in `progress.md`, plus the uncommitted evidence document and three desktop screenshots. This is the requested single broad review; no subagents or heavy test suites were dispatched. Application files, index, HEAD and branch were not changed. Only this requested ignored scratch report was written.

## Strengths

- The authorization change is narrow and consistent. Schedule, Notifications and Results use the active database-backed student guard. Notification GET/PATCH and official downloads use authenticated identity, while every draft/upload/edit/finalization route still calls `requireVerifiedStudent()` before parsing input or invoking its service. The strengthened route tests check absence of downstream calls/body reads, not merely helper names.
- The overview obtains official documents through a separate read-only projection. Current and historical queries share FINALIZED, undiscarded, Laboratory type, matching appointment/submission ownership and file-eligibility predicates with direct downloads. Configured Manila closing dates, deterministic ordering, official revision visibility during editing and private-file ownership/checksum checks are retained. No draft manager is mounted by reading the overview, and workspace entry links disable prefetch.
- Continuation uses a small pure allowlist at construction, page parsing and client navigation. Arrays, arbitrary URLs and malformed destinations cannot reach a redirect. Already-verified explicit continuation and ordinary replacement-email navigation remain distinct. Polling handles a non-JSON 401 before body parsing, stops after success/unmount/session expiry and prevents overlapping requests.
- Every stale-workspace mutation shares the 403 handling, clears selected browser files and confirmations, disables further actions and provides a constrained verification link without replay. Token confirmation remains explicit POST and creates no session. Backend token/outbox/staff contracts were not modified.
- Active policy/install/acceptance documentation describes the changed capability accurately and explicitly preserves the older token/outbox/staff rules. No schema migration, imported-email backfill, role/cookie or environment-variable change was introduced. The observed fixture repairs preserve production contracts and meaningful assertions.
- The evidence distinguishes actual desktop observations, real HTTP responses, automated coverage and unavailable coverage. I inspected all three desktop screenshots: navigation, current/historical document separation, verification action and submitted state are legible, without clipping or overlap. I independently compared the settled, verified, editing and stale before/after JSON snapshots; all four pairs are byte-identical. The HTTP evidence contains the reported 37 pre-verification and 5 post-verification responses.

## Issues

### Critical (Must Fix)

None found in the reviewed implementation.

### Important (Should Fix)

No newly introduced application correctness, security or behavior defect found. The following are existing completion gates, not additional production-code findings:

1. The final serialized integration log currently records 567/567 test bodies passing but one failed suite: `src/server/services/schedule-import-lifecycle.integration.test.ts:72` queries `pool` after teardown has ended it. The gate exits 1, so it cannot count as passing. The controller already assigned the narrow fixture cleanup-order repair; its delta and fresh exit-zero aggregate result are pending this report.
2. The full ordinary unit gate, final owned-cluster/process/storage cleanup and final evidence/checklist update remain pending. Earlier focused passes and the earlier full suite do not replace the final required gate.

### Minor (Nice to Have)

- Existing deliberate failure-injection output, particularly `src/test/test-database.integration.test.ts:43-72`, prints `DISPOSABLE DATABASE CLEANUP FAILED` during the identity-drift scenario before its own finally block proves the renamed database was dropped. That test retains its OID ownership check and zero-OID assertion, so this is noisy successful-test output rather than a demonstrated cleanup defect. Capturing/asserting the expected diagnostic would improve readability, but deferral is reasonable and it is not a merge blocker. The existing PDF/cleanup failure-injection diagnostics are treated the same way; real aggregate exit failures remain blockers.

No other actionable findings were identified. No application fix wave is requested by this broad review.

## Verification and evidence assessment

- Independently inspected the changed production code and focused tests, the current effective appointment query, existing download services and schema constraints that the new behavior relies on. `git diff --check 7940f3e..311682e` passed.
- Read the migration proof: 29 applied, exact ledger/schema assertions, second run zero, atomic rollback/connection reuse and owned database removal, exit 0. Read the production build tail with exit 0. Task and focused results in the ledger/evidence remain reported evidence; I did not duplicate those suites.
- The timestamp-only verified-page shortcut does not create a reachable redirect loop for the fresh schema: migration 008 prevents a non-null verification timestamp without a nonblank email, while the actual upload guard independently requires both. No issue is raised from an impossible persisted fixture state.
- The legal-fixture approach to submission/appointment ownership or type mismatches is sound: the deferred integrity trigger rejects those mismatches; production projection predicates still defend both sides. Weakening the database to create corrupt fixtures is unnecessary.
- Desktop Browser execution was performed by the controller; this reviewer inspected its evidence and screenshots, not a second live Browser run. The retained screenshots are desktop-sized and cannot establish narrow-screen behavior.
- Narrow-screen acceptance required by the design remains unverified because the documented viewport request did not change the actual DOM/screenshot width. The separate verified-student SMTP-outage Browser step was also not performed, as the evidence states. These are explicit acceptance coverage limitations, not inferred UI or SMTP defects. Do not claim every design acceptance item passed. The executor must record its disposition of these limitations in the final handoff.
- The evidence draft must be updated after final runs and cleanup: it currently labels aggregate results/cleanup pending and describes the October 1 preservation of the user's port-3000 process. The October 2 resumed environment has no such process according to the controller; preserve the historical observation while recording the final state accurately.
- Task 4 checkboxes should be finalized with actual outcomes, leaving unavailable narrow acceptance explicitly qualified rather than marking it as passed.

## Declined to judge

- Live migration/backfill or feature-flag compatibility for existing production student accounts: the binding design explicitly assumes first deployment with a fresh database and excludes a production-data transition.
- A redesign of database-outage handling in the existing authentication helpers, global session semantics or staff onboarding: those contracts are intentionally preserved and this branch does not change them.
- Refactoring existing certificate-download concurrency/revision behavior, upload storage architecture or clinical completion rules: outside the approved capability change; the relevant existing ownership/status/checksum and clinical eligibility checks remain in place.
- Adding a permanent acceptance-harness product script solely to replace the ignored rehearsal: the controller explicitly ruled that the existing tested ownership/storage utilities plus real guarded rehearsal satisfy Task 4.
- General test-output cleanup for unrelated intentional PDF/storage failure scenarios: not required to implement this feature; assessed as the deferred Minor above, not silently ignored.

## Assessment

**Spec compliance:** Production behavior is compliant with the approved access/projection/continuation design and documented controller rulings. Full acceptance completion is not yet established because the aggregate gates/cleanup are pending and narrow-screen proof is unavailable.

**Code quality:** Approved. The changes preserve the existing capability boundaries, centralize the relevant policy predicates, avoid a schema or authorization expansion, and include meaningful denial/no-side-effect tests.

**Ready to merge?** Conditional approval of the code, not unconditional whole-delivery approval yet. Require the known teardown repair and scoped review, exit-zero final unit/integration gates, verified owned-resource cleanup and updated evidence. Retain explicit narrow-screen and verified-SMTP Browser limitations in the handoff. If those gates pass, no additional broad application review or production fix is requested by this report.

## Scoped fix addendum: 311682e to 495dda4 (2026-10-02)

- **Lifecycle afterAll queries the pool after teardown ended it** — ADDRESSED. `src/server/services/schedule-import-lifecycle.integration.test.ts:68-87` now runs fixture-row cleanup and owned academic-year deletion inside the callback passed to `teardownCapacityFixtureLock`, before that helper closes the pool. The deletion remains limited to `createdAcademicYears`, populated only from INSERT RETURNING at lines 50-56; preexisting years are not selected for deletion.
- **Failure and resource handling** — Approved. The callback attempts owned-year deletion even if row cleanup fails and propagates the first actual Error. The unchanged helper then attempts capacity restoration (`src/test/capacity-fixture-lifecycle.ts:70-86`), advisory unlock, client release and pool closure (`:24-48,117-134`) before propagating failure. The fix does not move cleanup outside the held fixture lock, suppress test failures, change shared helpers or alter production behavior.
- **New breakage in the fix diff** — None.
- **Out-of-scope observations** — None newly identified; earlier aggregate-gate and Browser limitations remain as documented.
- **Checks inspected** — Read the supplied scoped package once, Task 4 brief and appended repair report; inspected relevant unchanged helper control flow only to verify the changed callback contract. RED log records four passing test bodies plus the exact ended-pool afterAll failure, exit 1. GREEN log records one file/four tests and successful teardown, exit 0, private-storage entries 0 and owned database residue 0. Scoped lint log records exit 0. No tests or git commands rerun and no subagents dispatched.
- **Task 4 fix spec compliance** — Compliant with the controller-authorized fixture-only repair and owned-resource cleanup requirements.
- **Task 4 fix code quality** — Approved.
- **Fix round verdict** — All findings addressed, no new Critical/Important breakage. Important completion item 1's code defect is closed; passing final aggregate integration/unit gates and final cleanup/evidence remain pending for whole-delivery closure.

## Final proof-closure addendum (2026-10-03)

Scope: closure of the existing review's verification/documentation items only, using `final-proof-package.md`, its named logs, the updated permanent evidence and Task 4 checklist. No application re-review, gate rerun, subagent dispatch or application/branch/index mutation was performed. Production code remains at the already approved implementation; fixture fix `495dda4` remains approved.

### Resolved review items

- **Final ordinary unit gate — CLOSED.** `final-unit-cached.log` records 211/211 files and 1,223/1,223 tests passed, 1,280.74 seconds and `GATE_EXIT=0`. `unit-startup-recheck.log` independently records the previously absent calendar file's nine tests passing with exit 0. The evidence keeps earlier timeout/worker-start failures separate and explains the supported compile-cache retry without runner patches or assertion changes.
- **Final aggregate integration and teardown — CLOSED.** `final-integration-postfix.log` records 69/69 files and 567/567 tests passed, 384.41 seconds, storage entries 0, owned database removal with residue 0 and `GATE_EXIT=0`. This closes the aggregate proof condition left after the approved ended-pool repair; successful test bodies are now accompanied by successful suite teardown.
- **Final lint/type and retained build/migration proof — CLOSED.** Final TypeScript and full ESLint logs contain `GATE_EXIT=0` without diagnostics. The named build log retains exit 0. The migration log retains 29 applied, exact ledger/schema assertions, second run zero, atomic rollback/connection reuse and owned target removal, exit 0. The documentation accurately says the production build precedes only documentation/test-fixture changes.
- **Narrow Browser acceptance — CLOSED on the recorded live rehearsal evidence.** The controller's fresh October 2 rehearsal documents effective narrow DOM/content widths and successful reading/navigation/mark-read/current-historical downloads, real token interruption/confirmation/poll return, editing and initial submission. I inspected all five new retained images: their narrow layouts have wrapped navigation, readable cards and filenames, accessible action controls and no visible horizontal clipping. These images establish a genuinely narrow layout, unlike the earlier desktop-width attempt; the earlier limitation is superseded rather than relabeled as a pass.
- **Verified-student SMTP-outage Browser coverage — CLOSED on the recorded live rehearsal evidence.** Updated evidence records verified Schedule, Notifications and Results reads and both official downloads while the sink was stopped. The corresponding narrow Results screenshot is consistent with verified management and Laboratory/PE download availability. This reviewer did not independently repeat the live SMTP outage; the reviewed result is the controller's actual rehearsal evidence.
- **Database/private-storage/server cleanup — CLOSED.** `final-cleanup-proof.log` records separate catalog proof of zero named test databases, exact owned postmaster/path verification, successful `pg_ctl` stop, no owned listeners/postmaster and absent integration/Browser private-storage paths. The historical port-3000 preservation observations are now correctly distinguished from the already-absent resumed environment.

### Remaining qualification and delivery bookkeeping

Physical cluster-directory deletion is **not complete**. Automatic approval review rejected the native PowerShell deletion with `blocked by policy` and no detailed reason. The stopped ignored `.data/student-portal-postgres-20261001` directory remains, with no named test databases, live postmaster or owned listeners. The report and permanent evidence correctly disclose this instead of claiming total filesystem residue zero. No bypass or alternate deletion method is required by this review. This local physical-cleanup qualification is not an application correctness, security or merge-readiness defect.

The final Task 4 checkbox remains open for commit/review completion. Root should finish that bookkeeping with the physical-cleanup qualification retained and replace the permanent evidence's “Proof-review closure is pending” sentence with this actual result. The feature branch remains retained with no merge/push; any later plan-scratch cleanup result must also be reported accurately.

### Final assessment

**Spec compliance:** Approved for implemented behavior and recorded desktop/narrow acceptance. The two earlier Browser coverage limitations are resolved. The only remaining operational qualification is the policy-blocked deletion of the stopped ignored cluster directory.

**Code quality:** Approved; no new findings from proof closure. The previously deferred expected failure-injection diagnostics remain non-blocking Minor output noise, distinct from actual failing gates.

**Ready to merge?** Yes from the completed code and verification review, with the explicit physical-cleanup qualification above. No further application fix, broad review or repeated gate is requested. This verdict does not authorize merging or pushing; the requested delivery retains the feature branch. Final evidence commit and checklist bookkeeping are controller-owned finishing actions.
