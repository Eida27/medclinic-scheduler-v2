# Appointment Quick Status and Full Middle Name Design

**Date:** 2026-07-29  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved for implementation

## 1. Purpose

Revise the Laboratory, Physical Exam, and Appointments interfaces so student names display their complete middle names and clinic personnel can update appointment attendance directly from the Laboratory and Physical Exam tables with minimal friction.

The revision preserves the existing appointment-detail pages for rescheduling and replacement-date management, keeps the automatic no-show workflow authoritative, protects finalized result data, and records every status change in the existing appointment status history and audit trail.

## 2. Goals

The completed feature must:

- Display full middle names consistently anywhere the shared student-name formatter is used.
- Replace the Laboratory and Physical Exam table `Open` action with a clickable status button in the existing Status column.
- Keep the student name and student number as links to the existing appointment-detail page.
- Allow administrators and clinic staff assigned to the appointment's clinic to mark Pending appointments Completed with one click.
- Allow future appointments to be marked Completed without changing the scheduled appointment date.
- Require confirmation, but no typed reason, when correcting an automatic No-show to Completed.
- Restore a Completed appointment to the exact status that immediately preceded completion: Pending or No-show.
- Require confirmation for every transition that results in No-show.
- Prevent reversal when protected or finalized result data exists.
- Keep the Appointments tab's Laboratory and Physical Exam status badges read-only.
- Preserve filtering, sorting, pagination, appointment details, rescheduling, automatic no-show behavior, notifications, status history, and auditability.

## 3. Non-goals

This design does not:

- Add a database column for previous appointment status.
- Add a separate quick-status history table.
- Change appointment dates when appointments are completed early.
- Permit manually assigning No-show to a Pending appointment.
- Delete or invalidate finalized medical result data automatically.
- Add quick attendance controls to the Appointments summary page.
- Replace the existing appointment-detail workflow for rescheduling, manual locks, or detailed corrections.

## 4. Approved interaction model

### 4.1 Laboratory and Physical Exam tables

Both pages continue using the shared published-schedule table component.

The table changes are:

- Remove the separate action column containing `Open`.
- Convert the existing Status badge into a status button.
- Make both the displayed student name and student number link to the existing appointment-detail route.
- Keep Service, Date, filtering, sorting, and pagination unchanged.

The student links open:

- `/laboratory/{appointmentId}` for Laboratory appointments.
- `/physical-exam/{appointmentId}` for Physical Exam appointments.

Those detail pages retain the existing replacement-date and rescheduling controls.

### 4.2 Button states and transitions

| Current effective state | Visual state | Accessible action | Result of activation |
|---|---|---|---|
| `PENDING` | Gray | Pending — click to mark completed | Immediately requests `PENDING -> COMPLETED` |
| `NO_SHOW`, automatically assigned | Red | No-show — click to correct as completed | Opens confirmation, then requests `NO_SHOW -> COMPLETED` |
| `COMPLETED`, completed from Pending | Green | Completed — click to restore pending | Immediately requests `COMPLETED -> PENDING` |
| `COMPLETED`, completed from No-show | Green | Completed — click to restore no-show | Opens confirmation, then requests `COMPLETED -> NO_SHOW` |

Statuses outside this table do not receive the normal quick-toggle behavior:

- `RESCHEDULED`
- `CANCELLED`
- `AWAITING_RESCHEDULE`
- `DRAFT`

Operational published lists already exclude the statuses that should not be actionable there.

### 4.3 Confirmation behavior

Confirmation appears only for transitions involving No-show.

#### Automatic No-show to Completed

The dialog contains only:

- `Cancel`
- `Mark as completed`

No reason field is displayed. The server writes a standard note:

> Automatic no-show corrected to completed through the clinic schedule.

#### Completed back to No-show

The dialog clearly states that the appointment will return to No-show and contains only:

- `Cancel`
- `Restore no-show`

The server records a standard reversal note that identifies the quick-status workflow.

### 4.4 Pending transitions

These transitions do not require confirmation:

- `PENDING -> COMPLETED`
- `COMPLETED -> PENDING`, when Pending was the status immediately before completion

This is intentional to reduce workload friction.

### 4.5 Future appointments

A Pending appointment may be marked Completed before its scheduled date because students may finish an accepted laboratory service outside the school or earlier than planned.

The system must:

