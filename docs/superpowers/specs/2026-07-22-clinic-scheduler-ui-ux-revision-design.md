# Clinic Scheduler UI/UX Revision Design

## Goal

Simplify the administrative and clinic workflows, prevent accidental duplicate actions, keep users within the correct clinic context, allow safe status corrections, repair completion filtering, and remove redundant system features.

## 0. Standard Windows CSV Compatibility

The academic-year student importer accepts the two standard Excel CSV exports used by staff:

- CSV UTF-8, with or without a byte-order mark (BOM).
- Excel CSV (Comma delimited), decoded as Windows-1252.

String inputs continue to reach the CSV parser unchanged. Byte inputs are decoded as strict UTF-8 first using a fatal decoder; only a UTF-8 decoding failure triggers a Windows-1252 decode of the same bytes. UTF-16 remains unsupported, and no encoding dependency or sniffing layer is added.

All importer rules remain unchanged: the exact nine-column header contract and order, trailing-empty-column normalization, 1 MB file limit, 3,000-row limit, strict `MM-DD-YYYY` dates, duplicate detection, validation messages unrelated to encoding, and the single atomic import transaction.

### Acceptance criteria

- UTF-8 byte input parses with and without a BOM.
- Windows-1252 input preserves characters such as `Peña`.
- Malformed CSV and incorrect headers remain rejected.
- Import guidance names both CSV UTF-8 and Excel CSV (Comma delimited) / Windows-1252 without implying that every CSV encoding is accepted.

## 1. Student Schedule Import Progress

### Revised behavior

After **Agree and import** is clicked:

- Immediately disable both dialog buttons.
- Replace the confirmation button content with a spinner and **Importing and publishing…**
- Apply `aria-busy="true"` to the dialog.
- Prevent closing through Escape while the import is running.
- Keep the loading state active after a successful response until navigation finishes and the component unmounts.
- Restore the buttons only when the request fails.
- Display the returned error in the import form after closing the dialog.

### Important implementation rule

Do not reset `pending` in a successful request’s `finally` block. The successful navigation path must leave the dialog locked.

### Acceptance criteria

- Double-clicking cannot create duplicate requests.
- Only one POST request is sent.
- The button cannot become clickable again before navigation.
- A clear loading animation remains visible during long imports.
- Failed imports return the user to an editable form.

---

## 2. Clinic-Specific Student Appointment Profiles

### Revised routing

Create clinic-specific appointment detail pages:

- `/laboratory/[appointmentId]`
- `/physical-exam/[appointmentId]`

The existing `/appointments/[appointmentId]` page remains available when users enter from the Appointments tab.

All three routes should render one shared appointment-detail component. The route determines the active sidebar destination and verifies that the appointment belongs to the expected clinic service.

### Laboratory behavior

Selecting **Open** from Laboratory keeps the Laboratory navigation item active and opens the laboratory appointment profile.

### Physical Examination behavior

Selecting **Open** from Physical Exam keeps the Physical Exam navigation item active and opens the physical examination appointment profile.

### Completed-status corrections

A completed appointment must show a separate **Correct status** section.

Allowed corrections:

- `COMPLETED → PENDING`
- `COMPLETED → NO_SHOW`

Every correction requires a written reason.

Validation rules:

- Pending is intended for an appointment that still needs to occur or be rechecked.
- No-show is intended for a past appointment where the student did not attend.
- Clinic staff may correct only appointments belonging to their assigned clinic.
- Administrators may correct either clinic.
- The correction must be saved atomically with its status history and audit log.
- The audit action must identify the old status, new status, correction reason, actor, and source page.

### Result-data protection

Completing an appointment automatically creates a `PENDING_UPLOAD` result placeholder. When completion is reverted:

- Delete the linked placeholder when it is still only `PENDING_UPLOAD` and no student files exist.
- Block the correction when a finalized submission, uploaded files, or an already verified result exists.
- Show a clear message explaining why the appointment cannot be reopened.
- Never silently delete finalized or verified medical-result data.

### UI safeguards

- Put corrections in a warning-styled card, separate from ordinary updates.
- Require a confirmation dialog.
- Disable controls while saving.
- Refresh the appointment profile and status history after success.

---

## 3. Simplified Appointments Filters

Remove the **More filters** section completely.

### Retained filters

Use one visible filter row containing:

1. **Student name or number**
2. **Overall completion**
3. **Laboratory status**
4. **Physical exam status**
5. **Sort**
6. **Apply**
7. **Clear**

Remove these filters from the UI:

- Appointment date
- Operational appointment status
- College
- Program
- Priority group

Those concerns are already better handled in the clinic-specific and student-schedule pages.

### User-facing status labels

The database and API values remain unchanged, but the interface must display:

| Internal value | Display label |
| --- | --- |
| `PENDING_UPLOAD` | Pending |
| `COMPLETED` | Completed |
| `REQUIRES_FOLLOW_UP` | Needs follow-up |
| `NOT_APPLICABLE` | Not applicable |
| `COMPLETE` | Complete |
| `INCOMPLETE` | Incomplete |
| `FOLLOW_UP` | Needs follow-up |

Never display raw underscore-separated enum values in filters, badges, metrics, or empty states.

### Completion-filter behavior

The following combinations must work:

- Overall completion = Complete
- Laboratory = Completed
- Physical exam = Completed
- Laboratory = Completed and Physical exam = Completed
- Laboratory = Pending and Physical exam = Completed
- Overall completion = Needs follow-up

The filtered metrics and pagination must use exactly the same conditions as the displayed rows.

### Empty state

Use:

> No students match the selected filters. Clear one or more filters and try again.

---

## 4. Remove the Results Feature

Remove **Results** from the primary sidebar for administrators and clinic staff.

### Route handling

Keep `/results` temporarily as a redirect to `/appointments` so old bookmarks do not produce a 404 page.

### Dead-code cleanup

Remove the legacy functionality that is used exclusively by the Results workspace:

- Results workspace component
- Results API route
- Results page tests
- Results API tests
- Unused imports and types

Do not remove shared result tables, repositories, or services that are still used by student uploads, appointment completion, compliance reporting, or the administration review page.

### Expected navigation

The primary workflow becomes:

- Dashboard
- Laboratory
- Physical exam
- Students & Schedules
- Appointments

---

## 5. Maximum-Only Clinic Capacity

The Capacity page must expose only:

- Clinic/service name
- Maximum students per day
- Save button

Remove all **Recommended**, **Warning limit**, and **Safe capacity** wording.

### Scheduling behavior

Maximum capacity becomes the only operational limit:

- Load less than or equal to maximum: valid
- Load above maximum: conflict
- No warning state
- No hidden recommended-capacity ceiling
- Automatic scheduling may fill a date up to its configured maximum
- Clinic-closure rescheduling uses the same maximum
- Priority displacement uses the same maximum

### Compatibility approach

For minimum migration risk:

- Stop exposing `safeDailyCapacity` through UI and service interfaces.
- Make every capacity update synchronize the legacy safe column to the same value as maximum.
- Update all scheduling logic to read only maximum capacity.
- Normalize existing database records so safe and maximum contain the same value.
- Treat the old safe-capacity column as deprecated compatibility data until a later database-cleanup migration.

This removes the behavior immediately without requiring a risky destructive column removal in the same UX release.

---

## 6. Clickable Clinic Calendar

Replace the current start-date/end-date form and plain history table with a monthly calendar grid.

### Calendar controls

Display above the grid:

- Clinic selector
- Previous month
- Current month and year
- Next month
- Category
- Reason

The category and reason are retained because unavailable dates trigger rescheduling, notifications, and audit records.

### Date-cell behavior

Each day is an accessible button.

Cell states:

- Available
- Unavailable
- Saving
- Past or today
- Weekend
- Error

Past dates, the current Manila date, and weekends cannot be selected.

Once a clinic, category, and valid reason are supplied:

- Clicking an available future date immediately marks it unavailable.
- The selected cell enters a loading state.
- The existing atomic clinic-block service runs with the clicked date as both start and end.
- On success, the cell becomes unavailable without requiring a full-page reload.
- Show how many students and appointments were automatically moved.
- On failure, restore the available state and display the server’s error.

### Existing unavailable dates

Unavailable ranges must be expanded into individual calendar cells.

Selecting or focusing an unavailable cell should reveal:

- Clinic
- Category
- Reason
- Original date range

Already unavailable cells cannot be submitted again.

### Safety behavior

The backend continues to reject:

- Overlapping unavailable dates
- Dates that are not in the future
- Blocks containing protected appointments
- Blocks for which no valid replacement schedule can be generated

The calendar must display these errors without leaving a falsely blocked cell.

---

## Shared UI Improvements

Add a reusable loading indicator that can be used by:

- Confirmation dialogs
- Import actions
- Status corrections
- Calendar date cells
- Capacity saves

All asynchronous controls must:

- Prevent duplicate submission
- Display visible progress
- Expose an accessible busy state
- Preserve the user’s current page context
- Show a clear success or failure result

## Required Regression Coverage

The implementation must include tests for:

- UTF-8 byte input with and without a BOM, plus Windows-1252 fallback.
- Malformed CSV and the exact nine-column schema remain rejected.
- Import button remains locked until navigation or failure.
- Import cannot submit twice.
- Laboratory rows link to Laboratory detail routes.
- Physical Exam rows link to Physical Exam detail routes.
- Clinic-specific routes reject appointments from the wrong service.
- Completed appointments can be corrected with a reason.
- Corrections without reasons fail.
- Corrections cannot destroy finalized or uploaded results.
- Correcting an empty pending-upload placeholder cleans it safely.
- Both-completed filtering returns matching students.
- Raw `PENDING_UPLOAD` is displayed as Pending.
- More filters no longer appears.
- Results no longer appears in the sidebar.
- `/results` redirects to `/appointments`.
- Capacity accepts only a maximum value.
- Scheduling can use capacity up to the maximum without a warning.
- Calendar clicks submit exactly one date.
- Failed calendar submissions restore the date cell.
- Existing unavailable date ranges appear correctly on the calendar.

## Delivery Order

0. Standard Windows CSV compatibility and executable plan amendments
1. Import loading and reusable asynchronous UI state
2. Clinic-specific detail routing
3. Audited completed-status corrections
4. Appointments filter simplification and regression repair
5. Results feature removal
6. Maximum-only capacity conversion
7. Interactive clinic calendar
8. Full test, lint, and production-build verification
