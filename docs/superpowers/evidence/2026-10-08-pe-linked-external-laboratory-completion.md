# PE-linked external Laboratory completion evidence

Implementation of the [approved plan](../plans/2026-10-08-pe-linked-external-laboratory-completion.md) and [design](../specs/2026-10-08-pe-linked-external-laboratory-completion-design.md) on `codex/pe-linked-laboratory`, from `22020b3`. The baseline differs from the plan's `9dba421` only by the design/plan documentation commit.

Local Windows acceptance used Node 24.19, locked dependencies, PostgreSQL 18 and a separately owned loopback database on port 55440. All 32 migrations and reference seeds ran before synthetic setup. No schema, dependency, appointment accounting or capacity change was introduced.

## Executed implementation checks

Each implementation task followed RED/GREEN before its commit. Task 1 passed 25 policy/requirement tests and six checklist integration tests. Task 2 passed nine checklist/finalizer integration tests and three endpoint tests. Task 3 passed 27 selected integration tests and six context/replay tests. Task 4 passed 32 UI/detail/endpoint tests. Task 5 passed 66 integration tests across PE-linked lifecycle, checklist, appointment locking and database invariants.

Browser acceptance found two UI gaps: the published PE list still required a raw Laboratory Completed status, and the read-only detail retained its pre-issuance checklist state. Four list regressions and two server-prop refresh regressions failed before the respective fixes. The final focused UI run passed **40 tests in four files**, including checklist, published list, completion form and dialog.

## Authenticated Browser acceptance, October 8–9, 2026 (Manila)

Four synthetic students, eight existing appointments, complete immutable import/snapshot provenance and an active synthetic physician were prepared through the guarded fixture. First-Year used a real `FIRST_YEAR_OVPSA` publication with owned reservations. The ordinary Laboratory/PE dates were October 7/8; First-Year dates were October 8/15. Both actual examinations were recorded on October 8. Capacity remained 100 per service.

- KABALAKA staff verified OJT CBC, Urine and Stool, leaving four required tests with only X-ray disabled and 3/4 Pending. The initial automatic no-show correction retained its required explanation. Ordinary controls kept their three manual tests.
- CPU staff saw eligible OJT and First-Year list actions. OJT with missing CBC/Urine/Stool displayed the named blockers with preview/submit disabled; the ordinary incomplete Laboratory retained its prerequisite. Paired checklists on PE detail were read-only.
- OJT Class A preview was cancelled. Exact serialized state across 15 clinical/document/audit/notification categories was unchanged (SHA-256 `f48dbff5afb3e4bdfc3b87d60d4cb6cfebe9e1ebfb3fe3072e97d0b17cb938bb`). Submit produced 4/4 and completed both appointments with one certificate.
- First-Year 0/4 Pending was ready for PE. The form required one hospital-specific attestation. A future actual examination date was correctly rejected; October 8 was accepted. A remarked Class B preview was cancelled and all 15 state categories were unchanged (SHA-256 `d92ddea38897db10965097ed0123d9dcb5d559816c91884e655befdb503b1afd`). Submit produced 4/4, both appointments Completed, one external summary/result and one certificate.
- Reload retained checked 4/4 on PE detail and OJT Laboratory detail. The staff First-Year list label changed from **Awaiting confirmation at Physical Examination** to **COMPLETED**.
- Both unverified students signed in, saw both current appointments Completed and read Results. Their own Class A/B JPGs downloaded through the Browser's actual link/download event. Both downloads matched stored certificate SHA-256 and byte length and decoded as 3508×2480 JPEGs. OJT upload management redirected to email verification with the correct appointment-bound return destination; no verification email was sent.
- The resumed student and staff tabs had zero captured console errors. The Browser's initial media-download helper timed out during compilation; the subsequent actual download events succeeded. Interrupted prior test jobs are not passing evidence.

