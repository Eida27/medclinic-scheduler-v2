# Physical Exam Laboratory Status and Loading Lock Design

**Date:** 2026-07-31  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Scope:** Physical Exam appointment table and shared quick-status control

## Objective

Improve the Physical Exam page in two focused ways:

1. Show each student's current Laboratory appointment status beside the Physical Exam status.
2. Prevent duplicate appointment-status requests by locking the status control immediately and showing a spinner with `Updating...` while the update and server refresh are in progress.

The Laboratory status is informational only on the Physical Exam page. Administrators continue to update Laboratory appointments from the Laboratory tab.

## Approved Table Layout

The Physical Exam table will use this column order:

1. Student
2. Service
3. Date
4. Laboratory Status
5. Physical Exam Status

The existing generic `Status` heading will be renamed to `Physical Exam Status` on this page so the two status columns are unambiguous.

The Laboratory page will retain its current table layout and will not gain an additional paired-status column.

## Laboratory Status Behavior

### Read-only badge

The new Laboratory Status cell is not clickable. It displays a compact badge using the same status meaning as the operational appointment statuses:

- `Pending` — neutral gray
- `Completed` — green
- `No-show` — red
- `Not available` — muted neutral style when no current paired Laboratory appointment can be resolved

The badge must not imply interactivity. It will not use hover shine, lift, pointer cursor, or button semantics.

### Current paired appointment resolution

The appointment-list repository will return an optional `laboratoryStatus` for Physical Exam rows.

The preferred match is the current published Laboratory appointment belonging to the same schedule pair. A matching row must:

- have `schedule_type = 'LABORATORY'`
- belong to the same student
- belong to the same scheduling cycle
- use the same non-null `schedule_pair_id` when one is available
- not be an obsolete `RESCHEDULED` or `CANCELLED` record

For legacy data where the Physical Exam row has no usable pair identifier, the query may fall back to the student's current published Laboratory appointment in the same scheduling cycle. The fallback must be deterministic and must not select an obsolete appointment when a newer active replacement exists.

If no valid match exists, the UI displays `Not available` rather than guessing a status.

### Query scope

The paired Laboratory status should be retrieved as part of the appointment-list query rather than through one browser request per table row. This avoids an N+1 request pattern and keeps pagination, filtering, and rendering based on one server result.

The additional repository field may be nullable for pages that do not request or need paired status information.

## Shared Table Component

`ClinicPublishedSchedule` remains the shared table component used by the Laboratory and Physical Exam pages.

It will receive an explicit option such as `showLaboratoryStatus` or equivalent page-specific column configuration. When enabled:

- the Laboratory Status heading is inserted between Date and Physical Exam Status
- each row renders the read-only Laboratory badge
- the final clickable status heading is `Physical Exam Status`

When disabled:

- the existing four-column layout remains unchanged
- the final heading remains appropriate to the page's existing behavior

The Physical Exam page enables the paired-status column. The Laboratory page does not.

## Duplicate-submission Root Cause

The current quick-status component uses React state to disable the button. That protects the control after React has rendered the pending state, but it does not provide a synchronous lock at the exact start of the event handler.

There is also a refresh gap after a successful PATCH request: `router.refresh()` is triggered, but the local pending state can be cleared before the refreshed server props have replaced the old status. During that gap, the stale control can become clickable again and send the same expected-status request, which the server correctly rejects as a status conflict.

The server's expected-status validation remains necessary and authoritative. The client-side change prevents avoidable duplicate requests and improves feedback; it does not replace concurrency protection in the API or database layer.

## Loading Lock Design

### Immediate synchronous lock

`AppointmentQuickStatusButton` will add a mutable in-flight guard, such as a ref, in addition to rendered React state.

At the beginning of submission:

1. Check the synchronous guard.
2. Return immediately when another submission is already active.
3. Set the guard before awaiting any work or relying on a React re-render.
4. Set the visible pending state.

This guarantees that rapid clicks occurring in the same render window cannot start a second PATCH request.

### Successful update lifecycle

After a successful PATCH response:

1. Close any confirmation dialog.
2. Trigger `router.refresh()`.
3. Keep the button locked and visibly busy while the component still displays the old server-provided status.
4. Release the lock only after refreshed props reflect the authoritative status transition.

The component must not clear the busy state immediately in a generic `finally` block after a successful response.

Because every supported quick action changes the operational status (`PENDING` or `NO_SHOW` to `COMPLETED`, or `COMPLETED` back to its recorded source status), the refreshed status prop provides a deterministic completion signal.

### Failed update lifecycle

When the request fails, returns a non-success response, or throws a connection error:

- keep the original authoritative status visible
- show the existing inline or dialog error
- release both the synchronous guard and rendered pending state
- allow the administrator to retry

The component must not remain permanently locked after a failed request.

### Prop changes and row reuse

The guard and busy state must also reset safely when the component receives a different appointment identifier or authoritative status through navigation, pagination, filtering, or refresh. A stale lock from one row must never affect another appointment.

## Loading Appearance

