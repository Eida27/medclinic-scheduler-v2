# Unified Clinic Calendar Design

**Date:** 2026-07-27  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Purpose

Replace the clinic-specific unavailable-date calendar with one unified calendar that applies to both CPU Clinic and Kabalaka Clinic. The revision must correctly reschedule affected appointments, preserve completed clinic work, support same-day emergency closures, keep historical records out of operational appointment lists, and provide an administrator workflow for cases that cannot be safely automated.

## 2. Goals

The completed feature must:

- Use one shared unavailable-date calendar for both clinics.
- Display January through December for the selected year without repeated or adjacent-month date numbers.
- Support current-year and future-year editing only.
- Preserve unsaved selections across all twelve months of the selected year.
- Move the complete Laboratory and Physical Examination pair when both remain unfinished.
- Preserve a completed Laboratory appointment and move only the unfinished Physical Examination appointment.
- Save an emergency closure even when some students require manual resolution.
- Allow same-day blocking only for an emergency closure category.
- Start replacement scheduling after the final date of a contiguous closure period.
- Keep old rescheduled appointments in history while showing only current actionable appointments operationally.
- Restore original schedules only when the complete required schedule is safe.
- Prevent future imports and generated schedules from using blocked dates.

## 3. Non-goals

This design does not introduce clinic-specific closure scopes, appointment time slots, student self-rescheduling, or a general incident-management system. The unified calendar is intentionally system-wide.

## 4. Core business rules

### 4.1 Unified closure scope

Each active unavailable date applies to both clinics. The calendar page does not expose a clinic selector. Blocking or reopening a date changes the shared operational calendar.

### 4.2 Completion-aware impact handling

For every affected student, the planner classifies the current Laboratory–Physical Examination cycle:

| Current state | Required outcome |
|---|---|
| Laboratory pending, Physical pending | Move the complete pair |
| Laboratory completed, Physical pending | Preserve Laboratory and move only Physical |
| Laboratory completed, Physical completed | No appointment change |
| Laboratory pending, Physical completed | Manual resolution required |
| Appointment protected, manually locked, or inconsistent | Manual resolution required |

Completed appointments must never be reset, replaced, or assigned a new date by closure automation.

### 4.3 Closure periods

Dates saved together are grouped into contiguous closure periods. For example, August 11–13 forms one closure group, while August 20 forms another.

Replacement scheduling begins after the final date of the applicable closure group. The scheduler skips weekends, all active blocked dates, and capacity conflicts.

### 4.4 Safe closure persistence

The selected calendar changes are saved together at the closure level. Student appointment changes are atomic per student.

A known student-level safety issue must not reject a real closure. The closure remains active, safe students are processed, and unresolved students enter manual resolution.

Unexpected database or integrity failures still roll back the entire operation.

### 4.5 Manual-resolution state

An unresolved affected appointment receives status `AWAITING_RESCHEDULE`.

It must:

- Stop appearing as a valid current appointment on the closed date.
- Be excluded from ordinary Laboratory and Physical Examination operational lists.
- Appear in an administrator-only Manual Resolution Required queue.
- Appear in the student portal as **Awaiting manual reschedule**.
- Retain its original date for history and audit.
- Be ineligible for completion until resolved.

### 4.6 Reopening and restoration

Reopening one date does not reopen the rest of its original closure group.

A student is restored only when every original appointment that must remain active falls on available dates.

- Full-pair replacements restore the complete original pair all-or-nothing.
- Physical-only replacements may restore only the original Physical Examination appointment when Laboratory was already completed.
- Completed appointments remain unchanged.
- Protected, completed, manually changed, or otherwise unsafe replacements are not automatically restored.
- When restoration is unsafe, the current replacement schedule remains active and the case enters manual review.

## 5. Data model

### 5.1 `clinic_closure_groups`

Represents one continuous disruption.

Suggested fields:

- `id`
- `start_date`
- `end_date`
- `category`
- `reason`
- `created_by`
- `created_at`
- `updated_at`
- `creation_batch_id`

The original group boundaries remain immutable for audit history, even if individual dates are reopened later.

### 5.2 `clinic_unavailable_dates`

Represents one blocked day in a closure group.

Suggested fields:

- `id`
- `closure_group_id`
- `blocked_date`
- `reopened_at`
- `reopened_by`
- `reopening_batch_id`
- `updated_at`

