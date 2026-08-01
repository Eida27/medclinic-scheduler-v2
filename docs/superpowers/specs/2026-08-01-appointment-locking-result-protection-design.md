# Appointment Locking and Result Protection Design

**Date:** 2026-08-01  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Purpose

Add an administrator-facing appointment-lock workflow and make clinic-closure protection rules consistent with the existing result-correction workflow.

The feature must let administrators protect one specific Laboratory or Physical Examination appointment from automatic scheduling changes while still allowing ordinary authorized staff actions. It must also treat active files in unfinished draft result submissions as protected clinical data so clinic-closure automation cannot silently replace an appointment that already has documents attached.

## 2. Approved decisions

The design uses the following decisions:

- Lock one appointment at a time rather than the complete Laboratory–Physical Examination pair.
- A lock blocks automatic scheduling changes only.
- Authorized staff may still update status or manually reschedule a locked appointment.
- Only published `DRAFT` and `PENDING` appointments may be newly locked.
- Only administrators may lock or unlock appointments.
- A manual reschedule transfers the lock to the replacement appointment.
- Any active uploaded file in a draft result submission immediately protects the appointment.
- Draft uploads use the specific manual-resolution reason code `DRAFT_RESULT_FILES_EXIST`.
- Finalized submissions and verified or encoded results continue using `PROTECTED_RESULTS_EXIST`.
- Manual replacement remains unavailable while protected result data is still linked to the affected appointment.

## 3. Goals

The completed feature must:

- Expose visible lock and unlock controls on individual appointment detail pages.
- Show lock state and reason to administrators and clinic staff.
- Prevent automatic clinic-closure and priority-displacement logic from moving a locked appointment.
- Preserve ordinary completion, cancellation, correction, and authorized manual-rescheduling workflows.
- Transfer a lock atomically when a locked appointment is manually rescheduled.
- Use one shared result-protection policy across appointment correction, clinic closures, restoration, and manual resolution.
- Detect active files attached to draft result submissions.
- Route protected closure cases to Manual Resolution with a clear reason.
- Revalidate locks, result protection, blocked dates, capacity, and ordering inside authoritative transactions.
- Preserve audit history without copying medical content or filenames into general audit metadata.

## 4. Non-goals

This design does not:

- Introduce pair-level appointment locking.
- Prevent authorized staff from manually updating a locked appointment.
- Add lock management to bulk appointment tables.
- Automatically copy, move, invalidate, or delete result files.
- Add a new result-review workflow.
- Change the existing Laboratory-before-Physical Examination rule.
- Replace the Manual Resolution queue with a general appointment editor.

## 5. Current implementation gaps

### 5.1 Locking exists in the backend but not the UI

The appointment update service already accepts `lockAction: "LOCK" | "UNLOCK"`, requires an administrator for lock management, stores lock metadata, and writes audit entries. The appointment detail UI does not render lock controls or complete lock metadata.

### 5.2 Result protection is inconsistent

The general result-correction workflow treats these as protected:

- Finalized result submissions
- Active uploaded files
- Verified or encoded results beyond `PENDING_UPLOAD`

The clinic-closure loader currently recognizes finalized submissions and meaningful result statuses, but it does not recognize active files in an unfinished draft submission. This can allow closure automation to replace an appointment while uploaded clinical documents remain linked to the historical appointment.

### 5.3 Manual rescheduling drops lock protection

The current manual-reschedule path creates a new `PENDING` replacement linked through `rescheduled_from`, but it does not copy lock metadata to the replacement.

## 6. Architecture

Use a shared appointment-protection design rather than adding isolated checks to each workflow.

### 6.1 Components

1. `AppointmentProtectionPanel`
   - Displays the current lock state.
   - Lets administrators lock or unlock eligible appointments.
   - Shows read-only protection information to clinic staff.

2. Appointment-lock service logic
   - Validates role, status, current lock state, reason, and stale records.
   - Updates lock metadata and audit records transactionally.

3. Shared result-protection repository
   - Loads raw protection facts for one or many appointments.
   - Supports finalized submissions, active draft files, verified results, and harmless placeholders.

