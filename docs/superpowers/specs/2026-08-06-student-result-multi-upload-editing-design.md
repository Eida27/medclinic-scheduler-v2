# Editable Student Result Submissions and Multi-File Upload — Design Specification

**Date:** 2026-08-06  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Purpose

Improve `/students/results/[appointmentId]` so students can select and upload multiple result files in one action and can edit a previously finalized result submission without losing the currently official version while changes are still in progress.

The design keeps the existing Laboratory and Physical Examination result workflows, ownership checks, file validation limits, administrator invalidation controls, audit behavior, and private file access. It changes only the student upload and editing lifecycle required for this feature.

## 2. Approved Product Decisions

The approved behavior is:

- Use **reopen then resubmit** rather than making finalized files directly mutable.
- A finalized submission remains official while the student works on an edit draft.
- When editing begins, previously submitted files are retained in the working draft.
- Multi-file selections are validated in the browser before upload.
- If any selected file is invalid, the entire selection is blocked until the student fixes it.
- The server repeats all validation and accepts or rejects the selected upload batch atomically.
- A student may leave an edit unfinished; the prior finalized submission remains official.
- Administrator invalidation wins over an in-progress student edit and makes that edit stale.
- Inactive edit drafts use the existing seven-day draft-expiration policy without affecting the official finalized submission.

## 3. Existing System Context

The current implementation already provides useful foundations:

- `student_result_submissions` currently supports `DRAFT`, `FINALIZED`, and `INVALIDATED` statuses.
- Database partial unique indexes allow one `DRAFT` and one `FINALIZED` submission for the same appointment simultaneously.
- Result files are stored separately in `student_result_files` and belong to one submission.
- Students may currently add and remove files only while a submission is `DRAFT`.
- The current student UI explicitly locks files after finalization.
- The current upload route accepts one `file` entry per request.
- Existing limits are 10 files, 20 MB per file, and 50 MB combined per Laboratory or Physical Examination submission.
- Existing allowed types are PDF, JPG/JPEG, and PNG.
- Administrators can invalidate finalized submissions and reopen the normal replacement-upload flow.

The design extends these foundations rather than replacing them.

## 4. Submission Lifecycle

### 4.1 Initial submission

The existing first-submission lifecycle remains:

```text
Completed appointment
        |
        v
      DRAFT
        |
        | Final submit
        v
    FINALIZED
```

A completed Laboratory appointment unlocks Laboratory uploads. A completed Physical Examination appointment unlocks Physical Examination uploads. Existing appointment ownership and completion checks remain mandatory.

### 4.2 Editing a finalized submission

When a student clicks **Edit submission**:

```text
FINALIZED (official)
        +
EDIT DRAFT (working copy)
```

The original `FINALIZED` submission remains official, downloadable, and administrator-visible throughout editing.

The edit draft is a separate `DRAFT` submission that contains a working copy of the current finalized file set. The student may remove existing copied files, add new files, leave and return later, cancel editing, or submit the new version.

### 4.3 Submitting changes

When the student clicks **Submit changes**:

1. Lock the relevant appointment, official finalized submission, and edit draft.
2. Verify that the edit draft is still based on the current official finalized submission.
3. Verify that the official submission has not been invalidated or otherwise superseded.
4. Revalidate all files in the edit draft, including file count, combined size, MIME/signature, metadata, and stored-file integrity.
5. Require at least one file.
6. In one transaction, change the previous official submission from `FINALIZED` to `SUPERSEDED` and promote the edit draft from `DRAFT` to `FINALIZED`.
7. Preserve the previous official version and its files as historical data; do not delete them during a successful edit submission.
8. Keep the one-finalized-submission partial unique index valid throughout the transaction.
9. Refresh the student and administrator views only after the transaction succeeds.

There must never be a moment where an unfinished student edit becomes the official result.

### 4.4 Cancelling editing

**Cancel editing** opens a confirmation dialog:

> Discard your changes? Your currently submitted result will remain unchanged.

If confirmed:

- Delete or retire only the edit draft.
- Clean up temporary draft file copies using the existing deletion bookkeeping.
- Leave the official finalized submission unchanged.

### 4.5 Abandoned edit drafts

Edit drafts follow the existing seven-day inactivity rule.

When an inactive edit draft expires:

- Delete or expire only the unfinished working copy.
- Clean up its temporary files.
- Keep the official finalized submission unchanged and downloadable.

