# Student Result Multi-Upload and Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students atomically upload several result files and replace a finalized Laboratory or Physical Examination submission through an isolated edit draft while the prior official version remains intact.

**Architecture:** Extend `student_result_submissions` with explicit edit, supersession, and cleanup provenance; keep one visible active draft and one current finalized version per appointment; and coordinate private storage with database transactions and retryable tombstones. Reuse the existing repository/service/UI boundaries, add expected-submission concurrency tokens to every draft mutation, and project only current official files to students and administrators while exposing superseded history only to administrators.

**Tech Stack:** PostgreSQL migrations and row locks, Next.js 16 App Router route handlers, React 19 and Testing Library, TypeScript, Vitest integration tests, private filesystem result storage, and the in-app Browser.

## Global Constraints

- Execute only in `.worktrees/student-result-multi-upload-editing` on `codex/student-result-multi-upload-editing`; root `main` must remain untouched.
- Follow strict red-green-refactor TDD: add one observable failing test, run it and confirm the expected failure, implement the smallest behavior, rerun green, then refactor.
- Preserve both Laboratory and Physical Examination appointment-completion, ownership, publication, and result-correction behavior.
- Preserve private storage and role boundaries: students may access only their own current `FINALIZED` files; administrators may access current, invalidated, and `SUPERSEDED` history; coordinators and clinic staff may not access result documents.
- Keep exact limits: 10 files per submission, 20 MB per file, 50 MB combined; accepted files remain PDF, JPG/JPEG, and PNG, with server-side signature and integrity verification.
- Treat `discarded_at` as an invisible cleanup tombstone; cancelled, invalidated, and expired edit drafts are never exposed as active drafts and are physically removed only after storage cleanup succeeds.
- Preserve old official files and provenance when an edit is submitted successfully; never expose unfinished edit-draft files as official medical records.
- Standardize lock order for every mutation: appointment scope advisory lock, appointment row, current official submission, active draft, then draft files.
- Require the expected draft `submissionId` on upload, removal, initial finalize, cancel editing, and submit changes; stale tabs return HTTP 409 with error code `RESULT_EDIT_STALE` and never mutate a replacement draft.
- Audit metadata may contain identifiers, counts, byte totals, and result type only; never log filenames, file contents, checksums, or medical details.
- Do not push, create a pull request, merge, or alter unrelated scheduling/authentication/admin behavior during implementation.

---

### Task 1: Schema lifecycle and shared upload rules

**Files:**
- Create: `database/migrations/017_student_result_multi_upload_editing.sql`
- Create: `src/server/db/student-result-multi-upload-editing-migration.integration.test.ts`
- Create: `src/shared/student-result-file-rules.ts`
- Modify: `src/server/files/result-file-validation.ts`
- Modify: `src/server/files/result-file-validation.test.ts`
- Modify: `src/server/db/database.integration.test.ts`

**Interfaces:**
- Consumes: the migration-008 `student_result_submissions` and `student_result_files` schema.
- Produces: nullable `based_on_submission_id`, `superseded_at`, `superseded_by_submission_id`, and `discarded_at`; status `SUPERSEDED`; partial unique index `student_result_submissions_one_draft_idx` filtered by `status = 'DRAFT' AND discarded_at IS NULL`; indexes `student_result_submissions_based_on_idx` and `student_result_submissions_superseded_by_idx`.
- Produces: browser-safe exports `RESULT_FILE_MAX_BYTES`, `RESULT_SUBMISSION_MAX_BYTES`, `RESULT_SUBMISSION_MAX_FILES`, `RESULT_FILE_ACCEPT`, `RESULT_FILE_ALLOWED_EXTENSIONS`, and `isAllowedResultFileName(name: string): boolean` from `src/shared/student-result-file-rules.ts`.

- [ ] **Step 1: Add a failing migration test for the new columns, status constraint, and indexes**

```ts
it("supports one active draft, one finalized version, and multiple superseded versions", async () => {
  // Apply migration 017 in the isolated migration schema, insert one FINALIZED,
  // one non-discarded DRAFT, one discarded DRAFT, and two SUPERSEDED rows.
  // Assert all valid rows coexist and a second active DRAFT is rejected.
});

it("rejects invalid lifecycle metadata and self references", async () => {
  // Assert DRAFT with superseded metadata, SUPERSEDED without finalized_at or
  // superseded_at, SUPERSEDED with invalidation metadata, and self-references fail.
});
```