4. Shared result-protection policy
   - Converts raw facts into one normalized protection result.
   - Does not decide the workflow response.

5. Clinic-calendar integration
   - Enriches affected appointments with protection state.
   - Routes unsafe cases to Manual Resolution.

6. Manual-resolution integration
   - Displays the exact protection reason.
   - Disables replacement while protection remains.
   - Revalidates protection at submission time.

7. Restoration integration
   - Rechecks protection on both original and replacement appointments before restoring a schedule.

### 6.2 Suggested files

```text
src/components/appointments/AppointmentProtectionPanel.tsx
src/components/appointments/AppointmentProtectionPanel.test.tsx
src/server/appointments/appointment-result-protection.ts
src/server/repositories/appointment-result-protection.repository.ts
```

Existing files to extend include:

```text
src/components/appointments/AppointmentDetail.tsx
src/components/appointments/AppointmentActions.tsx
src/server/repositories/appointments.repository.ts
src/server/services/appointments.service.ts
src/server/services/clinic-calendar.service.ts
src/server/services/clinic-calendar-planner.ts
src/components/settings/ManualResolutionQueue.tsx
src/types/clinic-calendar.ts
```

## 7. Appointment-lock domain rules

### 7.1 Scope

A lock belongs to one appointment row.

- Locking Laboratory does not automatically lock Physical Examination.
- Locking Physical Examination does not automatically lock Laboratory.
- Clinic-closure classification treats the cycle as unsafe when either appointment in the active pair is locked.

### 7.2 Automation-only protection

A lock prevents automated movement by:

- Clinic-closure rescheduling
- Priority displacement
- Other future automated scheduling workflows that honor `is_manually_locked`

A lock does not disable:

- Marking an appointment completed
- Cancelling an appointment
- Correcting an eligible automatic no-show
- Manually creating a replacement appointment

### 7.3 Eligible statuses

An administrator may newly lock only a published appointment whose status is:

- `DRAFT`
- `PENDING`

The application must reject new locks for:

- `COMPLETED`
- `NO_SHOW`
- `RESCHEDULED`
- `CANCELLED`
- `AWAITING_RESCHEDULE`

An administrator may unlock an appointment that is still marked locked even when its status is no longer `DRAFT` or `PENDING`. This prevents stale lock metadata from becoming impossible to clear.

### 7.4 Lock reason

A lock reason is required and must contain 3–500 trimmed characters.

The reason is visible to administrators and clinic staff but not exposed as medical content. It should describe the scheduling reason, for example:

> Approved OJT schedule coordinated with the clinic administrator.

### 7.5 Lock transfer

When a locked appointment is manually rescheduled:

Original appointment:

```text
status = RESCHEDULED
is_published = false
historical lock metadata remains unchanged
```

Replacement appointment:

```text
status = PENDING
is_published = true
is_manually_locked = true
locked_by = administrator performing the reschedule
locked_at = current timestamp
lock_reason = original lock reason
rescheduled_from = original appointment ID
```

The reschedule and lock transfer must occur in one transaction.

## 8. Appointment-detail UI

### 8.1 Placement

Render an **Appointment protection** card below the appointment summary and above **Update appointment**.

### 8.2 Unlocked eligible appointment

For an administrator, display:

```text
Appointment protection

This appointment is currently available for automatic scheduling changes.

Lock reason
[ Enter why this schedule must be protected... ]

[ Lock appointment ]
```

Behavior:

- Disable submission until the normalized reason is valid.
- Disable the button while submitting.
- Preserve the typed reason after ordinary request failures.
- Show a confirmation dialog before locking.

Confirmation text:

> Lock this appointment? Automated closure rescheduling and priority displacement will not move it. Authorized staff may still update its status or manually reschedule it.

### 8.3 Locked appointment

Display:

```text
Manually locked

This appointment is protected from automatic scheduling changes.

Reason: <lock reason>
Locked by: <administrator name>
Locked on: <Manila timestamp>

[ Unlock appointment ]
```

Unlock confirmation:

> Unlock this appointment? Automatic scheduling processes may move it when required by clinic closures or priority displacement.

### 8.4 Ineligible or historical appointment

Do not show a new-lock action for ineligible statuses.

When historical lock metadata remains, show a read-only state:

```text
Previously locked

This historical appointment was locked before its status changed.
Reason: <lock reason>
```

If the record is still marked locked, an administrator may still see **Unlock appointment**.

### 8.5 Clinic-staff view

Clinic staff can view:

- Lock status
- Lock reason
- Locking administrator
- Lock timestamp

Clinic staff cannot lock or unlock. No lock-management button is rendered.

### 8.6 Interaction with manual rescheduling

When a locked appointment is eligible for manual rescheduling, show this notice above the replacement form:

> This appointment is manually locked. Its protection will transfer to the replacement appointment.

After a successful reschedule, refresh or redirect to the new replacement appointment so the inherited lock is immediately visible.

### 8.7 List indicators

The first implementation may add a small lock icon or **Protected** badge beside the appointment status without adding a new table column. The indicator must include accessible text such as:

```text
aria-label="Appointment manually locked"
```

The full reason and controls remain on the detail page.

## 9. Appointment detail data contract

Extend the published appointment detail response with:

```ts
type AppointmentLockDetail = {
  isManuallyLocked: boolean;
  lockReason: string | null;
  lockedAt: Date | null;
  lockedById: string | null;
  lockedByName: string | null;
  updatedAt: Date;
};
```

The appointment query should join the locking administrator through `appointments.locked_by`.

No new lock columns are required because the database already stores:

- `is_manually_locked`
- `locked_by`
- `locked_at`
- `lock_reason`

## 10. Lock API and service behavior

Continue using:

```text
PATCH /api/appointments/{appointmentId}
```

Lock request:

```json
{
  "lockAction": "LOCK",
  "lockReason": "Approved OJT schedule.",
  "expectedUpdatedAt": "2026-08-01T13:30:00.000Z"
}
```

Unlock request:

```json
{
  "lockAction": "UNLOCK",
  "expectedUpdatedAt": "2026-08-01T13:30:00.000Z"
}
```

### 10.1 Lock transaction

1. Require an administrator.
2. Load the published appointment with `FOR UPDATE`.
3. Compare `expectedUpdatedAt` with the locked row.
4. Require status `DRAFT` or `PENDING`.
5. Require the appointment to be currently unlocked.
6. Normalize and validate the reason.
7. Set lock metadata.
8. Write `APPOINTMENT_LOCKED` audit data.
9. Commit.

### 10.2 Unlock transaction

1. Require an administrator.
2. Load the published appointment with `FOR UPDATE`.
3. Compare `expectedUpdatedAt` with the locked row.
4. Require the appointment to be currently locked.
5. Clear lock metadata.
6. Write `APPOINTMENT_UNLOCKED` audit data.
7. Commit.

### 10.3 Errors

| Code | Message |
|---|---|
| `APPOINTMENT_STALE` | The appointment changed. Reload before updating its protection. |
| `APPOINTMENT_ALREADY_LOCKED` | This appointment is already locked. Refresh the page. |
| `APPOINTMENT_ALREADY_UNLOCKED` | This appointment is already unlocked. Refresh the page. |
| `APPOINTMENT_LOCK_STATUS_INVALID` | Only draft or pending appointments can be locked. |
| `LOCK_REASON_REQUIRED` | Enter a reason for locking this appointment. |
| `FORBIDDEN` | Only administrators can manage appointment locks. |

## 11. Shared result-protection model

### 11.1 Raw facts

```ts
type AppointmentResultProtectionFacts = {
  hasFinalizedSubmission: boolean;
  hasActiveDraftFiles: boolean;
  hasVerifiedResult: boolean;
  hasPendingPlaceholder: boolean;
};
```

### 11.2 Normalized state