- Keep the original `appointment_date` unchanged.
- Record the actual change time in `appointment_status_logs.created_at` and audit history.
- Exclude the appointment from later automatic no-show processing because its status is no longer Pending.

## 5. Full student-name formatting

### 5.1 Global shared format

Update the shared `studentDisplayNameSql()` formatter globally.

Current format:

```text
Last Name, First Name M. (Suffix)
```

New format:

```text
Last Name, First Name Full Middle Name (Suffix)
```

Examples:

```text
Santos, Ana Maria Reyes
Santos, Ana Maria Reyes (Jr.)
Santos, Ana Maria
```

### 5.2 Formatting rules

- Preserve last-name-first ordering.
- Display the complete trimmed `middle_name` value when present.
- Omit the middle-name segment when null or blank.
- Preserve the existing suffix formatting in parentheses.
- Do not introduce duplicate spaces.
- Do not require a database migration.

Because Laboratory, Physical Exam, Appointments, appointment detail, and search queries use the shared formatter, they will display names consistently after this change.

### 5.3 Search compatibility

Search must continue matching:

- Student number.
- The new formatted name.
- First name and last name.
- Full first, middle, last, and suffix combinations already supported by the repository queries.

## 6. Frontend architecture

### 6.1 Shared quick-status component

Create one reusable client component for the Laboratory and Physical Exam tables, conceptually:

```tsx
<AppointmentQuickStatusButton
  appointmentId={appointment.id}
  status={appointment.status}
  completedFromStatus={appointment.completedFromStatus}
/>
```

The component is responsible for:

- Rendering the gray, green, or red state.
- Exposing visible and accessible action text.
- Opening the appropriate confirmation dialog.
- Sending the semantic request.
- Preventing duplicate clicks while saving.
- Displaying an inline accessible error.
- Refreshing the route after success.

The component must not decide whether a transition is legally valid. The server remains authoritative.

### 6.2 Published schedule row

The shared schedule table will render:

- Student name link.
- Student number link.
- Service.
- Date.
- Quick-status button.

There is no separate Actions column.

Clicking the quick-status button must never trigger navigation to the appointment detail page.

### 6.3 Appointments tab

The Appointments page keeps its Laboratory and Physical Exam statuses as non-interactive badges. It receives the full-middle-name display automatically through the shared formatter.

## 7. API contract

Reuse the existing appointment PATCH endpoint with a semantic quick-status request.

Conceptual payload:

```ts
type AppointmentQuickStatusRequest = {
  quickStatusAction: "MARK_COMPLETED" | "REVERT_COMPLETION";
  expectedStatus: "PENDING" | "NO_SHOW" | "COMPLETED";
};
```

### 7.1 `MARK_COMPLETED`

The server accepts only:

- `PENDING -> COMPLETED`
- An eligible automatic `NO_SHOW -> COMPLETED`

### 7.2 `REVERT_COMPLETION`

The current status must be `COMPLETED`.

The server finds the latest status-history entry whose `new_status` is `COMPLETED` and uses its `old_status` as the restoration target.

Only these restoration targets are valid:

- `PENDING`
- `NO_SHOW`

Any missing, ambiguous, unsupported, or stale history produces a controlled error and no mutation.

### 7.3 Expected-status concurrency check

The request includes the status displayed by the browser.

After locking and reloading the appointment, the server compares the authoritative status with `expectedStatus`. A mismatch returns `409 APPOINTMENT_STATUS_CONFLICT` and does not overwrite the newer change.

## 8. Deriving the previous status

No new database column or table is required.

For a Completed appointment, the list query exposes:

```ts
completedFromStatus: "PENDING" | "NO_SHOW" | null
```

This value is derived from the latest appointment status log that transitioned into `COMPLETED`.

The client uses it only to render the correct label and determine whether confirmation is needed. The server independently reads the locked history again before applying any reversal.

If the history cannot establish a valid prior status, the green button must be disabled or the request must be rejected with an explanatory message. The browser-provided value is never treated as authoritative.

## 9. Server-side status logic

### 9.1 Authorization

Quick status changes are allowed for:

- `ADMIN`
- `CLINIC_STAFF` assigned to the appointment's clinic

Clinic staff assigned to another clinic receive `403 CLINIC_ACCESS_DENIED`.

### 9.2 Completing Pending

For `PENDING -> COMPLETED`:

1. Lock and reload the published appointment.
2. Verify expected status and clinic authorization.
3. Change status to Completed.
4. Preserve the scheduled date.
5. Add one status-history record.
6. Ensure the existing pending-upload result placeholder is present.
7. Write one audit record.