While processing, the clickable Physical Exam status button will:

- be disabled
- retain its current status tone until refreshed data arrives
- display a small rotating spinner followed by `Updating...`
- use `aria-busy="true"`
- expose an accessible label such as `Updating appointment status`
- suppress hover lift, scale, and shine effects
- use a disabled cursor

The spinner is decorative and should be hidden from assistive technology. Its animation must respect reduced-motion preferences.

The same improved loading behavior applies to the shared status button wherever it is used, including the Laboratory page.

## Confirmation Dialog Behavior

Existing confirmation requirements remain unchanged:

- Pending to Completed remains immediate.
- No-show to Completed continues to require confirmation.
- Completed back to Pending remains immediate when Pending is the recorded source status.
- Completed back to No-show continues to require confirmation.

When a confirmed action is submitted, the dialog confirm control and the row status control must share the same in-flight lock. Repeated confirm clicks must not create duplicate requests, and the dialog cannot be dismissed while the request is processing.

## Error Handling

- The UI must preserve and display API conflict messages rather than hiding them.
- A genuine conflict caused by another administrator or browser session remains possible and should still instruct the user to refresh or retry as appropriate.
- A missing paired Laboratory appointment is a display condition, not a page-level failure; render `Not available`.
- Failure to load the appointment list remains handled by the page's existing server error behavior.
- No optimistic status transition is introduced. The updated status shown after success comes from refreshed server data.

## Accessibility

- The Laboratory status uses text in addition to color.
- The read-only badge is rendered as non-interactive content.
- The busy status button remains disabled and marked with `aria-busy`.
- The accessible name changes to describe the in-progress update.
- The spinner is not separately announced.
- Existing keyboard focus and confirmation-dialog focus behavior remain intact.
- Reduced-motion users do not receive unnecessary continuous rotation; an equivalent static busy indicator may be used when motion is reduced.

## Testing Requirements

### Repository and page data

Add or update tests to verify:

1. A Physical Exam row receives the status of its current paired Laboratory appointment.
2. A replacement/current Laboratory appointment is selected instead of an obsolete rescheduled record.
3. Legacy fallback matching is deterministic when `schedule_pair_id` is unavailable.
4. No match returns `laboratoryStatus = null` and renders `Not available`.
5. Pagination totals and existing Physical Exam filters remain unchanged.

### Table rendering

Verify that:

1. The Physical Exam table renders `Laboratory Status` between Date and `Physical Exam Status`.
2. Laboratory status badges are read-only and show the correct text and tone.
3. The Laboratory page retains its current column structure.
4. Empty-state and pagination column behavior remain valid.

### Quick-status control

Extend the component tests to verify:

1. Two rapid activations before a React re-render send only one PATCH request.
2. The synchronous guard also blocks repeated confirmation submissions.
3. The button shows a spinner and `Updating...` while busy.
4. The button remains disabled after a successful response until authoritative refreshed props change.
5. The lock is released after refreshed props reflect the new status.
6. Request and API failures release the lock and allow retry.
7. Changing to a different appointment row resets stale local lock state.
8. Existing payloads, confirmation rules, status tones, accessible labels, and error messages remain unchanged.

Tests should focus on observable behavior rather than private implementation details.

## Expected Files to Change

Implementation will likely affect:

- `src/server/repositories/appointments.repository.ts`
- repository or integration tests covering appointment summaries
- `src/app/(dashboard)/physical-exam/page.tsx`
- `src/app/(dashboard)/physical-exam/page.test.tsx`
- `src/components/appointments/ClinicPublishedSchedule.tsx`
- `src/components/appointments/ClinicPublishedSchedule.test.tsx`
- `src/components/appointments/AppointmentQuickStatusButton.tsx`
- `src/components/appointments/AppointmentQuickStatusButton.test.tsx`

A small shared read-only status badge component may be introduced only when it prevents duplicated status-label and tone logic. No database migration is expected because the existing appointment relationship and status fields are sufficient.

## Out of Scope

- Updating Laboratory status from the Physical Exam page
- Changing appointment transition rules
- Removing server-side expected-status conflict checks
- Adding a new client-side API request for every row
- Changing appointment dates, rescheduling, capacity, or clinic calendar rules
- Adding new database status values
- Broad table redesign unrelated to the new status column

## Acceptance Criteria

The work is complete when:

- The Physical Exam table shows a read-only Laboratory Status column between Date and Physical Exam Status.
- Each badge reflects the current paired Laboratory appointment or displays `Not available` when no valid pair exists.
- Only the Physical Exam status remains clickable on the Physical Exam page.
- Clicking a status control immediately disables it and shows a spinner with `Updating...`.
- Rapid clicks and repeated confirmation clicks produce only one PATCH request.
- A successful request remains locked until refreshed server props show the new authoritative status.
- A failed request shows an error, restores interactivity, and permits retry.
- The server-side conflict guard remains unchanged.
- The Laboratory page's existing table columns remain unchanged.
- Relevant unit and integration tests pass without weakening existing status-transition coverage.
