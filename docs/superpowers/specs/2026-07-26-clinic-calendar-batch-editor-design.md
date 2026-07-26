# Clinic Calendar Batch Editor Design

## Summary

Revise the existing admin Clinic Calendar so administrators can configure unavailable dates before any coordinator CSV import, edit dates across both clinics and all months of the current or future years, review all pending changes, and save them once as one atomic operation.

The design keeps the current Clinic Calendar route and backend scheduling architecture, but replaces immediate per-date persistence with a client-side draft editor and a transactional batch API.

## Goals

- Allow admins to configure unavailable dates before schedules or CSV imports exist.
- Show only the numbered dates that belong to the selected month.
- Permit admins to stage both block and unblock actions.
- Preserve unsaved edits while navigating months, years, and clinics.
- Save all staged changes through one confirmation and one atomic transaction.
- Automatically restore appointments moved by a mistaken block when every affected replacement remains safe to reverse.
- Prevent partial updates, broken appointment pairs, schedule conflicts, and result-history corruption.

## Non-goals

- Persisting unfinished draft sessions in the database.
- Editing historical years earlier than the current calendar year.
- Automatically overriding completed, manually locked, rescheduled, or result-protected appointments.
- Adding unrelated calendar, scheduling, or clinic-management features.

## Approved interaction model

### Supported time range

The calendar supports January through December of the selected year. Admins may select the current year or future years, but not previous years.

Month navigation crosses year boundaries normally. Moving backward from January of the current year is disabled.

### Clinics

The editor manages unavailable dates separately for the KABALAKA Laboratory Clinic and CPU Physical Examination Clinic.

Unsaved edits are preserved when the admin switches clinics. A single Save action may include changes for both clinics.

### Draft editing

The calendar separates:

- persisted state loaded from the server;
- unsaved draft changes held in browser state.

Clicking a date never writes to the database immediately.

For an available date:

- first click stages `BLOCK`;
- second click cancels that staged block.

For an actively blocked date:

- first click stages `UNBLOCK`;
- second click cancels that staged unblock and restores the saved blocked appearance.

Draft changes remain available while switching months, years, and clinics.

### Save and discard

The page provides:

- **Discard changes**, which clears all unsaved edits and restores the last persisted state;
- **Save changes**, which opens one review-and-confirmation dialog.

The confirmation dialog groups changes by clinic and shows:

- dates to block;
- dates to unblock;
- category and reason for new blocks;
- total affected clinics and dates;
- a warning that blocking may reschedule appointments and unblocking may restore them.

After confirmation, all changes are submitted together. There is no second confirmation.

## Calendar presentation

### Month grid

The calendar retains a seven-column Sunday-to-Saturday layout.

Only dates belonging to the selected month receive date numbers and interactive cells. Leading and trailing positions needed for weekday alignment are blank placeholders with no number, no click behavior, and no screen-reader date announcement.

For example, July displays only 1 through 31. It does not display numbered dates from June or August.

### Weekends

Saturdays and Sundays remain visible when they belong to the selected month, but are displayed as non-scheduling days and cannot be blocked or unblocked through this editor.

The scheduling engine already skips weekends, so separate unavailable-date records are unnecessary.

### Date states

Each date has one clear state:

- available;
- saved blocked;
- staged to block;
- staged to unblock;
- saving;
- conflict/error after a rejected save.

Status must not depend on color alone. Each cell includes visible text or iconography and an accessible label containing the full date and state.

## Frontend architecture

Refactor the current large calendar component into focused units:

```text
ClinicUnavailableCalendarEditor
├── ClinicCalendarToolbar
├── BlockConfigurationForm
├── ClinicMonthGrid
│   └── ClinicCalendarDay
├── CalendarDraftSummary
├── CalendarSaveConfirmationDialog
└── CalendarSaveResult
```

### ClinicUnavailableCalendarEditor

Owns:

- selected clinic;
- selected year and month;
- persisted unavailable-date records;
- draft changes;
- save, discard, refresh, and error handling;
- unsaved-navigation protection.

### ClinicCalendarToolbar

Owns clinic selection, year selection, and previous/next month navigation.

### BlockConfigurationForm

Owns category and reason inputs used when staging new blocks.

Supported categories remain:

- Holiday;
- Closure;
- Maintenance;
- Staff unavailability.

Each staged block captures the category and reason active at the time it is selected. Later form changes do not silently rewrite already-staged dates.

### ClinicMonthGrid and ClinicCalendarDay

Render weekday headings, blank alignment cells, current-month date cells, keyboard behavior, and visual states. They receive computed states from the editor rather than implementing persistence rules.

### CalendarDraftSummary

Shows totals across all clinics, months, and years in the current editing session.

### CalendarSaveConfirmationDialog

Combines change review and final confirmation in one dialog to avoid extra friction.

## Draft data model

Draft changes are keyed by `clinicId + date` so only one pending action can exist for a clinic/date pair.