- [ ] **Step 2: Run the migration tests and confirm RED**

Run: `npm test -- src/server/db/student-result-multi-upload-editing-migration.integration.test.ts src/server/db/database.integration.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because migration 017 and its columns/indexes do not exist.

- [ ] **Step 3: Implement migration 017 with explicit lifecycle checks**

```sql
ALTER TABLE student_result_submissions
  ADD COLUMN based_on_submission_id UUID REFERENCES student_result_submissions(id),
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_by_submission_id UUID REFERENCES student_result_submissions(id),
  ADD COLUMN discarded_at TIMESTAMPTZ;

ALTER TABLE student_result_submissions
  ADD CONSTRAINT student_result_submissions_no_self_reference_check CHECK (
    based_on_submission_id IS DISTINCT FROM id
    AND superseded_by_submission_id IS DISTINCT FROM id
  );
```

Drop and recreate the existing status/lifecycle checks so `DRAFT`, `FINALIZED`, `INVALIDATED`, and `SUPERSEDED` each permit only their approved timestamp/provenance fields. `based_on_submission_id` is allowed only for an active or discarded `DRAFT`; a promoted `FINALIZED` must have it cleared. Recreate the draft index with `discarded_at IS NULL`, retain the one-finalized index, add provenance indexes, and update the administrator-profile index predicate to include `SUPERSEDED` without treating it as current.

- [ ] **Step 4: Add failing shared-rule tests before moving constants**

```ts
expect(isAllowedResultFileName("scan.PDF")).toBe(true);
expect(isAllowedResultFileName("scan.txt")).toBe(false);
expect(validateResultFile(validPdf).byteSize).toBe(validPdf.bytes.length);
```

Run: `npm test -- src/server/files/result-file-validation.test.ts --run`

Expected: FAIL because the browser-safe shared rules module does not exist.

- [ ] **Step 5: Move only portable constants and extension checks to the shared module**

Keep Buffer signature detection and MIME validation in `src/server/files/result-file-validation.ts`; import the size/count/type decisions from `src/shared/student-result-file-rules.ts` so browser and server code cannot drift.

- [ ] **Step 6: Verify Task 1 green and commit**

Run: `npm test -- src/server/db/student-result-multi-upload-editing-migration.integration.test.ts src/server/db/database.integration.test.ts src/server/files/result-file-validation.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS with valid active-draft/finalized coexistence, multiple superseded rows, rejected invalid provenance, and unchanged signature validation.

Commit: `git add database/migrations/017_student_result_multi_upload_editing.sql src/shared/student-result-file-rules.ts src/server/db src/server/files && git commit -m "feat: add result edit submission lifecycle"`

---

### Task 2: Expected-draft mutations and atomic multi-file upload

**Files:**
- Modify: `src/server/repositories/student-result-submissions.repository.ts`
- Modify: `src/server/services/student-result-submissions.service.ts`
- Modify: `src/server/services/student-result-submissions.integration.test.ts`
- Modify: `src/app/api/student/result-submissions/[appointmentId]/files/route.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/files/route.test.ts`
- Modify: `src/app/api/student/result-submissions/[appointmentId]/files/[fileId]/route.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/files/[fileId]/route.test.ts`
- Modify: `src/app/api/student/result-submissions/[appointmentId]/finalize/route.ts`
- Modify: `src/app/api/student/result-submissions/[appointmentId]/finalize/route.test.ts`

**Interfaces:**
- Consumes: Task 1 shared limits and active-draft schema.
- Produces: `addStudentResultFiles(studentNumber, appointmentId, submissionId, uploads, storage)` where `uploads` is a non-empty array of `{ filename; declaredMimeType; bytes }` and the return value is the refreshed student submission view.
- Produces: `removeStudentResultFile(studentNumber, appointmentId, submissionId, fileId, storage)` and `finalizeStudentResultSubmission(studentNumber, appointmentId, submissionId, storage)`.
- Produces: route payloads with `error.code === "RESULT_EDIT_STALE"` and HTTP 409 when `submissionId` is not the current active draft.