No confirmation or typed reason is required.

### 9.3 Correcting automatic No-show

For `NO_SHOW -> COMPLETED`:

1. Verify the latest No-show log was created by the automatic no-show process.
2. Reject manually created, legacy-inconsistent, or otherwise unsupported No-show records.
3. Use the fixed correction note:

```text
Automatic no-show corrected to completed through the clinic schedule.
```

4. Change status to Completed.
5. Ensure the existing pending-upload result placeholder is present.
6. Add one status log and one audit record.

### 9.4 Reverting Completed to Pending

For a latest completion transition of `PENDING -> COMPLETED`:

1. Validate result-correction state.
2. Reject protected or finalized results.
3. Remove only a safe pending-upload placeholder when the existing correction workflow requires it.
4. Change `COMPLETED -> PENDING`.
5. Add a standard status-history note and audit record.

This transition is immediate from the table and does not require confirmation.

### 9.5 Reverting Completed to No-show

For a latest completion transition of `NO_SHOW -> COMPLETED`:

1. Require the frontend confirmation.
2. Validate result-correction state.
3. Reject protected or finalized results.
4. Remove only a safe pending-upload placeholder when applicable.
5. Change `COMPLETED -> NO_SHOW`.
6. Add a standard status-history note and audit record.

The system restores the prior No-show status even when the appointment date is not re-evaluated, because it is reversing an explicitly recorded correction rather than manually creating a new No-show.

### 9.6 Manual No-show prohibition remains

The quick-status feature does not permit `PENDING -> NO_SHOW`.

Pending appointments continue to become No-show only through the automatic no-show worker after their scheduled day has ended.

## 10. Result protection

Before any `COMPLETED -> PENDING` or `COMPLETED -> NO_SHOW` reversal, reuse the existing appointment result-correction check.

Possible states:

- Safe pending-upload placeholder: may be removed as part of the status reversal.
- No protected result: reversal may continue.
- Finalized submission or protected laboratory/examination result: reject the reversal.

Protected-result failure message:

> This appointment can no longer be reverted because protected result data is linked to it.

The appointment remains Completed. No uploaded file, laboratory result, examination result, or finalized submission is deleted or invalidated automatically.

## 11. Transaction flow

Every quick-status update runs in one database transaction:

1. Lock and reload the published appointment.
2. Verify authorization and expected current status.
3. Load the latest relevant status log.
4. Resolve and validate the requested transition.
5. Check automatic no-show eligibility when applicable.
6. Check linked result protection when reverting completion.
7. Update the appointment status.
8. Add exactly one appointment status log.
9. Create or remove only the safe pending-upload placeholder required by existing result logic.
10. Write exactly one audit record for the quick transition.
11. Commit.

Any error rolls back the appointment, result-placeholder, history, and audit changes together.

## 12. Error handling

### 12.1 Supported controlled errors

The server should return clear errors for:

- Appointment not found.
- Clinic access denied.
- Stale expected status.
- Unsupported source status.
- No-show was not automatically assigned.
- Missing or unsupported completion history.
- Protected result data.
- Concurrent appointment modification.
- Database integrity failure.

### 12.2 Frontend behavior

The button must not optimistically change color or status.

While saving:

- Disable the button.
- Show `Updating...` or an equivalent loading label.
- Prevent repeated submissions.

On success:

- Refresh the route.
- Render the server-authoritative status.

On failure:

- Keep the original visible status.
- Display an accessible inline error near the button or table.
- Allow retry after the request finishes.

## 13. Accessibility

The feature must not rely on color alone.

Visible and accessible labels include both state and action:

```text
Pending — click to mark completed
Completed — click to restore pending
No-show — click to correct as completed
Completed — click to restore no-show
```

The status control must:

- Use a real button element.
- Expose keyboard activation through Enter and Space.
- Have a visible focus indicator.
- Expose disabled and busy states accessibly.

Confirmation dialogs must:

- Move focus into the dialog when opened.
- Trap focus while open.
- Support Escape to cancel.
- Restore focus to the originating status button.
- Disable confirmation while saving.

Student name and number remain independent links for keyboard and pointer navigation.

## 14. Data and migration impact

No database migration is required.

The feature reuses:

- `students.middle_name`
- `appointments.status`
- `appointment_status_logs.old_status`
- `appointment_status_logs.new_status`
- Existing result-placeholder and result-protection records
- Existing audit infrastructure

The uploaded schedule CSV's full middle-name values continue through the existing import path. The change is in shared display formatting, not storage structure.

The canonical schedule-import header is now `Middle Name`, replacing `MI`. The import remains strict: legacy `MI` files are rejected, while complete and multi-word middle-name values are stored in the existing `students.middle_name` column.

## 15. Testing strategy

### 15.1 Name formatter tests

Verify:

- Full middle name is rendered instead of an initial.
- Blank or null middle name produces no extra spaces.
- Suffix remains in parentheses.
- Laboratory list displays the full middle name.
- Physical Exam list displays the full middle name.
- Appointments summary displays the full middle name.
- Appointment detail displays the full middle name.
- Search still matches formatted and legacy-friendly name combinations.

### 15.2 Quick-status component tests

Verify:

- Pending renders gray with the correct action label.
- Pending completes without confirmation.
- Automatic No-show renders red.
- No-show opens a two-button confirmation.
- Cancel leaves No-show unchanged.
- Confirm sends the semantic completion action.
- Completed-from-Pending renders green and reverts immediately.
- Completed-from-No-show renders green and requires confirmation.
- Saving disables repeated activation.
- Failure preserves the displayed status and shows an accessible error.
- Student links remain separate and point to the correct detail route.

### 15.3 Repository tests

Verify:

- Published appointment list exposes `completedFromStatus` from the latest completion log.
- Pending and No-show appointments expose `completedFromStatus = null`.
- Multiple historical completions select the latest transition into Completed.
- Missing or unsupported history returns null safely.
- Existing sort and pagination order remains stable.

### 15.4 Service tests

Verify:

- Pending can complete before the scheduled date.
- Appointment date remains unchanged after early completion.
- Pending completion creates one status log and audit record.
- Only an automatic No-show can complete through quick correction.
- Automatic No-show correction uses the fixed server note.
- Completed-from-Pending reverts to Pending.
- Completed-from-No-show reverts to No-show.
- Pending cannot be manually changed to No-show.
- Protected result data prevents reversal.
- Safe pending-upload placeholder is handled consistently.
- Assigned clinic staff can update their clinic.
- Staff from another clinic are rejected.
- Expected-status mismatch returns a conflict.
- Transaction failures leave all related records unchanged.

### 15.5 API tests

Verify:

- Valid `MARK_COMPLETED` request.
- Valid `REVERT_COMPLETION` request.
- Invalid or missing semantic action.
- Invalid expected status.
- Unauthorized role.
- Clinic access denial.
- Conflict response passthrough.
- Result-protection response passthrough.

### 15.6 Page tests

Verify both clinic list pages:

- No `Open` action column remains.
- Status appears as the quick-status button.
- Student name and student number link to appointment details.
- Filtering, sorting, and pagination continue working.
- Only operational published appointments appear.

Verify the Appointments page:

- Laboratory and Physical Exam statuses remain read-only badges.
- Full middle names display correctly.

## 16. Rollout order

1. Add failing tests for the full-name formatter.
2. Update the shared formatter and verify affected list/detail queries.
3. Add repository support for `completedFromStatus`.
4. Add the semantic quick-status request schema.
5. Add server-controlled completion and reversal logic.
6. Reuse result-protection and pending-placeholder behavior.
7. Add the shared quick-status button and confirmations.
8. Replace the schedule table action column with the button and student links.
9. Verify the Appointments summary remains read-only.
10. Run focused tests, the complete test suite, lint, and production build.

## 17. Acceptance criteria

The revision is accepted only when:

- Full middle names display consistently throughout the system.
- Students without a middle name render cleanly.
- The Laboratory and Physical Exam `Open` column is removed.
- Student names and numbers still open the existing detail and rescheduling page.
- Pending appointments can be completed directly from the clinic table.
- Future Pending appointments may be completed without changing their scheduled date.
- Automatic No-show correction requires one confirmation and no typed reason.
- Completed appointments restore the exact previous Pending or No-show state.
- Every transition that results in No-show requires confirmation.
- Pending cannot be manually changed directly to No-show.
- Protected or finalized result data prevents reversal.
- Appointments-tab service statuses remain read-only.
- Authorization, automatic no-show processing, status history, audits, filtering, sorting, pagination, and rescheduling continue working.
- Automated tests, lint, and production build pass.