```ts
type CalendarDraftChange =
  | {
      action: "BLOCK";
      clinicId: string;
      date: string;
      category: "HOLIDAY" | "CLOSURE" | "MAINTENANCE" | "STAFF_UNAVAILABILITY";
      reason: string;
    }
  | {
      action: "UNBLOCK";
      clinicId: string;
      date: string;
      unavailableDateId: string;
      expectedUpdatedAt: string;
    };
```

The displayed calendar is always derived from persisted server records plus the relevant draft changes.

## Unsaved-change protection

When draft changes exist:

- refreshing or closing the browser tab triggers a warning;
- navigating away through the application triggers a discard warning;
- switching calendar months, years, or clinics does not trigger a warning.

The warning offers:

- Continue editing;
- Discard and leave.

## Data model changes

### Soft-unblocking unavailable dates

Do not delete unavailable-date rows. Appointment reschedule history already references them, so physical deletion would weaken auditability.

Add nullable fields to `clinic_unavailable_dates`:

```text
unblocked_at TIMESTAMPTZ
unblocked_by UUID REFERENCES users(id)
```

Add a constraint requiring both fields to be null or both non-null.

A block is active when `unblocked_at IS NULL`. Scheduling and availability queries must ignore unblocked rows.

### One record per date

New calendar records always use:

```text
start_date = end_date
```

The existing columns remain for compatibility.

Before enabling individual-date unblocking, inspect active legacy ranges. Any multi-day active range must be normalized into one row per date while preserving clinic, category, reason, creator, and historical links.

After normalization, add database protection preventing multiple active unavailable-date records for the same clinic and date. Use a partial unique index or equivalent database-enforced constraint.

### Restoration metadata

Extend the relevant reschedule-history model with restoration metadata, such as:

```text
restored_at TIMESTAMPTZ
restored_by UUID REFERENCES users(id)
```

This prevents duplicate restoration and preserves a complete history of the original move and later reversal.

## Batch API

Replace immediate per-cell writes with a batch operation.

Conceptual request:

```json
{
  "changes": [
    {
      "action": "BLOCK",
      "clinicId": "clinic-id",
      "date": "2026-07-15",
      "category": "CLOSURE",
      "reason": "Clinic unavailable"
    },
    {
      "action": "UNBLOCK",
      "clinicId": "clinic-id",
      "date": "2026-08-04",
      "unavailableDateId": "block-id",
      "expectedUpdatedAt": "2026-07-26T03:10:00.000Z"
    }
  ]
}
```

The endpoint must:

- require an admin;
- reject malformed or duplicate actions;
- reject contradictory block/unblock actions for one clinic/date;
- validate clinics, dates, category, and reason;
- reject dates earlier than the current year;
- reject today and past dates for editing;
- verify active block identity and version before unblocking;
- validate the complete batch before mutation.

## Transaction and concurrency model

One Save action is one all-or-nothing database transaction across both clinics and every staged month.

Recommended sequence:

1. Acquire the existing scheduling/import advisory lock.
2. Lock all unavailable-date rows being reopened.
3. Lock appointments affected by new blocks.
4. Lock original and replacement appointments involved in restoration.
5. Lock effective scheduling scopes.
6. Validate all blocks, unblocks, reschedules, and restorations.
7. Insert new unavailable-date records.
8. Reschedule appointments affected by new blocks.
9. Restore appointments affected by reversed blocks.
10. Mark reversed blocks as unblocked.
11. Write status logs, reschedule/restoration history, notifications, and audit logs.
12. Commit.

Any error rolls back the entire batch.

Use `expectedUpdatedAt` for optimistic concurrency when unblocking. If the row is no longer active or its `updated_at` differs, reject the complete batch as stale.

## Blocking behavior

### Before CSV import

Creating a block before schedules exist simply records the unavailable date. No appointments are moved. Future imports and automatic scheduling must skip the date.

### After publication

When pending published appointments exist on the blocked date, reuse the existing automatic rescheduling rules:

- KABALAKA block: move the paired Laboratory and Physical Examination appointments together;
- CPU Clinic block: move only the Physical Examination appointment while preserving its Laboratory appointment.

Continue recording old and replacement appointment IDs, status logs, notifications, and audit events.

## Unblocking and safe restoration

Unblocking uses all-or-nothing safe restoration for the appointments associated with that exact unavailable-date record.

### No appointments were moved

When the block was created before scheduling and has no reschedule events:

- mark it unblocked;
- make the date available immediately;
- perform no appointment restoration.

### Appointments were moved

Restore only when every associated replacement appointment is reversible and every original appointment is restorable.

A replacement is reversible only when it:

- remains `PENDING`;
- remains published;
- is not manually locked;
- has no finalized result submission;
- has no protected laboratory or examination result;
- has not been independently rescheduled or replaced again;
- still belongs to the replacement pair created by the block.

An original appointment is restorable only when it:

- still exists;
- belongs to the expected reschedule event;
- remains in the expected inactive state;
- does not conflict with another active appointment for the same student, clinic, schedule type, and academic cycle;
- does not violate applicable clinic capacity after restoration.