- [ ] **Step 1: Add failing service tests for an atomic batch and expected submission identity**

```ts
it("rejects a mixed-invalid batch without file rows or storage residue", async () => {
  const before = await getStudentResultSubmission(studentNumber, appointmentId);
  await expect(addStudentResultFiles(studentNumber, appointmentId, before.id, [pdf(), textFile()], storage))
    .rejects.toMatchObject({ code: "RESULT_FILE_TYPE_UNSUPPORTED" });
  expect(await storage.keys()).toEqual([]);
  expect((await getStudentResultSubmission(studentNumber, appointmentId)).files).toEqual([]);
});

it("does not let a stale tab upload, remove, or finalize a replacement draft", async () => {
  // Retire the old draft, create its replacement, then call each mutation with
  // the old id and assert RESULT_EDIT_STALE plus an unchanged replacement.
});
```

Also add red cases for resulting count >10, resulting bytes >50 MB, a storage failure after at least one successful write, concurrent batches, and cleanup of every generated storage key.

- [ ] **Step 2: Run focused service tests and confirm RED**

Run: `npm test -- src/server/services/student-result-submissions.integration.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because only single-file mutation functions exist and draft mutations do not accept an expected id.

- [ ] **Step 3: Implement repository locks and atomic batch persistence**

Acquire locks in the global order. Lock the exact non-discarded draft by both appointment and `submissionId`; distinguish missing ownership from stale identity. Lock current file rows, validate every buffer before any storage write, compute resulting totals, generate all storage keys, write all objects, insert all rows in one database transaction, and delete every newly written key if validation, storage, insert, or commit fails. Never delete pre-existing draft files during batch rollback.

- [ ] **Step 4: Add failing route contract tests**

```ts
const form = new FormData();
form.set("submissionId", draftId);
form.append("file", firstPdf);
form.append("file", secondPng);
expect(await POST(requestWith(form), context)).toMatchObject({ status: 200 });
```

Assert `form.getAll("file")` is used, zero valid `File` entries returns 400, missing/invalid `submissionId` returns 400, and stale identity returns 409. Assert DELETE-file and finalize JSON bodies require `{ submissionId }`.

Run: `npm test -- src/app/api/student/result-submissions/[appointmentId]/files/route.test.ts src/app/api/student/result-submissions/[appointmentId]/files/[fileId]/route.test.ts src/app/api/student/result-submissions/[appointmentId]/finalize/route.test.ts --run`

Expected: FAIL against the single-file and bodyless existing contracts.

- [ ] **Step 5: Implement multipart and JSON route contracts**

POST files reads `form.get("submissionId")` and all real `File` values from `form.getAll("file")`, converts them to service uploads, and performs one service call. File removal and initial finalize parse JSON `{ submissionId: string }`. Preserve student authentication and ownership error mapping; map stale identity to HTTP 409 without leaking the current draft id.

- [ ] **Step 6: Verify Task 2 green and commit**

Run: `npm test -- src/server/services/student-result-submissions.integration.test.ts src/app/api/student/result-submissions/[appointmentId]/files/route.test.ts src/app/api/student/result-submissions/[appointmentId]/files/[fileId]/route.test.ts src/app/api/student/result-submissions/[appointmentId]/finalize/route.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS for mixed-invalid batches, count/byte limits, storage rollback, competing uploads, ownership, repeated route file entries, and all expected-id mutations.

Commit: `git add src/server/repositories/student-result-submissions.repository.ts src/server/services/student-result-submissions* src/app/api/student/result-submissions && git commit -m "feat: upload result files atomically"`

---

### Task 3: Edit creation, replacement promotion, cancellation, invalidation, and cleanup

**Files:**
- Modify: `src/server/repositories/student-result-submissions.repository.ts`
- Modify: `src/server/services/student-result-submissions.service.ts`
- Modify: `src/server/services/student-result-submissions.integration.test.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/edit/route.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/edit/route.test.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/submit-changes/route.ts`
- Create: `src/app/api/student/result-submissions/[appointmentId]/submit-changes/route.test.ts`
- Modify: `src/server/workers/result-draft-cleanup.worker.ts`
- Modify: `src/server/workers/result-draft-cleanup.worker.test.ts`
- Modify: `src/app/api/admin/student-result-submissions/[submissionId]/invalidate/route.test.ts`