The saved [fixture state](pe-linked-browser-state.json) records two certificates, five external events, one First-Year summary, zero upload drafts/files, two certificate notices, no email outbox work for these unverified students and unchanged capacity. OJT Laboratory document status is `PENDING_UPLOAD`; First-Year external result is `COMPLETED` with the Manila confirmation date October 8. The October 9 startup no-show catch-up affected only the unfinished controls.

The matching guarded cleanup passed: zero synthetic students, appointments, submissions, notifications, staff and physicians; capacity unchanged. Subsequent status returned `prepared: false` and the fixture manifest was removed.

| Student | Downloaded certificate SHA-256 | Bytes |
| --- | --- | --- |
| OJT `99-9331-91` | `90bf90bc0081085ed4970f2ad32d954ecdd9d2a10e64217c251eec0c359d608f` | 540477 |
| First-Year `99-9333-91` | `2fafd52f07060711e2f83db633f8fc47276867164b976d4e8aa270b0ae5e2149` | 577557 |

[OJT 3/4 Pending](pe-linked-ojt-pending-browser.jpg) · [OJT preview](pe-linked-ojt-preview-browser.jpg) · [OJT missing-manual blockers](pe-linked-ojt-blocked-browser.jpg) · [OJT completed](pe-linked-ojt-completed-browser.jpg) · [OJT Laboratory detail](pe-linked-ojt-laboratory-detail-browser.jpg) · [OJT student Results](pe-linked-ojt-student-browser.jpg) · [Downloaded OJT certificate](pe-linked-ojt-student-certificate.jpg)

[First-Year 0/4 Pending](pe-linked-first-year-pending-browser.jpg) · [First-Year preview](pe-linked-first-year-preview-browser.jpg) · [First-Year completed](pe-linked-first-year-completed-browser.jpg) · [First-Year student Results](pe-linked-first-year-student-browser.jpg) · [Downloaded First-Year certificate](pe-linked-first-year-student-certificate.jpg) · [Laboratory list reload](pe-linked-laboratory-list-reload-browser.jpg) · [Console check](pe-linked-browser-console.json)

Exact synthetic preview snapshots: [OJT before](pe-linked-ojt-preview-before.json) / [after](pe-linked-ojt-preview-after.json), and [First-Year before](pe-linked-first-year-preview-before.json) / [after](pe-linked-first-year-preview-after.json). Each pair has identical bytes and matches the SHA-256 above. Narrow `.gitattributes` rules disable line-ending conversion for these PE-linked JSON/TXT artifacts so checkout preserves their recorded hashes.

## Acceptance coverage

| Requirement | Evidence |
| --- | --- |
| A1 missing OJT manual tests | Each missing-code service case; Browser named blockers and disabled preview/submit |
| A2 OJT 3/4 ready → 4/4 completion | Integration persisted events/version/result/snapshot; Browser Class A issuance and reload |
| A3 First-Year 0/4 ready → 4/4 completion | Real OVPSA integration fixture; exact preview state equality; Browser remarked Class B |
| A4 PE-managed check/uncheck | Integration no-op/check/uncheck rejections with unchanged evidence; endpoint 422 contract |
| A5 ordinary categories | Pure required-set policy cases and preserved full Laboratory prerequisite; Browser ordinary control |
| A6 immutable/wrong provenance | Live-year mutation, replacement lineage, missing provenance and wrong current OVPSA revision/batch tests |
| A7 authority/current identity | Coordinator/KABALAKA/deleted/expired/unonboarded rejection; CPU manual CBC rejection |
| A8 failure/preview atomicity | Exact state snapshots for preview, render/final-write failure and invalid classification/date/physician/cycle |
| A9 replay/concurrency | Same-request/different-request barriers; one certificate/summary/version increment and no duplicate notices |
| A10 manual correction/replacement races | Real-render barriers and sorted shared locks; stale issuance rejects without partial effects |
| A11 correction/revocation | Original confirmation metadata/verifier/timestamps/events preserved across correction/preview/revocation |
| A12 midnight sweep | First-Year external exclusion and OJT progress preservation tests; ordinary Browser no-show catch-up |
| A13 documents/verification/ownership | Lifecycle integration result separation; Browser no files/drafts, unverified reading/downloads and upload verification gate; extended student-result tests included in final integration gate |
| A14 classes/history | B/C/D remarks rules, non-Class-A findings and closed-cycle mutation cases; Browser remarked Class B |
| A15 reload/student access | Staff list/detail and student completed schedule/Results; actual matching private JPG downloads |

