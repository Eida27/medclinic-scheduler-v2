# Student portal upload email verification — observed implementation evidence

Browser rehearsals: 2026-10-01 and 2026-10-02; final CLI verification continued on 2026-10-03, Asia/Manila. Branch: `codex/student-portal-upload-email-verification`.

Implemented the [September 29 design](../specs/2026-09-29-student-portal-upload-email-verification-design.md): authenticated active students can read Schedule, Notifications and Results, mark their own notices read, and download eligible official documents. Laboratory workspace entry and every submission action remain verified-only. The Results overview uses a pure official-document projection; verification preserves only an allowlisted local destination.

## Verification gates

Commands used the bundled Node 24.19.0 executable directly with the package scripts' payloads because the Windows `npm.cmd` shim could launch system Node 26.4.0 despite a PATH override. No warning suppression or production workaround was added.

| Gate | Observed result |
| --- | --- |
| Task 1 focused / full ordinary tests | 131 focused tests passed; 210 files / 1,188 full-suite tests passed, exit 0. |
| Official-document query integration | Six query/fixture tests plus a preceding Schedule Import test passed in one disposable run; existing academic-year fixture restoration was asserted. |
| Task 3 continuation/workspace tests | 55 focused tests passed; exact reassurance-copy RED/GREEN fix subsequently passed all 10 form tests. |
| Email lifecycle integration | 20 tests passed with the real database/token/outbox services. |
| Fixture repair integration | 3 files / 54 tests passed, exit 0; all clinical, replay, ownership and cleanup assertions retained. |
| Full lint | Final-tree rerun exit 0, no diagnostics. |
| Final-tree TypeScript | `tsc --noEmit` exit 0, no diagnostics, including the later fixture changes. |
| Production build | Exit 0; Next 16.3.5 compilation, TypeScript, route collection and page generation completed. A Node DEP0205 runtime diagnostic was retained. |
| Empty-database migration gate | Exit 0: first production CLI run applied 29 migrations, exact ledger/final schema asserted, second applied zero; forced DDL/history rollback and connection reuse passed; owned database removed. |
| Final full ordinary unit gate | **211 files / 1,223 tests passed, exit 0**, 1,280.74 seconds. Default forks, one worker, normal isolation, database-free guard, Node compile cache, 30-second tests / 60-second hooks. No unhandled worker errors. |
| Final full integration gate | **69 files / 567 tests passed, exit 0**, 384.41 seconds. All 29 migrations/reference seed applied; private storage entries 0 before removal; owned target dropped, database residue 0. |

Initial integration fixture corrections were limited to preserving/restoring existing academic years, using future Manila-relative appointment dates, supplying mandatory manual-lock metadata, and bounded real create/drop test allowances. No schema or production clinical/authentication service was changed for these repairs. Final aggregate runs were serialized to avoid competing build/test/Browser resource use; integration used bounded 30-second tests and 60-second hooks, retaining explicit per-test bounds.

The preceding serialized integration attempt passed all 567 test bodies but exited 1 because owned academic-year deletion followed pool shutdown in Schedule Import afterAll. The fixture-only repair passed focused RED/GREEN and scoped review; the final full run above includes successful teardown. Earlier nonzero runs remain failure evidence, not passing gates.

Earlier unit runs are not counted as green: the concurrent run passed 209 files / 1,220 tests but two existing tests timed out at 15 seconds; both unchanged files then passed all 17 tests at that original limit. The next serialized run passed 210 files / 1,214 tests but exited 1 because the calendar worker never started; its nine tests were absent from that count. The unchanged calendar file then passed nine tests at 15 seconds. The full retry above passed all 211 files and 1,223 tests.

The worker-start failure occurred before the calendar test file executed, with the installed runner's separate startup timeout. The successful final retry used the documented [Node compile cache](https://vitest.dev/guide/improving-performance#node-compile-cache) and preserved the default forks pool, file isolation and all assertions. No runner source or dependency version was patched.