**Interfaces:**
- Consumes: Task 2 expected-id mutation and storage rollback primitives.
- Produces: `beginStudentResultEdit(studentNumber, appointmentId, storage)`, `cancelStudentResultEdit(studentNumber, appointmentId, submissionId, storage)`, and `submitStudentResultChanges(studentNumber, appointmentId, submissionId, storage)`.
- Produces: POST/DELETE `/api/student/result-submissions/[appointmentId]/edit` and POST `/api/student/result-submissions/[appointmentId]/submit-changes`; cancel and submit JSON bodies are `{ submissionId }`.
- Produces: `discarded_at` retirement and retryable cleanup that never changes or deletes the current official submission.

- [ ] **Step 1: Add failing edit-copy and idempotency tests**

```ts
it("copies every verified official file into one idempotent edit draft", async () => {
  const first = await beginStudentResultEdit(studentNumber, appointmentId, storage);
  const repeated = await beginStudentResultEdit(studentNumber, appointmentId, storage);
  expect(repeated.id).toBe(first.id);
  expect(first.basedOnSubmissionId).toBe(official.id);
  expect(first.files.map(file => file.originalFilename)).toEqual(officialNames);
});
```

Add red cases for copy failure after one write, copied-file checksum mismatch, a repeated edit request after official replacement, another student's appointment, and simultaneous edit creation. Assert partial draft rows and copied storage keys do not survive failures.

- [ ] **Step 2: Run edit creation tests and confirm RED**

Run: `npm test -- src/server/services/student-result-submissions.integration.test.ts --run --maxWorkers=1 --no-file-parallelism -t "edit"`

Expected: FAIL because edit-draft creation and provenance do not exist.

- [ ] **Step 3: Implement edit creation under the global lock order**

Lock scope, appointment, current official, existing active draft, and official files. If an active edit draft is based on the same official, return it. Otherwise reject conflicting normal drafts. Read and checksum-verify every official object, write separate draft storage keys, insert copied metadata, and roll back both database rows and all newly written keys on any failure.

- [ ] **Step 4: Add failing cancel, expiration, and invalidation tests**

Assert cancelling only tombstones the edit draft, the official stays `FINALIZED`, copied files are marked for cleanup, successful deletes remove the tombstoned row, failed deletes remain retryable, and repeated stale mutations return `RESULT_EDIT_STALE`. Add worker cases proving a seven-day expired edit is retired without touching official rows/files. Add administrator invalidation cases proving the related edit is retired in the protected workflow, the official becomes `INVALIDATED`, the normal replacement draft is created, and a stale student tab conflicts.