## Gates before the final review

The final gates run after the last Browser-driven source fix, with the owned acceptance server stopped. Only its generated development cache was archived before the fresh TypeScript/build checks. Earlier interrupted jobs and the stale generated `.next/dev/types/validator.ts` typecheck failure do not establish a pass.

| Gate | Executed result |
| --- | --- |
| `npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism --testTimeout=60000 --hookTimeout=60000 --reporter=default` | **PASS:** 218 files, 1,276 tests, exit 0; no skipped files or unhandled errors |
| `npm run test:integration -- --testTimeout=180000 --hookTimeout=180000 --reporter=dot` | **PASS:** 74 files, 626 tests, exit 0; database/storage residue 0 |
| `npm run test:migrations:empty` | **PASS:** exact 32 migrations, replay 0, atomic DDL/history rollback; exit 0, database residue 0 |
| `npm run lint` | **PASS:** exit 0 |
| `npx tsc --noEmit` | **PASS:** fresh production-generated types, exit 0 |
| `npm run build` | **PASS:** Next.js 16.3.5 production build, exit 0 |

All six final gates passed against source commit `71969bac9d562c132fa0a73bb989687e604f537d`. The integration gate completed October 9 after that last test correction; the other five completed October 10. The retained integration exit record and log SHA-256 were checked before resuming. Only evidence packaging changed during this run. Superpowers recorded Task 6 complete after all six exit-zero results.

The [gate manifest](pe-linked-final-gates.json) records exact commands, source commit, timestamps, durations and raw log hashes. Raw logs: [unit](pe-linked-final-unit.txt), [integration](pe-linked-final-integration.txt), [fresh migrations](pe-linked-final-migrations.txt), [lint](pe-linked-final-lint.txt), [build](pe-linked-final-build.txt) and [typecheck](pe-linked-final-typecheck.txt). The empty typecheck log is paired with its exit-zero manifest record. The [executed wrapper](pe-linked-final-gates-command.txt), [task-done output](pe-linked-task-6-gates.txt) and [execution ledger](pe-linked-execution-ledger.txt) preserve the final gate procedure and task history.

The first final unit attempt passed 216 files/1,258 tests but failed with two fork-worker startup errors before the remaining files ran. Installed Vitest uses a fixed 60-second startup handshake. Both omitted files passed an isolated single-worker recovery run (two files/18 tests, exit 0), then the full serialized run above passed without worker errors. No dependency, source or assertion change was made for that runner failure.

The first completed full integration run failed because the expanded synthetic cleanup tried to collect a null source-import ID from draft OVPSA batches. That rolled back cleanup and left fixtures affecting later suites. A dedicated regression reproduced the exact failure and also checks preservation of unrelated batches and re-enabled immutability triggers. Cleanup now skips absent source imports. The fresh full integration run after that helper change passed all 626 tests; the failed run is retained as recovery evidence.

The [cleanup regression RED](pe-linked-cleanup-regression-red.txt) and [focused recovery GREEN](pe-linked-cleanup-recovery-green.txt) show the exact failure followed by 92 passing tests across cleanup, manual rescheduling, unified calendar and priority displacement. The owned recovery database and storage were removed with zero residue.

The subsequent full unit, integration, migration and lint gates passed, but TypeScript identified an unsupported `exact` option in a newly added role query. The query now uses an anchored accessible-name matcher. All 17 schedule-list tests and the compiler passed in focused recovery. Application behavior is unchanged; the complete six-gate run repeats after this test correction, with compile checks first. Build was not reached in the failed run.