```ts
type AppointmentResultProtectionState =
  | { type: "CLEAR" }
  | {
      type: "PENDING_PLACEHOLDER";
      resultId?: string;
      resultTable?: "laboratory_results" | "exam_results";
    }
  | {
      type: "PROTECTED";
      reason:
        | "FINALIZED_RESULT_SUBMISSION"
        | "DRAFT_RESULT_FILES_EXIST"
        | "VERIFIED_RESULT";
      message: string;
      submissionId?: string;
      activeFileCount?: number;
    };
```

### 11.3 Protection priority

When multiple conditions exist, report them in this order:

1. `FINALIZED_RESULT_SUBMISSION`
2. `VERIFIED_RESULT`
3. `DRAFT_RESULT_FILES_EXIST`
4. `PENDING_PLACEHOLDER`
5. `CLEAR`

A finalized submission that also contains files is reported as finalized, not as a draft-file case.

### 11.4 Active draft file definition

A file protects the appointment when:

```text
student_result_submissions.status = DRAFT
student_result_files.deleted_at IS NULL
student_result_files.storage_delete_pending = FALSE
```

Deleted files and files already marked for storage deletion do not count as active protection.

### 11.5 Verified result definition

A Laboratory or Physical Examination result is protected when its status is not `PENDING_UPLOAD`, including:

- `COMPLETED`
- `REQUIRES_FOLLOW_UP`
- `NOT_APPLICABLE`

A plain `PENDING_UPLOAD` record with no protected submission data remains a harmless placeholder.

## 12. Shared protection repository

Provide a bulk function:

```ts
loadAppointmentResultProtectionStates(
  client: PoolClient,
  appointmentIds: string[],
): Promise<Map<string, AppointmentResultProtectionState>>
```

The query should load protection facts for all affected appointments in one operation rather than issuing one query per appointment or student.

The existing single-appointment result-correction function may remain as a wrapper around the shared repository and policy so current callers do not need an immediate broad refactor.

## 13. Clinic-closure integration

### 13.1 Affected-cycle loading

The closure workflow should:

1. Load affected appointment cycles.
2. Collect all appointment IDs.
3. Bulk-load result-protection states.
4. Enrich every `ClinicCycleAppointment` with a normalized protection state.
5. Classify each cycle.

Suggested appointment shape:

```ts
type ClinicCycleAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  isManuallyLocked: boolean;
  protectionState: AppointmentResultProtectionState;
  schedulePairId: string | null;
  scheduleCycleStart: number;
};
```

### 13.2 Classification order

Use this order:

1. Pair missing or inconsistent
2. Appointment manually locked
3. Draft result files exist
4. Finalized submission or verified result exists
5. Completion-aware status classification
6. Automatic move or manual fallback

### 13.3 Reason mapping

| Condition | Manual-case reason code |
|---|---|
| Appointment manually locked | `APPOINTMENT_MANUALLY_LOCKED` |
| Active files in a draft submission | `DRAFT_RESULT_FILES_EXIST` |
| Finalized submission | `PROTECTED_RESULTS_EXIST` |
| Verified or encoded result | `PROTECTED_RESULTS_EXIST` |

Draft-file message:

> An unfinished result submission contains uploaded files linked to this appointment. Review the submission before changing the schedule.

### 13.4 Manual-fallback state

For an unfinished protected appointment:

```text
status = AWAITING_RESCHEDULE
is_published = true
```

The appointment:

- Is excluded from ordinary clinic operational lists.
- Appears in the administrator Manual Resolution queue.
- Retains its original date and file relationships.
- Cannot be completed until resolved.
- Appears to the student as **Awaiting manual reschedule**.

The clinic closure remains active, and safe students continue processing through the existing per-student savepoint model.

## 14. Manual Resolution behavior

### 14.1 New reason code

Add:

```text
DRAFT_RESULT_FILES_EXIST
```

Update:

- `ClinicManualCaseReason`
- Database reason-code constraint
- Manual-resolution filters
- Human-readable labels
- Fixtures and tests

### 14.2 Protected-case display

For `DRAFT_RESULT_FILES_EXIST`, show:

```text
Draft result files exist

Draft result files must be reviewed before this appointment can be replaced.

[ Review result submission ]
```