Run: `npm test -- src/server/services/student-result-submissions.integration.test.ts src/server/workers/result-draft-cleanup.worker.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: FAIL until lifecycle retirement is implemented.

- [ ] **Step 5: Implement one retirement path used by cancel, expiration, and invalidation**

Inside the transaction, set `discarded_at`, mark only that draft's files `storage_delete_pending`, and remove it from active queries immediately. After commit, attempt private-object deletion and use existing deletion bookkeeping; keep failures for worker retry. Update invalidation to retire the edit draft while holding official/draft/file locks, then preserve the existing notification and replacement-draft behavior.

- [ ] **Step 6: Add failing submit-changes integrity and concurrency tests**

```ts
it("atomically supersedes the official and promotes the complete edit", async () => {
  const promoted = await submitStudentResultChanges(studentNumber, appointmentId, edit.id, storage);
  expect(promoted.status).toBe("FINALIZED");
  expect(promoted.basedOnSubmissionId).toBeNull();
  expect(await loadStatus(official.id)).toMatchObject({
    status: "SUPERSEDED",
    supersededBySubmissionId: promoted.id,
  });
});
```

Add red cases for zero files, stored object missing, checksum mismatch, stale base official, invalidated official, and two competing promotions where exactly one succeeds and the one-finalized index remains satisfied.

- [ ] **Step 7: Implement atomic promotion and privacy-safe audits**

Revalidate count, total bytes, metadata, signatures, and stored checksums while rows are locked. Update the old official to `SUPERSEDED` before updating the edit draft to `FINALIZED`; set `superseded_at`, link `superseded_by_submission_id`, set new `finalized_at`, and clear `based_on_submission_id`. Emit `STUDENT_RESULT_EDIT_STARTED`, `STUDENT_RESULT_EDIT_CANCELLED`, `STUDENT_RESULT_SUBMISSION_REPLACED`, and `STUDENT_RESULT_EDIT_CANCELLED_BY_INVALIDATION` with identifiers/counts/bytes only.

- [ ] **Step 8: Add route tests and implement endpoint error mapping**

POST edit has no client-supplied base id and returns the idempotent editable view. DELETE edit and POST submit-changes require JSON `{ submissionId }`. Map `RESULT_EDIT_STALE` and competing/invalidation conflicts to 409 with the approved student message.

Run: `npm test -- src/app/api/student/result-submissions/[appointmentId]/edit/route.test.ts src/app/api/student/result-submissions/[appointmentId]/submit-changes/route.test.ts src/app/api/admin/student-result-submissions/[submissionId]/invalidate/route.test.ts --run`

Expected: PASS for auth, body validation, idempotency, ownership, and stale conflicts.

- [ ] **Step 9: Verify Task 3 green and commit**

Run: `npm test -- src/server/services/student-result-submissions.integration.test.ts src/server/workers/result-draft-cleanup.worker.test.ts src/app/api/student/result-submissions/[appointmentId]/edit/route.test.ts src/app/api/student/result-submissions/[appointmentId]/submit-changes/route.test.ts src/app/api/admin/student-result-submissions/[submissionId]/invalidate/route.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS for copy rollback, idempotency, integrity, cancellation, expiration, invalidation, stale tabs, and competing promotions.

Commit: `git add src/server src/app/api/student/result-submissions src/app/api/admin/student-result-submissions && git commit -m "feat: edit finalized result submissions"`

---

### Task 4: Student multi-select and editing interface

**Files:**
- Create: `src/components/student-results/result-selection-validation.ts`
- Create: `src/components/student-results/result-selection-validation.test.ts`
- Modify: `src/components/student-results/ResultDraftManager.tsx`
- Modify: `src/components/student-results/ResultDraftManager.test.tsx`
- Modify: `src/app/students/results/[appointmentId]/page.tsx`
- Modify: `src/app/api/student/result-submissions/[appointmentId]/route.ts`

**Interfaces:**
- Consumes: Task 1 shared limits and Task 2/3 API contracts.
- Produces: `validateResultFileSelection(files, { currentFileCount, currentTotalBytes })` returning rows `{ file, filename, byteSize, valid, error }` and a batch-level `canUpload` decision.
- Consumes an enriched student view with `id`, `status`, `basedOnSubmissionId`, `files`, `fileCount`, `totalBytes`, and nullable administrator replacement reason.

- [ ] **Step 1: Add failing pure browser-validation tests**

Use literal File objects to prove supported extensions, per-file 20 MB failure, resulting 10-file failure, resulting 50 MB failure, mixed-invalid all-or-nothing selection, and valid PDF/JPEG/PNG selection. Name each test for the production branch it catches.

Run: `npm test -- src/components/student-results/result-selection-validation.test.ts --run`

Expected: FAIL because the browser validator does not exist.

- [ ] **Step 2: Implement selection validation from shared rules**

The validator must not read server-only modules or file contents. Every selected row shows its own extension/size error; count and total errors make all upload controls unavailable until selection is replaced or cleared.

- [ ] **Step 3: Add failing component tests for every UI state and request contract**

```tsx
expect(screen.getByLabelText(/choose result files/i)).toHaveAttribute("multiple");
await user.upload(input, [pdfFile, pngFile]);
expect(screen.getByText(pdfFile.name)).toBeVisible();
expect(screen.getByText(pngFile.name)).toBeVisible();
```

Cover draft counts/totals, one multipart request with repeated `file` entries and `submissionId`, selected-row errors, invalid batch blocking, retry-preserved selection, synchronous duplicate upload blocking, `Uploading 3 files...`, submitted state/downloads, `Edit submission`, retained copied files, edit helper copy, remove with expected id, cancel confirmation exact wording, submit-changes confirmation/pending state, empty-edit disabled state, final-submit approved wording, and `RESULT_EDIT_STALE` approved administrator-invalidation message.