If one appointment fails any check, reject the entire Save transaction. Keep the date blocked and restore none of the appointments.

### Restoration mechanics

On successful restoration:

- reactivate the original appointment records as `PENDING`;
- mark the generated replacement appointments inactive using the existing historical status model;
- restore paired appointments together for a KABALAKA block;
- restore only the original Physical Examination appointment for a CPU Clinic block;
- add status logs explaining that the clinic block was reversed;
- mark the reschedule history as restored;
- notify affected students of their restored schedule.

Do not create another fresh appointment when the original record can be safely reactivated.

## Error handling

Return structured batch errors grouped by clinic, date, and action.

Example categories:

- invalid draft change;
- active block conflict;
- stale unavailable-date version;
- protected replacement appointment;
- missing original appointment;
- capacity conflict;
- pair-integrity failure.

A rejected response clearly states that no changes were saved.

The frontend preserves all draft changes after failure and highlights conflicting dates. It may refresh persisted records while retaining compatible draft actions.

## Success response

On success, return enough information to update the editor without losing its current view:

- refreshed active unavailable-date records or normalized deltas;
- blocked-date count;
- unblocked-date count;
- moved-student and moved-appointment counts;
- restored-student and restored-appointment counts.

The frontend clears the draft, closes the dialog, shows a success message, and remains on the current clinic/month.

## Notifications and audit history

Student notifications are created only when appointments actually move or are restored.

Create audit records for:

- the overall batch;
- each newly blocked date;
- each unblocked date;
- each appointment restoration.

Suggested action names:

```text
CLINIC_CALENDAR_BATCH_UPDATED
CLINIC_UNAVAILABLE_DATE_CREATED
CLINIC_UNAVAILABLE_DATE_UNBLOCKED
CLINIC_BLOCK_APPOINTMENTS_RESTORED
```

Use a generated batch ID to connect calendar audit records, appointment logs, reschedule/restoration events, and notifications.

## Accessibility and responsive behavior

- Provide full date and state in accessible labels.
- Support Enter and Space for toggling editable dates.
- Use visible focus indicators.
- Do not rely on color alone.
- Trap focus inside the confirmation dialog and restore focus when it closes.
- Keep practical touch targets.
- Allow horizontal scrolling where needed without forcing the full page wider.
- Stack toolbar and form controls on narrow screens.

## Testing strategy

### Calendar utility tests

Verify:

- every month from January through December;
- leap-year February;
- months beginning on every weekday;
- numbered cells contain only current-month dates;
- leading and trailing cells are blank placeholders;
- December-to-January navigation;
- prevention of navigation into years earlier than the current year.

### Component tests

Verify:

- available date click stages a block without an API call;
- second click cancels the staged block;
- saved blocked date click stages an unblock;
- second click cancels the staged unblock;
- month, year, and clinic switching preserve drafts;
- each staged block preserves its selected category and reason;
- Save is disabled with no changes;
- one review/confirmation dialog appears;
- canceling confirmation preserves drafts;
- successful save clears drafts;
- failed save preserves drafts;
- Discard clears all drafts;
- weekends and blank cells are not editable;
- unsaved-navigation warnings work.

### API route tests

Verify:

- admin authorization;
- valid mixed batch;
- malformed payload;
- duplicate and contradictory actions;
- unsupported or past dates;
- stale `updated_at` conflict;
- database active-block uniqueness conflict;
- full rollback when one action fails.

### Service integration tests

Verify:

1. Block a date before imports and confirm later scheduling skips it.
2. Block a date with pending appointments and create replacements.
3. Immediately unblock and restore the originals.
4. Reject unblock after a replacement is completed.
5. Reject unblock after a result is finalized.
6. Roll back every change when one restoration is unsafe.
7. Restore KABALAKA appointment pairs together.
8. Restore only Physical Examination after a CPU Clinic block.
9. Save changes across both clinics atomically.
10. Serialize calendar saving against CSV import/publication.
11. Handle two admins editing the same block.
12. Normalize or support legacy multi-day records correctly.

### End-to-end test

Cover the complete workflow:

1. Open the Clinic Calendar.
2. Stage changes across several months.
3. Switch clinics and preserve drafts.
4. Review the combined summary.
5. Confirm once and save.
6. Reload and verify persistence.
7. Unblock a mistaken date and restore appointments.
8. Trigger a protected restoration and verify that no changes are committed.

## Acceptance criteria

The feature is complete when:

- the calendar displays only current-month date numbers;
- admins can configure all months in the current and future years before imports;
- block/unblock changes remain unsaved until Save;
- drafts persist across clinics, months, and years in the editing session;
- one confirmation saves the complete batch;
- successful batches are atomic;
- failed batches commit nothing and retain the draft;
- safe unblocking restores all affected original appointments;
- unsafe restoration rejects the complete batch;
- scheduling, imports, appointment pairs, results, notifications, and audit history remain consistent;
- automated tests cover the utility, component, API, service, concurrency, and end-to-end workflows.