A partial unique index must allow only one active unavailable record per date.

### 5.3 `appointment_reschedule_events`

Extend the event lineage so each event records:

- Closure group and unavailable date
- Student number and scheduling cycle
- Strategy: `MOVE_COMPLETE_PAIR`, `MOVE_PHYSICAL_ONLY`, or `MANUAL_RESOLUTION_REQUIRED`
- Original Laboratory and Physical Examination appointment IDs
- Replacement Laboratory and Physical Examination appointment IDs
- Processing outcome
- Restoration metadata
- Manual-resolution case reference when applicable

### 5.4 `clinic_closure_manual_cases`

Stores unresolved cases explicitly.

Suggested fields:

- `id`
- `student_number`
- `closure_group_id`
- Affected appointment and cycle identifiers
- `reason_code`
- `reason_message`
- `status` (`OPEN` or `RESOLVED`)
- `created_at`
- `resolved_at`
- `resolved_by`
- `resolution_details`

Reason codes include:

- `PHYSICAL_COMPLETED_BEFORE_LABORATORY`
- `APPOINTMENT_MANUALLY_LOCKED`
- `PROTECTED_RESULTS_EXIST`
- `PAIR_MISSING_OR_INCONSISTENT`
- `NO_REPLACEMENT_CAPACITY`
- `CONCURRENT_APPOINTMENT_CHANGE`

## 6. Appointment visibility and lineage

### 6.1 Successfully moved appointment

Original appointment:

```text
status = RESCHEDULED
is_published = false
```

Replacement appointment:

```text
status = PENDING
is_published = true
```

Only the replacement appears in ordinary operational lists.

### 6.2 Unresolved appointment

Original appointment:

```text
status = AWAITING_RESCHEDULE
is_published = true
```

It remains available to the student portal and manual-resolution workflow but is excluded from normal clinic operations.

### 6.3 History

Student history retains:

- Original appointment date
- Replacement date
- Closure reason
- Automatic or manual processing method
- Status transitions
- Restoration history

## 7. Calendar UI

### 7.1 Annual layout

The page displays all twelve months of the selected year. Each month shows only its true dates, with blank cells before the first day and after the final day.

No prior-month or next-month dates are rendered inside a month grid.

### 7.2 Toolbar and controls

The toolbar contains:

- Year selector
- Closure category
- Reason
- Calendar legend
- Open manual-resolution case count

The clinic selector is removed.

### 7.3 Date states

Supported visual states:

- Available
- Blocked
- Selected to block
- Selected to reopen
- Today
- Conflict
- Emergency closure
- Reopened, visible in details/history only

Past dates cannot be newly blocked or reopened through the operational calendar.

### 7.4 Same-day emergency closure

Today may be blocked only with category `EMERGENCY_CLOSURE`.

This category covers typhoons, sudden suspension announcements, utility failures, safety incidents, and unexpected same-day holidays.

The confirmation dialog requires an explicit emergency acknowledgment and explains that completed appointments remain unchanged while pending appointments are rescheduled or placed in manual resolution.

## 8. API contract

Calendar operations become date-only and no longer contain `clinicId`.

```ts
type CalendarBlockChange = {
  action: "BLOCK";
  date: string;
  category:
    | "HOLIDAY"
    | "CLOSURE"
    | "EMERGENCY_CLOSURE"
    | "MAINTENANCE"
    | "STAFF_UNAVAILABILITY";
  reason: string;
};

type CalendarReopenChange = {
  action: "REOPEN";
  date: string;
  unavailableDateId: string;
  expectedUpdatedAt: string;
};
```

All staged changes are submitted together.

## 9. Impact preview

Before confirmation, the system runs a read-only preview showing:

- Closure periods
- Affected students
- Complete pairs to move
- Physical-only moves
- Completed appointments preserved
- Expected manual cases
- Dates being reopened
- Expected restorations
- Cases that remain on replacement schedules

The authoritative save recalculates the plan under database locks.

## 10. Service architecture

### 10.1 Unified calendar repository

Responsible for reading active blocked dates, creating closure groups, blocking and reopening dates, detecting stale updates, and returning calendar history.

### 10.2 Closure-impact planner

A read-only component that resolves each student’s current scheduling cycle, classifies appointment state, determines the strategy, and finds capacity-aware replacement dates.