Run: `npm test -- src/components/student-results/ResultDraftManager.test.tsx --run`

Expected: FAIL against the single-file permanently-locked component.

- [ ] **Step 4: Implement `ResultDraftManager` as one state machine**

Keep a synchronous in-flight ref in addition to disabled state so repeated clicks in one render tick issue one request. Clear selected files only after a successful upload; preserve them and errors after recoverable failures. Use `ConfirmDialog` for final submit, cancel, and submit changes. Refresh only after a successful mutation. Keep the file input `multiple` and include one `submissionId` plus repeated `file` parts.

- [ ] **Step 5: Enrich the student loader without broadening downloads**

Return the active edit draft when present while retaining enough official provenance for submitted/editing UI. When invalidation has retired an edit, return the normal replacement draft and administrator reason. Keep `/api/student/result-files/[fileId]` restricted to files belonging to the student's current `FINALIZED` submission; copied edit files are manipulated only through owned draft routes.

- [ ] **Step 6: Verify Task 4 green and commit**

Run: `npm test -- src/components/student-results/result-selection-validation.test.ts src/components/student-results/ResultDraftManager.test.tsx src/server/services/student-result-submissions.integration.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS with no React act warnings or console errors.

Commit: `git add src/components/student-results src/app/students/results src/app/api/student/result-submissions src/server && git commit -m "feat: add student result editing interface"`

---

### Task 5: Administrator current-result projection and superseded history

**Files:**
- Modify: `src/server/student-results/admin-student-result-profile.ts`
- Modify: `src/server/student-results/admin-student-result-profile.test.ts`
- Modify: `src/server/repositories/student-result-submissions.repository.ts`
- Modify: `src/server/repositories/student-result-submission-profiles.integration.test.ts`
- Modify: `src/components/admin-results/StudentResultSection.tsx`
- Modify: `src/components/admin-results/SubmissionHistory.tsx`
- Modify: `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx`
- Modify: `src/app/api/admin/student-result-submissions/[submissionId]/files/[fileId]/route.ts`
- Create: `src/app/api/admin/student-result-submissions/[submissionId]/files/[fileId]/route.test.ts`

**Interfaces:**
- Consumes: lifecycle fields from Tasks 1 and 3.
- Produces: administrator history entries with status `FINALIZED | INVALIDATED | SUPERSEDED`, supersession timestamps/links, and `editingInProgress` only on the current finalized section.
- Preserves: administrator-only file access to historical `SUPERSEDED` rows; current student download checks remain separate and unchanged.

- [ ] **Step 1: Add failing profile/repository tests**

Create a current `FINALIZED`, related active edit draft, and older `SUPERSEDED` row. Assert current state is still finalized, current files are official-only, `editingInProgress === true`, replacement/invalidation reason is retained, and history labels the older row `SUPERSEDED` with its provenance. Assert active/discarded edit drafts never appear as medical-document history.

Run: `npm test -- src/server/student-results/admin-student-result-profile.test.ts src/server/repositories/student-result-submission-profiles.integration.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because current profile types and queries do not project edit/supersession fields.

- [ ] **Step 2: Implement current-versus-history query semantics**

Current sections select only the current effective appointment's `FINALIZED` row and its files. A related non-discarded edit draft contributes only the boolean editing indicator. History includes `SUPERSEDED` and `INVALIDATED` official versions in deterministic activity order, never DRAFT rows.

- [ ] **Step 3: Add failing administrator component and download tests**

Assert `Student editing in progress` appears below `Finalized`, draft filenames do not render, `SUPERSEDED` is distinct in history, superseded downloads succeed for ADMIN, and the same access is denied for COORDINATOR, CLINIC_STAFF, and unrelated students.

Run: `npm test -- src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx src/app/api/admin/student-result-submissions/[submissionId]/files/[fileId]/route.test.ts --run`

Expected: FAIL until UI and historical authorization are updated.

- [ ] **Step 4: Implement administrator presentation and explicit access split**