While protection remains:

- Replacement date controls may remain visible but disabled.
- **Assign replacement** is disabled.
- The case explains why assignment is unavailable.
- The server independently rechecks protection.

### 14.3 Review outcomes

#### Files were uploaded by mistake

Remove them through the existing result-submission workflow. Once no active files remain, the case becomes eligible for manual replacement after reload.

#### Files represent completed clinic work

Review attendance and result state. Complete or correct the appointment through the proper result workflow rather than rescheduling it.

#### Submission is finalized

The case remains protected and is reported as `PROTECTED_RESULTS_EXIST` during revalidation.

### 14.4 Authoritative resolution checks

Before assigning replacement dates, recheck:

- Current appointment status
- Manual-lock state
- Finalized submission state
- Active draft files
- Verified result state
- Blocked dates
- Daily capacity
- Laboratory-before-Physical ordering
- Manual-case optimistic token

Suggested errors:

| Code | Message |
|---|---|
| `DRAFT_RESULT_FILES_EXIST` | Remove or resolve the active draft result files before assigning a replacement. |
| `PROTECTED_RESULTS_EXIST` | Protected result data is linked to this appointment and cannot be moved. |
| `APPOINTMENT_MANUALLY_LOCKED` | This appointment is manually locked. Review or unlock it before assigning a replacement. |
| `MANUAL_CASE_STALE` | The manual case changed. Reload and try again. |
| `CLINIC_CAPACITY_CONFLICT` | The selected date has no remaining capacity. |
| `RESULT_PROTECTION_CONFLICT` | This appointment now contains protected result data. Review the result submission and reload the case. |

## 15. Restoration after reopening

Before restoring an original schedule, evaluate result protection for:

- Original appointments
- Current replacement appointments

Reason mapping:

| Unsafe condition | Manual-case reason |
|---|---|
| Active draft files on original or replacement | `DRAFT_RESULT_FILES_EXIST` |
| Finalized or verified data | `PROTECTED_RESULTS_EXIST` |
| Manual lock, changed state, partial reopening, or other unsafe state | `UNSAFE_RESTORATION` |

When restoration is unsafe:

- Keep the current replacement active.
- Create or retain a manual-review case.
- Do not transfer, copy, invalidate, or delete result files.

Full-pair restoration remains all-or-nothing.

## 16. Manual rescheduling and lock inheritance

The current manual-reschedule transaction should be extended as follows:

1. Lock the source appointment row.
2. Validate the requested replacement date.
3. Change the source to `RESCHEDULED`.
4. Preserve its historical lock metadata.
5. Create the replacement appointment.
6. When the source was locked, set lock metadata on the replacement.
7. Write the ordinary reschedule audit record.
8. Write `APPOINTMENT_LOCK_INHERITED` audit data.
9. Commit.

If any step fails, the original remains active and no replacement, inherited lock, or related audit entry is saved.

## 17. Audit requirements

Use these actions:

```text
APPOINTMENT_LOCKED
APPOINTMENT_UNLOCKED
APPOINTMENT_LOCK_INHERITED
CLINIC_CLOSURE_MANUAL_CASE_CREATED
CLINIC_CLOSURE_MANUAL_CASE_RESOLVED
```

Lock audit metadata may contain:

```json
{
  "appointmentId": "...",
  "studentNumber": "...",
  "scheduleType": "LABORATORY",
  "reason": "Approved OJT schedule.",
  "previousAppointmentId": null
}
```

Inherited-lock metadata may contain:

```json
{
  "appointmentId": "replacement-id",
  "previousAppointmentId": "original-id",
  "reason": "Approved OJT schedule."
}
```

Result-protection audit metadata may contain:

```json
{
  "appointmentId": "...",
  "protectionReason": "DRAFT_RESULT_FILES_EXIST",
  "resultSubmissionId": "...",
  "activeFileCount": 2,
  "detectedDuring": "CLINIC_CLOSURE",
  "closureGroupId": "..."
}
```

Do not place filenames, uploaded documents, medical findings, result values, or file contents into general audit metadata.