## 5. Data Model

Add a nullable self-reference to `student_result_submissions`:

```sql
based_on_submission_id UUID NULL
  REFERENCES student_result_submissions(id)
```

Extend the status constraint to include `SUPERSEDED`:

```text
DRAFT
FINALIZED
INVALIDATED
SUPERSEDED
```

Interpretation:

- `DRAFT` with `based_on_submission_id IS NULL`: normal first submission or normal administrator-requested replacement draft.
- `DRAFT` with `based_on_submission_id = <FINALIZED id>`: student edit draft derived from an official finalized submission.
- `FINALIZED`: current official submitted result.
- `SUPERSEDED`: an older, previously finalized version replaced by a later student-submitted edit.
- `INVALIDATED`: administrator-invalidated submission under the existing invalidation workflow.

`SUPERSEDED` is distinct from `INVALIDATED`: a superseded submission was valid when submitted and was later replaced by the student; it was not rejected by an administrator.

For `SUPERSEDED`, retain `finalized_at` and add a nullable `superseded_at TIMESTAMPTZ` plus optional `superseded_by_submission_id UUID REFERENCES student_result_submissions(id)` so history has explicit provenance. `invalidated_at`, `invalidated_by`, and `invalidation_reason` remain null for superseded rows.

The migration should add indexes on `based_on_submission_id` and `superseded_by_submission_id` if useful for the profile/history queries.

The service layer must ensure that `based_on_submission_id` references the current finalized submission for the same appointment and student when an edit draft is created. Do not rely on client input to establish this relationship.

The existing unique index for one `FINALIZED` submission per appointment remains appropriate because `SUPERSEDED` rows no longer match that predicate.

## 6. Edit-Draft Creation

Add a student edit operation, conceptually:

```text
POST /api/student/result-submissions/[appointmentId]/edit
```

The operation must:

1. Require the authenticated student.
2. Lock the owned published appointment.
3. Confirm the appointment still belongs to the student.
4. Locate and lock the current official `FINALIZED` submission.
5. Reject if an edit draft already exists, unless the same valid edit draft can be returned idempotently.
6. Create a `DRAFT` with `based_on_submission_id` pointing to the current finalized submission.
7. Copy each finalized file into edit-draft storage and create corresponding `student_result_files` rows.
8. Preserve original filenames and validated metadata.
9. Ensure copy failures do not leave a partially initialized editable draft.
10. Return the editable draft state.

The recommended implementation is idempotent: if the student repeats **Edit submission** while the same valid edit draft already exists, return the existing edit draft rather than creating an error or duplicate.

## 7. Multi-File Upload

### 7.1 File picker

The student file input becomes a multi-select input:

```html
<input type="file" multiple>
```

Accepted formats remain PDF, JPG/JPEG, and PNG.

### 7.2 Browser pre-validation

Before the request is sent, validate the complete selected set against:

- Supported extension/type.
- Maximum 20 MB per selected file.
- Maximum 10 total files including files already in the current editable draft.
- Maximum 50 MB combined including files already in the current editable draft.

The selected files should appear in a pre-upload list showing filename, size, valid/invalid state, and a specific validation error where applicable.

If any selected file is invalid:

- disable **Upload files**;
- upload none of the selection;
- let the student clear or replace the selection.

Browser validation is for usability only. It never replaces server validation.

### 7.3 Upload request contract

Update the student file upload route so one request can contain multiple `file` form entries, conceptually:

```text
POST /api/student/result-submissions/[appointmentId]/files
Content-Type: multipart/form-data
file=<file 1>
file=<file 2>
...
```

The route should use all `form.getAll("file")` values and reject requests that contain no valid `File` values.

### 7.4 Atomic server behavior

The selected batch is atomic from the student's perspective.

The server must:

1. Authenticate and resolve the owned editable draft.
2. Validate every uploaded file using the existing signature/MIME validator.
3. Calculate the resulting total file count and total bytes before committing any new file row.
4. Reject the whole batch when any file fails validation or the resulting draft exceeds limits.
5. Write all storage objects and database rows as one coordinated operation.
6. On any failure, clean up all storage objects written for that request and leave the draft unchanged.

The existing file limits remain 10 files maximum, 20 MB maximum per file, and 50 MB maximum combined.

### 7.5 Duplicate-submission protection

While an upload request is pending:

- disable upload-related controls;
- show a loading state such as `Uploading 3 files...`;
- prevent repeated submission from the same UI action.

The server must still remain safe under repeated or concurrent requests and must enforce limits transactionally.

## 8. Student UI States

Upgrade `ResultDraftManager` rather than introducing a disconnected editor component unless implementation review shows a clear separation is necessary.

### 8.1 Draft / first submission

Show result type, `fileCount / 10`, combined size `/ 50 MB`, current draft files, remove controls, the multi-file picker, selected-file pre-validation list, **Upload files**, and **Final submit** when at least one file exists.

The final-submit confirmation should no longer claim the files can never be edited again. Recommended wording:

> Submit this result? These files will become your submitted result. You can edit your submission later if corrections are needed.

### 8.2 Finalized

Replace the existing locked-files message with a submitted state:

```text
Submitted
3 files · 12.40 MB

[file] [Download]
[file] [Download]

[Edit submission]
```

Students retain download access to their own official files.

### 8.3 Edit draft

Show:

- **Editing submission** status;
- helper text explaining that the currently submitted result remains official until changes are submitted;
- copied current files with remove controls;
- multi-file picker and pre-upload validation;
- file-count and combined-size totals;
- **Cancel editing**;
- **Submit changes**.

`Submit changes` is unavailable when no files remain.

### 8.4 Error presentation

Use clear student-facing messages for unsupported file type, file exceeds 20 MB, more than 10 total files, combined files exceed 50 MB, upload failure, submission changed while editing, administrator invalidation, and stored-file integrity failure.

For recoverable upload failures, selected files should remain visible where practical so the student can retry without rebuilding the selection.

## 9. Administrator Behavior

The administrator's currently visible result remains the current `FINALIZED` submission.

When an edit draft exists, show a subtle state such as:

```text
Finalized
Student editing in progress
```

The admin must continue downloading the official finalized files, must not see unfinished edit-draft files as finalized medical documents, and retains existing invalidation controls.

Superseded versions may remain in administrator history as historical submissions, clearly labeled `SUPERSEDED`; they must not be mistaken for the current official result.

Do not expand result-document access to coordinators or clinic staff.

## 10. Administrator Invalidation During Student Editing

Administrator invalidation takes precedence over an in-progress student edit.

When invalidating the official finalized submission:

1. Lock the current finalized submission.
2. Detect any edit draft whose `based_on_submission_id` points to it.
3. Delete or expire that edit draft in the same protected workflow.
4. Clean up temporary edit-draft storage safely.
5. Complete the existing invalidation behavior and student notification.
6. Prevent the stale edit draft from later becoming official.

If the student has the page open during this change, a later mutation should return a conflict response. The refreshed UI should show the normal invalidated/replacement flow and the administrator's reason.

Recommended student message:

> Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.

## 11. Concurrency and Transaction Rules

The implementation must fail closed under concurrent edits, submissions, or invalidations.

Use database row locking around the relevant appointment and submission rows when creating an edit draft, adding/removing draft files, cancelling editing, finalizing an initial submission, submitting changes, or invalidating an official submission.

`Submit changes` must verify that `based_on_submission_id` is still the current official finalized submission. If not, return a conflict and do not replace anything.

For successful replacement, the same transaction must:

1. lock the current official and edit draft;
2. change the current official to `SUPERSEDED` with `superseded_at=NOW()`;
3. change the edit draft to `FINALIZED`, set `finalized_at`, and clear edit-only provenance fields that should not remain active;
4. set `superseded_by_submission_id` on the older version to the newly finalized submission id;
5. commit only if the one-finalized constraint is satisfied.

## 12. File Storage Rules

Edit drafts use actual temporary copies of the currently finalized files rather than delta references.

This keeps draft semantics simple, lets existing file rows remain submission-owned, makes count/size validation straightforward, keeps removal behavior consistent, avoids special download paths, and simplifies cleanup/testing.

Temporary storage may briefly duplicate up to the current 50 MB submission limit. This is accepted as the preferable trade-off for implementation simplicity and correctness.

Every copied or newly uploaded file must preserve or recompute the integrity metadata required by the existing validation layer.

After a successful edit submission, files belonging to the `SUPERSEDED` historical version remain preserved unless a future retention policy explicitly changes that behavior.

## 13. API Surface

Recommended student endpoints:

```text
POST   /api/student/result-submissions/[appointmentId]/edit
POST   /api/student/result-submissions/[appointmentId]/files
DELETE /api/student/result-submissions/[appointmentId]/files/[fileId]
DELETE /api/student/result-submissions/[appointmentId]/edit
POST   /api/student/result-submissions/[appointmentId]/finalize
POST   /api/student/result-submissions/[appointmentId]/submit-changes
```

Existing download endpoints remain available for the student's current official files.

The service layer, not the client, determines whether the target is a normal draft, edit draft, or current official submission.

## 14. Audit and Activity

Preserve existing audit and activity patterns.

Add audit events where useful for student edit started, student edit cancelled, edited submission finalized/replaced, and stale edit cancelled because of administrator invalidation.

Do not log file contents or sensitive medical data in audit metadata. Store identifiers, counts, byte totals, appointment id, and relevant submission ids only.

## 15. Testing Requirements

### 15.1 UI tests

Cover at least:

- file input has `multiple`;
- selecting multiple files;
- pre-upload list rendering;
- supported type validation;
- 20 MB per-file validation;
- 10-file resulting-total validation;
- 50 MB resulting-total validation;
- upload button disabled when any selected file is invalid;
- valid selection uploads in one request;
- loading state prevents repeated request submission;
- finalized state shows **Edit submission**;
- edit state retains previous files;
- remove copied file;
- add new files to edit;
- cancel-edit confirmation;
- submit-changes confirmation and pending state;
- empty edit cannot be submitted;
- stale-edit conflict messaging.

### 15.2 API/service tests

Cover at least:

- multi-file route reads all file entries;
- whole batch rejected when one file is invalid;
- whole batch rejected when resulting count exceeds 10;
- whole batch rejected when resulting bytes exceed 50 MB;
- no partial database or storage writes after failed batch;
- edit creation copies all finalized files;
- edit creation is idempotent for the same current finalized version;
- official finalized submission remains accessible while edit draft exists;
- submit changes requires one or more files;
- submit changes validates stored-file integrity;
- submit changes atomically supersedes the old version and finalizes the edited version;
- stale `based_on_submission_id` returns conflict;
- admin invalidation cancels the related edit draft;
- expired edit cleanup leaves official finalized version untouched;
- ownership checks deny another student's appointment/files;
- coordinator and clinic-staff access boundaries are unchanged.

### 15.3 Repository/database tests

Cover:

- migration adds valid self-reference and `SUPERSEDED` status support;
- `SUPERSEDED` requires `finalized_at` and `superseded_at`, while invalidation fields remain null;
- same appointment can still have one `DRAFT` and one `FINALIZED` simultaneously;
- multiple `SUPERSEDED` historical versions can coexist for the same appointment;
- invalid or cross-appointment edit provenance is rejected by service rules;
- row-lock behavior prevents two successful competing promotions;
- one-finalized partial unique constraint remains satisfied.

### 15.4 Regression verification

Run the project's focused tests followed by the broader suite, lint, and production build. Verify both Laboratory and Physical Examination flows manually or through browser acceptance tests.

## 16. Acceptance Criteria

The feature is complete when:

1. Students can select several valid files at once and upload them in one action.
2. Invalid multi-file selections are blocked before upload and clearly explained.
3. The server independently validates and atomically accepts or rejects each selected batch.
4. Finalized submissions expose **Edit submission** rather than permanent lock messaging.
5. Editing keeps all current submitted files by default.
6. The previous finalized submission remains official while edits are unfinished.
7. Students can remove existing copied files, add new files, cancel editing, or submit changes.
8. A successful **Submit changes** atomically marks the previous version `SUPERSEDED` and the edited version `FINALIZED`.
9. Superseded historical files remain preserved and distinguishable from the current official result.
10. Administrator views continue using the current finalized files and indicate editing in progress.
11. Administrator invalidation takes precedence and prevents stale student edits from becoming official.
12. Seven-day cleanup of unfinished edit drafts never deletes or alters the official finalized result.
13. Existing file limits, ownership, authentication, privacy, integrity, audit, and role boundaries remain enforced.

## 17. Non-Goals

This feature does not:

- grant result-document access to coordinators or clinic staff;
- change appointment completion requirements;
- remove administrator invalidation;
- introduce unlimited upload counts or sizes;
- introduce direct in-place mutation of finalized file rows;
- expose unfinished edit-draft files as official medical records;
- redesign unrelated scheduling, authentication, or admin result-profile functionality.