Final ordinary unit command (bundled Node 24.19.0; `NODE_COMPILE_CACHE` pointed to this plan's ignored cache directory):

```powershell
& 'C:/Users/anula/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' ./node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism --testTimeout=30000 --hookTimeout=60000 --reporter=dot
```

Final integration used the package's guarded `scripts/test-integration.ts` payload, with `--testTimeout=30000 --hookTimeout=60000 --reporter=dot`. A private environment file supplied the dedicated loopback disposable target and consent; credentials are not retained in this evidence. The same direct Node executable ran the full ESLint payload and `tsc --noEmit` on the final tree. The successful production build predates only documentation/test-fixture changes; application code matches the Browser-tested build.

## Actual Browser and HTTP acceptance

The requested Browser plugin controlled a separate in-app Browser tab against the production build at `127.0.0.1:3100`. The user's authenticated port-3000 tab, dev process and application database were left in place.

The rehearsal used a separately owned PostgreSQL 18 loopback cluster on port 55441 and a freshly created disposable Browser database. It applied migrations 001–029/reference seeds, performed real first-Administrator bootstrap and SMTP-token staff onboarding, configured an academic year, imported five synthetic students, completed Laboratory checklists and PE through domain services, and created official files/certificates. Only the owned synthetic appointment dates were advanced to September 29/30 to exercise completion on October 1. All addresses were `.test` recipients captured by a loopback SMTP sink. No SQL update created an email verification timestamp. One explicit synthetic revocation removed a timestamp to test capability loss; reverification used the real token flow.

Observed desktop journeys:

- A null-email student signed in and landed on Schedule with the complete navigation. Notifications opened, a notice changed from unread to read, and current official Laboratory/PE downloads completed.
- A pending-email student read current Schedule, reschedule history and the administrator-change notice. Mark-read and Results worked. The schedule change created a portal notice and queued zero schedule emails to this unverified student.
- An email-present but unverified student read Notifications and reloaded Results without a forced verification redirect or automatic email request.
- Closing the configured year through the real academic-year service moved the same official Laboratory file and PE certificate into historical lists, with current empty states. Both historical downloads completed. Reopening restored current upload eligibility. Separate query integration tests cover distinct academic years.
- Stopping the SMTP sink did not prevent the null-email student's Results read or official download. In the second rehearsal, the verified student also read Schedule, Notifications and Results and downloaded the current official Laboratory file and PE certificate while the sink was stopped.
- Deliberate management entry preserved the intended appointment in `returnTo`; a fresh student's direct upload bookmark redirected before the upload workspace was initialized.
- Opening the captured confirmation URL showed the explicit **Verify email** button and left the original tab waiting. Clicking it verified the address; the original tab's five-second polling returned to the intended Laboratory workspace without another login. Success copy offered portal/original-tab guidance.
- Ordinary Email verification navigation still offered the replacement-address form after verification. Requesting a replacement retained the current verified address and permitted editing.
- Results continued to show and download the finalized revision while an edit existed. Cancel/discard retained the official result. Restarting, uploading a synthetic replacement, removing the previous draft file and explicitly submitting changes produced the new official file.
- A fresh student's real confirmation returned to an empty Laboratory draft. Browser file chooser upload and explicit final submission succeeded; the new official file appeared in Results and downloaded.
- External and repeated return parameters remained on the local verification page. An explicit valid return on an already verified session redirected to the intended workspace.
- Revoking only the synthetic student's verification while a workspace was open caused the next upload to return the verification-required 403. Selected files disappeared; mutation controls became disabled and a safe verification link appeared. After real reverification the draft still had one file, no selection and no automatic upload replay.
- Signing out in a second tab while the verification page waited produced **Your session expired**, a **Sign in** link and disabled request controls. Focused component tests assert that polling stops on 401 and unmount, with single-flight/transient-retry behavior.

Complementary real HTTP checks passed **37 responses** before verification and **5 responses** after verification. They assert anonymous/tampered-session 401s; authenticated notification reads; all seven unverified workspace/action routes rejecting malformed bodies before parsing with HTTP 403, `STUDENT_EMAIL_VERIFICATION_REQUIRED` and the exact required message; own eligible file/certificate downloads with `private, no-store`; foreign downloads/workspace 404s; forged PE upload workspace 422; and unchanged foreign mark-read state. These were HTTP requests to the running application, not mocked Browser responses.

Read-state comparisons passed after delivery settled, after verification, while an edit existed, and after the denied stale-workspace upload. Compared submissions/status/discard/activity, Laboratory result status, cleanup intents, storage entries, verification request/consumption state, student email eligibility and outbox records remained identical; intended notification read flags were excluded. The first broad comparison detected only an earlier explicit verification delivery changing PENDING to SENT. Repeating the reading journeys against the settled baseline passed without weakening the comparison.

All three acceptance tabs returned empty warning/error console arrays. Downloaded certificate JPG rendering was inspected: landscape A4 dimensions, readable synthetic content/classification and test signature placement, without overlap. These were synthetic records and files.

## Narrow Browser acceptance and retained screenshots

The October 1 viewport attempt did not change the actual 1,265-pixel width, so it was recorded as unavailable. After the resumed Browser environment initialized on October 2, the same documented 390×844 override took effect. The initial Schedule measured 375 pixels and subsequent workspace/Results pages measured 390 pixels, with matching content width and no horizontal overflow.

At that narrow width the real UI completed Schedule/Notifications/Results navigation, own mark-read, current and historical Laboratory/PE downloads, deliberate verification interruption, second-tab explicit confirmation and polling return, edit/cancel/discard, add/remove replacement files and submit-changes. A second fresh student verified through the real token flow, uploaded through Browser's file chooser and explicitly finalized an initial submission; its official Results download succeeded. Both narrow acceptance tabs returned empty warning/error console arrays. The override was reset and both temporary tabs were closed.

Desktop proof: [unverified Results](student-portal-reading.jpg), [historical official documents](student-portal-historical.jpg), [submitted Laboratory revision](student-portal-submitted.jpg).

Narrow proof: [unverified Results](student-portal-narrow-reading.jpg), [active edit](student-portal-narrow-edit.jpg), [historical official documents](student-portal-narrow-historical.jpg), [first finalized submission](student-portal-narrow-initial-submission.jpg), [verified Results during SMTP outage](student-portal-verified-smtp-outage.jpg).

The retained narrow JPEGs are 375 pixels wide. Rendered inspection confirms wrapped navigation, readable cards and usable upload/edit confirmation controls at that width; the Browser's later DOM measurements were 390 pixels. Both measurements establish a narrow responsive layout, unlike the unsuccessful October 1 attempt.

## Cleanup and review

Temporary Browser tabs were closed; the original user tab remained open. The Browser fixture reported its database dropped with residue zero and private storage removed; port 3100 and the SMTP listener were absent. Its idle orchestration process was stopped only after successful fixture cleanup and exact command-line ownership verification. Port 3000 remained owned by the user's original process.

Those preservation observations describe October 1. On October 2 the original port-3000 process/tab were already absent when work resumed; they were not stopped or restarted by this task. The second Browser rehearsal independently reported database residue zero and private storage removal. A separate database query proved no `medclinic_test_%` databases remained, the storage path no longer existed, and port 3100/2526 listeners were absent. Seven exact synthetic download files from the second rehearsal were inspected and removed; only retained evidence screenshots were kept.

After the final integration run, a separate catalog query again proved zero `medclinic_test_%` databases. The exact owned PostgreSQL postmaster/path/loopback port were verified, and `pg_ctl` stopped it successfully, exit 0. Its process and ports 3100/2526/55441 are absent; integration and Browser storage are absent.

Physical cleanup limitation: automatic approval review rejected the native PowerShell deletion of the stopped cluster directory, returning **blocked by policy** without further explanation. No deletion workaround was attempted. The ignored directory `.data/student-portal-postgres-20261001` remains; it contains the stopped disposable cluster, with no named test databases. This is distinct from the verified successful database/storage/server cleanup.

The [whole-branch review and closure addenda](2026-10-03-student-portal-upload-email-verification-review.md) approved spec compliance and code quality. Its October 3 proof addendum closed the final gates, desktop/narrow acceptance and database/storage/server cleanup; the policy-blocked physical directory deletion remains explicitly qualified. No further application fix or repeated gate was requested. Expected diagnostics from preexisting deliberate cleanup/PDF failure-injection tests remain a nonblocking minor output issue. The feature branch is retained for user review; no merge or push was performed.

## Controller rulings, in decision order

1. Permit a one-worker threads pool only if compatible, retaining isolation and database guards. If wrong, the alternative pool could invalidate verification; it was abandoned after a stall and final gates use ordinary forks.
2. Reuse existing tested disposable database/storage guards and an ignored synthetic Browser rehearsal instead of adding a permanent harness. If wrong, future acceptance would need a maintained harness; actual guarded first-deployment proof and cleanup are retained here.
3. Use legal foreign-owner/PE records for exclusion tests because the deferred integrity trigger rejects corrupt submission/appointment pairs. Keep both defensive query predicates. If wrong, additional query-level proof is needed; schema integrity must remain enabled.
4. After the optional threads stall, use focused per-task gates and reviews, carrying one full ordinary serialized unit suite to final code. If wrong, a regression is discovered later; full final coverage and review remain required.
5. Repair owned academic-year cleanup before the integration fixture's pool shutdown, preserving lock, restoration and failure handling. If wrong, fixture teardown could lose cleanup; focused RED/GREEN, scoped review and the final disposable aggregate check cover that risk.