### 10.3 Closure application service

Responsible for authorization, advisory locking, transaction management, closure persistence, per-student savepoints, appointment writes, manual cases, audits, notifications, and final result counts.

### 10.4 Restoration planner and service

Responsible for validating original-date availability, applying completion-aware all-or-nothing restoration, preserving completed appointments, and routing unsafe cases to manual review.

### 10.5 Manual-resolution service

Responsible for listing cases, validating administrator-selected dates, checking closures and capacity, creating safe replacements, resolving cases, and notifying students.

## 11. Transaction flow

The authoritative save process is:

1. Validate permissions, dates, categories, reasons, and stale records.
2. Acquire the scheduling/import advisory lock.
3. Begin one outer transaction.
4. Normalize selected dates into contiguous closure groups.
5. Persist selected blocks and reopenings.
6. Lock affected active appointments.
7. Resolve current appointment cycles.
8. Classify students and allocate replacement capacity.
9. Process each student using an internal savepoint.
10. Create notifications and audit records.
11. Commit the transaction.
12. Return the authoritative calendar and summary.

Known safety failures roll back only the affected student’s attempted changes and create a manual case. Unexpected system failures roll back the entire transaction.

## 12. Same-day appointment handling

| Same-day state | Action |
|---|---|
| `COMPLETED` | Preserve exactly |
| `PENDING` | Reschedule automatically when safe |
| Published current-cycle `DRAFT` | Reschedule or invalidate before publication |
| `RESCHEDULED` with active replacement | Evaluate the active replacement |
| `AWAITING_RESCHEDULE` | Keep in manual queue |
| `NO_SHOW` | Manual resolution required |
| `CANCELLED` | No action |

A completed Laboratory appointment from earlier on the emergency date remains valid.

## 13. Replacement scheduling

For each closure group:

- Begin after the group’s final blocked date.
- Skip weekends.
- Skip all active blocked dates.
- Check Laboratory and Physical Examination capacities separately.
- Assign Laboratory first.
- Assign Physical Examination on the next valid clinic day after Laboratory.
- When Laboratory is completed, allocate only Physical Examination.
- Use deterministic student ordering.

Insufficient capacity routes the student to manual resolution instead of rejecting the closure.

## 14. Student portal and notifications

The student portal shows only current actionable appointments and unresolved states.

### Successfully rescheduled

- New appointment date
- `Pending`
- Closure notice and previous date

### Awaiting manual reschedule

- No closed date presented as a valid appointment
- Status **Awaiting manual reschedule**
- Closure reason
- Message that an administrator will provide a replacement date

### Completed appointment

- Original completed date
- `Completed`
- No instruction to repeat the service

Notification types:

- `CLINIC_CLOSURE_RESCHEDULED`
- `CLINIC_CLOSURE_AWAITING_RESCHEDULE`
- `CLINIC_CLOSURE_SCHEDULE_RESTORED`
- `CLINIC_CLOSURE_MANUALLY_RESOLVED`

Verified student email addresses receive email through the existing outbox. Unique event keys prevent duplicate notifications.

## 15. Manual Resolution Required page

Administrator-only capabilities:

- Open-case count
- Search by student ID or name
- Filter by closure group, date, service, and reason
- View original dates and current statuses
- View automation failure explanation
- Select capacity-aware replacement date or pair
- View case and audit history

Resolving a case atomically validates closures and capacity, preserves completed appointments, activates the required appointment, marks it `PENDING`, closes the case, and notifies the student.

## 16. Imports and future scheduling

New imports and generated schedules must read the unified blocked-date set before allocating appointments.

The scheduler must never create an active appointment on a blocked date. It skips weekends, active closures, and capacity conflicts while preserving Laboratory-before-Physical ordering.

## 17. Idempotency and concurrency

Every preview and save request uses a client-generated request ID.

The server uses:

- `request_id` for duplicate submission protection
- `batch_id` for the calendar operation
- Closure-group IDs for disruption periods
- Unique event keys for notifications
- Original-to-replacement uniqueness constraints

Retried confirmed requests return the existing result without creating duplicate appointments, events, manual cases, or notifications.

Stale changes fail with a calendar conflict and require reload.

## 18. Error handling

### Request-level errors