Render the editing indicator without exposing draft files. Label and timestamp superseded history, retain administrator download controls, and keep invalidation actions only on current finalized versions. Use an administrator-specific repository query for finalized/invalidated/superseded file ids; do not relax the student file query.

- [ ] **Step 5: Verify Task 5 green and commit**

Run: `npm test -- src/server/student-results/admin-student-result-profile.test.ts src/server/repositories/student-result-submission-profiles.integration.test.ts src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx src/app/api/admin/student-result-submissions/[submissionId]/files/[fileId]/route.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS for current-only official files, editing indicator, superseded history, replacement reason, and unchanged role boundaries.

Commit: `git add src/server/student-results src/server/repositories src/components/admin-results src/app/\(dashboard\)/settings/student-result-submissions src/app/api/admin/student-result-submissions && git commit -m "feat: show result edit provenance to administrators"`

---

### Task 6: Guarded Browser fixture, end-to-end acceptance, and release verification

**Files:**
- Create: `scripts/browser-student-result-editing-fixture.ts`
- Create: `scripts/browser-student-result-editing-fixture.test.ts`
- Modify: `package.json`
- Modify: `docs/e2e.md`

**Interfaces:**
- Consumes: all production flows from Tasks 1-5.
- Produces: `npm run acceptance:student-result-editing -- prepare|status|cleanup` guarded by `STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1` and loopback-only `DATABASE_URL`.
- Produces: resumable manifest state and status output that counts every fixture student, appointment, result row, file row, notification/outbox/audit row, private storage object, and state file; cleanup success means every count is exactly zero.

- [ ] **Step 1: Add failing fixture safety tests**

Test that missing exclusive flag refuses prepare and cleanup, a non-loopback database refuses mutation, prepare is resumable, status reports partial state without mutation, cleanup can resume after a simulated storage-delete failure, and the final status proves zero residue.

Run: `npm test -- scripts/browser-student-result-editing-fixture.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because the guarded fixture does not exist.

- [ ] **Step 2: Implement the fixture using the appointment-protection safety pattern**

Prepare one synthetic student with completed Laboratory and Physical Examination appointments, an initial Laboratory draft, and a finalized Physical Examination submission. Create small valid PDF/PNG/JPEG chooser files plus an invalid text file outside `public/`. Keep student login facts and admin seed login in the manifest without printing secrets. Make every prepare stage idempotent and every cleanup stage delete only manifest-addressed rows/files before removing the manifest.

- [ ] **Step 3: Add scripts and operating documentation**

```json
"acceptance:student-result-editing": "tsx --env-file=.env.local scripts/browser-student-result-editing-fixture.ts"
```

Document the exclusive flag, `prepare`, `status`, `cleanup`, expected local URL, and the rule to run cleanup before the authoritative suite.

- [ ] **Step 4: Verify fixture tests and commit**

Run: `npm test -- scripts/browser-student-result-editing-fixture.test.ts --run --maxWorkers=1 --no-file-parallelism`

Expected: PASS for guards, resumability, retry cleanup, and zero-residue reporting.

Commit: `git add scripts/browser-student-result-editing-fixture* package.json docs/e2e.md && git commit -m "test: add result editing browser fixture"`

- [ ] **Step 5: Prepare and verify real in-app Browser flows**

Run fixture prepare with `STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1`, start the worktree app, and use only the in-app Browser. Verify Laboratory invalid-selection blocking, chooser `multiple`, valid PDF+PNG atomic upload, final submit, edit/cancel, re-edit, and successful replacement. Verify Physical Examination editing while an administrator tab continues to show only official files plus `Student editing in progress`; invalidate from the administrator UI; then prove the stale student tab receives the approved conflict message. Verify administrator superseded history/download, administrator replacement reason, 390x844 and desktop layouts without horizontal overflow, and zero console warnings/errors.

- [ ] **Step 6: Clean the fixture and prove explicit zero residue**

Run cleanup with the exclusive flag, then status. Do not proceed to the full suite until every fixture database/storage/state count is zero.

- [ ] **Step 7: Run final automated verification independently**

Run, one command at a time:

```powershell
npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run lint
npm run build
git diff --check
git status --short
```

Expected: full serialized suite passes, lint exits 0, production build exits 0, diff check is empty, and only intentional committed feature changes exist.