The next lint/build/fresh-typecheck gates all passed, but full integration found one order-dependent existing assertion: it assumed every audit mentioning academic year 2095 belonged to its failed import. Adding two unrelated import audits reproduced the exact failure in isolation. The rollback test now compares complete audit rows before and after and still requires zero student/snapshot/appointment writes. All 20 tests across academic-year races, checklists and First-Year imports passed with zero database/storage residue. No application behavior changed; the six final gates repeat after this test-isolation correction.

A further integration run exceeded the 60-second limit in the unchanged Reports partial-cleanup fixture test. Unfinished asynchronous fixture cleanup left rows that caused later failures; the failed target database and storage were still removed with zero residue. The Reports lifecycle and all four affected suites passed together with a 180-second test/hook limit (five files/76 tests). No source, assertions, ownership checks or constraints changed for this runtime recovery. The final integration command uses that larger limit; unit tests retain one worker and the 60-second limit.

## Review and decisions

The October 9 overnight unit repeat ended with exit 1: the fork worker for `ClinicUnavailableCalendar.test.tsx` did not respond to the fixed startup handshake. Its 217 files/1,267 passing tests are not a passing gate. The [failed reporter output](pe-linked-unit-worker-start-failure-oct10.txt) is preserved. The [focused thread-pool recovery](pe-linked-unit-thread-recovery.txt) passed all nine omitted tests; the fresh full thread-pool run passed all 218 files/1,276 tests with exit 0. It retained one worker, default isolation and the unchanged database-free setup; no assertions, dependencies or product source changed. The integration pass remains valid for unchanged source commit `71969bac9d562c132fa0a73bb989687e604f537d` and its retained log SHA-256 is verified before the remaining gates run.

The fresh whole-branch review compared `22020b3..0c4a195`. It returned two Important findings and no Critical or Minor findings. Both Important findings were addressed together in one TDD pass; no second whole-branch review was requested. The [review report](pe-linked-final-review.md) and [review package](pe-linked-final-review-diff.txt) are preserved.

Actual PostgreSQL service concurrency reproduced `40P01` for cancellation versus PE readiness, final issuance and final correction. An issuance/cancellation/correction-preview case reproduced `LABORATORY_PROVENANCE_MISSING`. All four failed before implementation and passed after aligning the shared scheduling queue before student scopes and allowing completed historical provenance during correction. New issuance still requires the active current published batch. The [RED](pe-linked-review-fixes-red.txt), [GREEN](pe-linked-review-fixes-green.txt), [62-test clinical regression](pe-linked-review-fixes-regression.txt) and [six-test unit recovery](pe-linked-review-fixes-unit.txt) outputs are retained. The full six-gate repeat on source `9ed5731f02d0040bca58d7f3c5a4d66aeae371da` passed.

On October 10, authenticated CPU Browser acceptance issued a synthetic First-Year Class A certificate. The cancellation condition was prepared through the real cancellation service with a guarded helper that verifies the owned database, fixture, completed visits and batch owner; cancellation has an API but no staff UI. Both completed appointments were retained while all membership/reservations were released. The CPU form then previewed and saved a Class C correction. Preview changed none of the 15 state categories (SHA-256 `e561529b21bcc1d47cf372247bb5c49265346e8bfa7f418cf645f30d455b8f48`). Correction preserved nine Laboratory/appointment/document categories and the original confirmation metadata. Reload showed 4/4, revision 2 Issued/Class C and revision 1 Superseded/Class A; console errors were empty. [Browser proof](pe-linked-post-review-browser-proof.json), [preview](pe-linked-cancelled-batch-correction-preview.jpg), [saved/reloaded result](pe-linked-cancelled-batch-correction-saved.jpg) and [cleanup](pe-linked-post-review-browser-cleanup.txt) are preserved. Cleanup returned zero owned rows and unchanged capacity.

Decisions made during execution and review:

1. Keep imported First-Year Laboratory booking under KABALAKA while authorizing CPU external confirmation separately. Tests retain immutable booking and current staff scope. Cost if wrong: valid external checklists could be inaccessible or clinic authority could broaden.
2. Extend the omitted PE list file so authorized Pending/No-show rows open the existing server-context dialog. The dialog supplies policy and blockers without duplicating eligibility. Cost if wrong: a blocked case could open an explanatory form, or an eligible case could lose the list action.
3. Keep execution local-only; hosted/Linux readiness and SMTP delivery remain unproven. Cost if wrong: hosting or delivery failures could first appear outside the tested local environment.
4. Preserve authorized staff attestation as evidence of external hospital tests. Cost if wrong: an incorrect attestation can record tests that were not performed.
5. Preserve the approved fresh first-deployment assumption without historical backfill or inferred clinical facts. Cost if wrong: pre-existing data would require separate validation and repair.
6. Preserve the existing actual examination date contract: open academic year, no future date and not before Laboratory, including a date before the booked PE date. Cost if wrong: early encoding remains possible where another business rule was intended.
7. Reproduce both review findings against real PostgreSQL and actual services before the single fix pass. Cost if wrong: a nonrepresentative reproduction could leave the reported failure reachable. The new tests actually reproduced three database deadlocks and the blocked historical correction before passing after the fixes.

No Minor findings were deferred.

## Final gates after the review fixes, October 10, 2026

All six gates ran freshly against source commit `9ed5731f02d0040bca58d7f3c5a4d66aeae371da`, after the single review-fix pass and authenticated Browser correction acceptance. No previous integration or unit pass was substituted for these runs.

| Gate | Final result and retained proof |
| --- | --- |
| Integration | **PASS:** 74 files / 630 tests, no skipped tests, exit 0; DB/storage residue 0. [Output](pe-linked-post-review-final-integration.txt) |
| Unit | **PASS:** 218 files / 1,276 tests, no skipped tests or unhandled errors, exit 0. [Output](pe-linked-post-review-final-unit.txt) |
| Empty migration | **PASS:** exact 32 migrations, replay 0, exact schema/history, atomic DDL/history rollback and connection reuse, exit 0; DB residue 0. [Output](pe-linked-post-review-final-migrations.txt) |
| Lint | **PASS:** exit 0. [Output](pe-linked-post-review-final-lint.txt) |
| Production build | **PASS:** Next.js 16.3.5 production compilation, TypeScript and prerendering, exit 0. [Output](pe-linked-post-review-final-build.txt) |
| Typecheck | **PASS:** standalone compiler against fresh production-generated types, exit 0. [Output](pe-linked-post-review-final-typecheck.txt) |

The [gate manifest](pe-linked-post-review-final-gates.json) records the source commit, each command/exit code/timestamp/duration and raw log SHA-256. The [runner](pe-linked-post-review-gates-command.txt), [complete execution ledger](pe-linked-execution-ledger.txt) and [wrapper output](pe-linked-post-review-final-wrapper.txt) preserve the sequence. Both Important findings are fixed; Critical findings and deferred Minor findings are zero.

The [task TDD archive](pe-linked-task-tdd-proof.zip) preserves the task briefs and raw RED/GREEN/test-run logs; its [index](pe-linked-task-tdd-proof-index.json) records byte counts and SHA-256, checked against every ZIP entry. The [owned-service shutdown proof](pe-linked-post-review-owned-services-stop.txt) records matching data-directory/database/role/loopback identity, PostgreSQL stop/status and zero acceptance-port listeners. The plan's scratch directory is removed after proof preservation. The named Git worktree and branch remain for the user's integration choice.

Final archive verification checked all six fresh exit-zero gate records and matching SHA-256 logs, preview byte equality, and 62 JSON/TXT files against their Git blobs. The whole-branch whitespace check found one extra terminal blank line in `laboratory-checklist.service.ts`; that line alone was removed after the gates. Ignoring blank lines, all source/scripts/schema/package files exactly match the verified `9ed5731` code. The whole-branch check then exited 0; the formatting-only adjustment did not require another full suite run.

This is local implementation/acceptance evidence. Hosted/Linux execution and SMTP delivery are outside this run. No deployment, merge or publication is implied.