Nothing is saved for invalid dates, categories, reasons, past dates, unauthorized roles, malformed requests, or same-day blocks without Emergency Closure.

### Calendar-level conflicts

Nothing is saved for duplicate active blocks, stale reopenings, simultaneous calendar edits, invalid closure groups, or advisory-lock timeout.

### Student-level safety issues

The closure is saved and the student enters manual resolution for missing pairs, protected results, impossible completion order, insufficient capacity, concurrent appointment modification, unsafe restoration, or manual locks.

Unexpected programming or database-integrity errors roll back the entire transaction.

## 19. Authorization

Only administrators may block or reopen dates, perform same-day emergency closures, view all manual cases, resolve cases, or override replacement recommendations.

Clinic staff may view closures and current actionable appointments for their assigned clinic but cannot modify the unified calendar.

Students may view only their own current schedule, unresolved status, notifications, and relevant history.

## 20. Audit requirements

Audit each closure operation with administrator, request and batch IDs, selected dates, category, reason, same-day emergency flag, previewed counts, final counts, moved students, preserved completions, manual cases, and reopening outcomes.

Audit each manual resolution with the original safety failure, selected resolution, capacity decision, old and new appointment IDs, administrator, and timestamp.

Do not copy medical result contents into general audit metadata.

## 21. One-time cleanup

Because the system is not deployed, the rollout begins from a clean unified calendar state.

The cleanup migration must:

1. Identify events caused by existing clinic-specific unavailable dates.
2. Verify generated replacements are attributable to those events.
3. Restore original Laboratory and Physical Examination appointments to `PENDING` and `is_published = true`.
4. Remove generated replacement appointments and their status logs.
5. Remove clinic-calendar reschedule events.
6. Remove existing clinic-specific unavailable-date records.
7. Remove only related test audit and notification records.
8. Verify each affected student again has one valid original cycle.
9. Create the unified schema with no active blocked dates.

The migration must stop before destructive cleanup when it finds completed replacements, protected results, or ambiguous lineage.

## 22. Testing

### Unit tests

- Correct days for every month and leap years
- No adjacent-month or repeated dates
- Date-only draft keys
- Unsaved changes across twelve months
- Current and future years only
- Same-day category validation
- Contiguous closure groups
- Completion-aware classification
- Scheduling after final closure date
- Weekend, closure, and capacity skipping
- Deterministic ordering

### Integration tests

- One active block per date
- Closure and reopening constraints
- Original/replacement lineage
- Historical originals unpublished after successful move
- `AWAITING_RESCHEDULE` excluded from operational lists
- Per-student savepoint rollback
- Full rollback on unexpected failure
- Idempotent duplicate request
- Import and closure concurrency protection
- New imports avoid blocked dates

### Restoration tests

- Complete pair restored all-or-nothing
- Partial reopening does not restore prematurely
- Completed Laboratory remains unchanged
- Safe Physical-only restoration
- Completed or protected replacement blocks restoration
- Unsafe restoration keeps current replacement and creates manual review

### End-to-end tests

- Block before import
- Future Laboratory closure
- Future Physical Examination closure
- Same-day typhoon after Laboratory completion
- Old dates disappear from operational pages
- Student sees replacement dates
- Student sees Awaiting manual reschedule when unresolved
- Administrator resolves a manual case
- Safe reopening restores original schedule
- Notifications are not duplicated

## 23. Rollout order

1. Add cleanup preflight tests.
2. Add unified schema migration and `AWAITING_RESCHEDULE` status.
3. Restore existing original schedules and remove old clinic-specific closure lineage.
4. Add unified repositories and planners.
5. Replace the API contract.
6. Replace the calendar with the annual unified interface.
7. Update operational appointment queries.
8. Update student portal and notifications.
9. Add the Manual Resolution Required page.
10. Run unit, integration, end-to-end, type-check, and production-build verification.

## 24. Acceptance criteria

The revision is accepted only when:

- One date selection blocks both clinics.
- January through December render without repeated dates.
- Old rescheduled rows no longer appear as current clinic appointments.
- Replacement appointments begin after the complete closure period.
- Completed services never move backward.
- Same-day emergency closure works safely.
- Unsafe cases become Awaiting manual reschedule.
- New imports avoid blocked dates.
- Reopening uses completion-aware all-or-nothing restoration.
- Every operation has auditable and reversible lineage.
