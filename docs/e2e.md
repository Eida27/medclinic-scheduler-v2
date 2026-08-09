# End-to-end Browser acceptance

## Student result multi-upload and editing

Use this fixture only with a disposable local PostgreSQL database and the local private result-upload root. The fixture rejects every non-loopback `DATABASE_URL`. `prepare` and `cleanup` also refuse to run unless the exact opt-in flag is `1`; `status` is read-only and does not require the flag.

Prerequisites:

- Apply migrations through `018_student_result_storage_cleanup_intents.sql` and seed the standard local reference/admin rows.
- Use the worktree application at `http://localhost:3000`.
- Ensure no other process or test is using the acceptance database while this fixture is prepared.
- Do not copy the local state manifest into logs, issue comments, or commits. It contains the synthetic student login facts and seeded admin login. CLI output intentionally omits those secrets.

From the repository worktree in PowerShell:

```powershell
$env:STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE='1'
npm run acceptance:student-result-editing -- prepare
npm run acceptance:student-result-editing -- status
npm run dev
```

`prepare` is idempotent and resumable. A successful initial status reports one synthetic student, two published completed appointments (Laboratory and Physical Examination), one Laboratory draft, one finalized Physical Examination official submission, two initial result-file rows/private objects, four chooser artifacts, one fixture setup audit, and one state file. The chooser artifacts are under `.data/browser-student-result-editing/chooser-artifacts`, outside `public/`; status prints their absolute paths. The local state manifest at `.data/browser-student-result-editing/state.json` contains every reserved and subsequently discovered owned identifier needed for cleanup and acceptance.

Use only the in-app Browser for acceptance. Verify:

1. Sign in as the synthetic student using the local manifest. For Laboratory, confirm the chooser has `multiple`, the TXT selection is blocked, PDF+PNG upload is atomic, and final submission succeeds.
2. Enter Laboratory edit mode, cancel it, enter edit mode again, replace the official files, and submit the replacement.
3. Open Physical Examination editing in the student tab. In a separate administrator tab, confirm only official files remain visible with `Student editing in progress`, then invalidate the official submission.
4. Return to the stale student tab and confirm the approved conflict message. In the administrator UI, verify superseded history/downloads and the administrator replacement reason.
5. Check desktop and `390x844` layouts for horizontal overflow and check both tabs for zero console warnings or errors.

`status` never repairs or deletes partial state. If preparation is interrupted, inspect status and rerun `prepare`. If cleanup is interrupted—including a private-storage deletion failure—inspect status and rerun `cleanup`; cleanup resumes from the persisted phase. Cleanup deletes only identifiers and exact file paths captured by the fixture manifest and refuses recursive removal when an unowned file appears in its state directory.

Always clean the fixture before the authoritative serialized test suite:

```powershell
$env:STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE='1'
npm run acceptance:student-result-editing -- cleanup
npm run acceptance:student-result-editing -- status
```

Do not start the full suite until status reports `0` for every scoped dimension: students, appointments, submissions, files, legacy exam results, legacy laboratory results, appointment status logs, storage cleanup intents, notifications, outbox rows, audit logs, login attempts, email verifications, private storage objects, chooser artifacts, and state files.