## 18. Database migration

Add a migration that extends the allowed manual-case reason codes with:

```text
DRAFT_RESULT_FILES_EXIST
```

The migration must:

- Preserve existing manual cases.
- Preserve existing reason codes.
- Reject unknown reason codes.
- Leave all appointment-lock columns and existing lock data unchanged.
- Work against both a clean database and a database containing existing manual cases.

No new appointment-lock columns are required.

## 19. Error and transaction boundaries

### 19.1 Lock or unlock failure

Roll back only the lock transaction. The appointment remains unchanged.

### 19.2 Manual-reschedule failure

The original appointment remains active. No replacement or transferred lock is created.

### 19.3 Known student-level closure safety issue

Save the clinic closure, route that student to Manual Resolution, and continue processing other safe students.

### 19.4 Unexpected database or programming error

Roll back the complete clinic-calendar operation according to the existing transaction design.

## 20. Testing

### 20.1 Unit tests: protection policy

Cover:

- No submission, files, or meaningful result → `CLEAR`
- Only `PENDING_UPLOAD` placeholder → `PENDING_PLACEHOLDER`
- Draft submission without active files → not protected
- Draft submission with one active file → `DRAFT_RESULT_FILES_EXIST`
- Draft submission with only deleted files → not protected
- Draft submission with only storage-delete-pending files → not protected
- Finalized submission → `FINALIZED_RESULT_SUBMISSION`
- Result `COMPLETED` → `VERIFIED_RESULT`
- Result `REQUIRES_FOLLOW_UP` → `VERIFIED_RESULT`
- Result `NOT_APPLICABLE` → `VERIFIED_RESULT`
- Finalized submission plus files → finalized reason wins

### 20.2 Unit tests: cycle classification

Cover:

- Laboratory manually locked
- Physical Examination manually locked
- Laboratory with draft files
- Physical Examination with draft files
- Finalized submission
- Verified result
- Both appointments unfinished and safe
- Laboratory completed and Physical Examination pending
- Both appointments completed

Draft-file cases must produce:

```text
strategy = MANUAL_RESOLUTION_REQUIRED
reasonCode = DRAFT_RESULT_FILES_EXIST
```

### 20.3 Component tests

`AppointmentProtectionPanel` must verify:

- Unlocked `DRAFT` and `PENDING` appointments show the lock form to administrators.
- Invalid reasons disable submission.
- Valid reasons enable submission.
- Locked state shows reason, administrator, timestamp, and unlock action.
- Ineligible statuses do not show a new-lock action.
- Clinic staff see read-only protection information.
- Failed requests preserve entered text.
- Locked appointments show the inheritance notice in the reschedule area.

### 20.4 API and service tests

Locking:

- Administrator can lock `DRAFT` and `PENDING`.
- Clinic staff receive `403`.
- Invalid statuses are rejected.
- Missing or short reasons are rejected.
- Already-locked requests conflict.
- Stale `expectedUpdatedAt` conflicts.
- Audit data is written.

Unlocking:

- Administrator can unlock a locked appointment.
- Unlock is allowed even after a status change.
- Already-unlocked requests conflict.
- Stale requests conflict.
- Audit data is written.

### 20.5 Lock-transfer integration tests

Verify:

1. A locked pending appointment is manually rescheduled.
2. The original becomes `RESCHEDULED`.
3. The replacement becomes published and `PENDING`.
4. The replacement inherits the lock reason.
5. `locked_by` is the rescheduling administrator.
6. `locked_at` is newly recorded.
7. Reschedule and inherited-lock audit records exist.
8. The replacement links through `rescheduled_from`.
9. A forced insertion failure leaves the original unchanged.

### 20.6 Clinic-calendar integration tests

Draft-file closure case:

1. Create a pending Laboratory–Physical Examination pair.
2. Create a draft result submission.
3. Attach an active file.
4. Block the affected appointment date.
5. Verify the closure is saved.
6. Verify the student is not automatically moved.
7. Verify unfinished appointments become `AWAITING_RESCHEDULE`.
8. Verify a manual case uses `DRAFT_RESULT_FILES_EXIST`.
9. Verify the student receives the awaiting-reschedule notification.

Additional cases:

- Draft submission without files can still be moved automatically.
- Deleted files do not block automation.
- Finalized and verified data continue using `PROTECTED_RESULTS_EXIST`.
- Either locked service routes the pair to Manual Resolution.
- A mixed closure batch moves safe students and creates manual cases for protected students in the same committed operation.

### 20.7 Manual-resolution tests

Verify:

- The case card shows the specific draft-file reason.
- **Assign replacement** is disabled while files remain.
- Removing active files and reloading enables assignment.
- Uploading a file after the page opens causes server-side rejection.
- Finalizing a submission after case creation causes protected-result rejection.
- No replacement is created when revalidation fails.

### 20.8 Restoration tests

Verify:

- Safe replacement restores normally.
- Draft files on original or replacement block automatic restoration.
- Finalized or verified data block restoration.
- A manually locked replacement remains active and enters review.
- Partial reopening does not restore a complete pair.
- Completed replacement work is preserved.
- Result files are never automatically moved or deleted.

### 20.9 Migration tests

Verify:

- Existing manual cases remain valid.
- `DRAFT_RESULT_FILES_EXIST` can be inserted.
- Unknown reason codes remain rejected.
- Existing lock data is unchanged.
- Migration succeeds on clean and populated databases.

### 20.10 Browser acceptance tests

Administrator lock flow:

1. Sign in as administrator.
2. Open a pending appointment.
3. Lock it with a reason.
4. Confirm the locked state appears.
5. Manually reschedule it.
6. Confirm the replacement shows the inherited lock.
7. Block the replacement date in Clinic calendar.
8. Confirm the student enters Manual Resolution instead of being moved automatically.

Draft-file flow:

1. Attach a file to a draft result submission.
2. Block the appointment date.
3. Open Manual Resolution.
4. Confirm assignment is disabled.
5. Remove the draft file.
6. Reload the case.
7. Assign a safe replacement.
8. Confirm the student receives the new schedule.

## 21. Rollout order

### Phase 1: Shared protection foundation

- Add shared protection types and policy.
- Add bulk protection-state loading.
- Refactor general result correction to use the shared policy.
- Confirm existing result behavior remains unchanged.

### Phase 2: Closure consistency

- Add `DRAFT_RESULT_FILES_EXIST` to types and database constraints.
- Enrich closure-cycle loading with shared protection states.
- Update closure classification, manual resolution, and restoration.

### Phase 3: Appointment-lock UI

- Extend appointment-detail data.
- Add `AppointmentProtectionPanel`.
- Add status restrictions and stale-update validation.
- Add lock indicators.

### Phase 4: Lock inheritance

- Transfer lock metadata during manual rescheduling.
- Add inherited-lock auditing.
- Add transaction and integration tests.

### Phase 5: End-to-end verification

- Run unit, component, API, database, integration, and browser tests.
- Run lint and type checking.
- Verify migrations from clean and populated databases.
- Verify mixed closure processing with safe and protected students.

## 22. Acceptance criteria

The feature is complete when:

- Administrators can visibly lock and unlock individual `DRAFT` or `PENDING` appointments.
- Clinic staff can see protection details but cannot manage locks.
- Locks block automatic scheduling changes only.
- Manual status updates and manual rescheduling remain available.
- A manually created replacement inherits the source appointment's lock.
- Draft result submissions with active files are protected immediately.
- Draft files produce `DRAFT_RESULT_FILES_EXIST`.
- Finalized and verified results continue producing `PROTECTED_RESULTS_EXIST`.
- Manual replacement is blocked while protected result data remains.
- Closure, resolution, and restoration services recheck protection inside their transactions.
- Mixed closure batches continue processing safe students while routing unsafe students to Manual Resolution.
- Result files are never automatically transferred, invalidated, or deleted.
- Audit records contain operational identifiers and counts but no medical content or filenames.
- Existing appointment, clinic-calendar, result, and student-portal behavior remains passing.
