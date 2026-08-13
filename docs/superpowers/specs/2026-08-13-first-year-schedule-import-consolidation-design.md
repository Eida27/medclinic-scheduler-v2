# First Year Schedule Import Consolidation Design

**Date:** 2026-08-13  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design  
**Supersedes:** `docs/superpowers/specs/2026-08-12-first-year-ovpsa-priority-scheduling-design.md` for the user workflow, batch allocation, and publication flow

## Objective

Consolidate First Year OVPSA scheduling into the existing **Students & Schedules → Schedule Import** workflow so coordinators and administrators use one scheduling entry point for Regular, OJT, Tour, Specialized, and First Year students.

The dedicated **Administration → First Year OVPSA** tab and its manual draft/preview/validate/publish workflow will be retired. First Year remains a specialized scheduling mode behind the normal import interface because it has different business rules from ordinary preferred-month scheduling.

The new First Year workflow must:

- accept the normal student CSV;
- preserve original CSV row order;
- require all imported rows to be Year 1;
- let the user choose the authoritative First Year Laboratory date;
- schedule the Laboratory at Iloilo Mission Hospital;
- calculate the first Physical Examination candidate as exactly seven calendar days after the Laboratory date;
- automatically distribute students across as many valid Physical Examination dates as needed to respect CPU Clinic daily capacity;
- make every service date used by the First Year batch exclusive to First Year students for that service;
- displace eligible Regular, OJT, Tour, and Specialized appointments from those exclusive dates;
- skip dates containing protected/non-displaceable conflicts and continue searching forward;
- complete validation, planning, displacement, appointment creation, notification, audit, and publication automatically after one user confirmation;
- publish atomically so the import never leaves a partially scheduled First Year batch; and
- redirect to the existing `/students/schedule-imports/[importId]` result page after success.

## Approved User Experience

### Entry point

The only normal entry point for new First Year scheduling is:

`/students/schedule-imports/new`

The existing Schedule Import form remains the shared interface.

### Student category selector

The visible dropdown contains:

- Regular
- OJT
- Tour
- Specialized
- First Year

`First Year` is a UI scheduling selection, not a fifth permanent student-category value.

Internally, use an explicit import/scheduling mode such as:

- `STANDARD`
- `FIRST_YEAR_OVPSA`

The existing persistent student categories remain:

- `REGULAR`
- `OJT`
- `TOUR`
- `SPECIALIZED`

For a First Year import, scheduling behavior is controlled by `FIRST_YEAR_OVPSA` plus `year_level = 1`, rather than by introducing a `FIRST_YEAR` student category throughout the rule engine.

For newly created student records that require an underlying student category, use the existing normal/default category semantics rather than extending the category enum. The First Year priority behavior is carried by the import/batch mode and OVPSA lineage.

### Conditional fields

For Standard imports:

- keep the current CSV file field;
- keep Student category;
- keep Academic year;
- keep Preferred month for OJT, Tour, and Specialized;
- Regular continues without Preferred month as today.

For First Year imports:

- keep CSV file;
- show Student category = First Year;
- keep Academic year;
- hide Preferred month;
- show a required **Laboratory date** field;
- display Laboratory location as **Iloilo Mission Hospital**;
- do not ask the user to choose Physical Examination dates manually.

### Confirmation flow

The user should not create a draft, preview it, validate it, then publish it manually.

The visible flow is:

1. Select First Year.
2. Upload CSV.
3. Select academic year.
4. Select Laboratory date.
5. Click **Review import**.
6. System performs non-mutating input validation and prepares a scheduling summary.
7. Display one confirmation dialog.
8. User clicks **Agree and schedule**.
9. System performs the complete scheduling transaction automatically.
10. Redirect to `/students/schedule-imports/[importId]`.

The confirmation dialog should summarize at least:

- source filename;
- total Year 1 students;
- academic year;
- Laboratory date and Iloilo Mission Hospital location;
- first Physical Examination candidate date (`Laboratory + 7 days`);
- configured CPU Clinic PE daily capacity;
- estimated number of PE dates required;
- a clear warning that required dates will become First Year-exclusive and eligible conflicting appointments may be automatically rescheduled.

The confirmation is the user's publication approval. No second publish button is required.

## CSV Rules and Membership Ordering

The existing nine-column CSV structure remains authoritative:

`Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth`

All normal CSV validation continues to apply.

First Year mode adds these rules:

1. Every valid imported row must have `Year = 1`.
2. The original CSV row order must be preserved and become the allocation order.
3. Duplicate Student IDs remain invalid.
4. College and Course references must continue to resolve against active reference data.
5. The import may contain multiple colleges/courses if the ordinary academic import supports them; First Year allocation is still performed in original file order unless a future policy explicitly introduces college-separated batches.

### Source order persistence

Do not reconstruct First Year order later from surname, first name, student number, or database insertion order.

The system must persist the original CSV sequence before publication. The immutable First Year membership snapshot should contain at minimum:

- `student_number`;
- `source_row_number` or zero-based/one-based source order;
- academic snapshot reference;
- Year 1 snapshot data;
- assigned Physical Examination reservation/date after planning.

Once published, later student edits or a later CSV import must not reorder the historical First Year batch.

## First Year Scheduling Rules

### Laboratory

The user-selected Laboratory date is authoritative.

The First Year Laboratory:

- occurs at **Iloilo Mission Hospital**;
- applies to the complete First Year import batch on the selected date;
- does not use normal CPU/Kabalaka Laboratory daily-capacity consumption because the service is external;
- still creates the required First Year Laboratory appointments/lineage and service reservation needed by MedClinic;
- remains subject to date validity, academic-cycle validity, official closures, competing First Year reservations, and protected-conflict rules.

The selected Laboratory service date becomes exclusive to the First Year batch for the Laboratory scheduling service according to the already-approved hard-priority semantics.

### Physical Examination start date

The first Physical Examination candidate is:

`laboratory_date + 7 calendar days`

The user does not manually choose the first PE date.

If the +7 candidate is invalid, the scheduler searches forward for the first valid PE date. Invalid candidates include at least:

- weekend/non-service days according to current clinic rules;
- CPU Clinic unavailable/closed dates;
- official emergency/institutional closure dates;
- dates already owned by another active First Year reservation;
- dates containing protected conflicts that cannot be safely displaced;
- dates outside the allowed scheduling cycle/window.

Skipping an invalid candidate does not require another user confirmation during initial import.

### Capacity splitting

CPU Clinic Physical Examination maximum daily capacity is a per-date allocation limit, not a whole-batch publication blocker.

For `N` First Year students and PE capacity `C`, the scheduler allocates students in source CSV order across `ceil(N / C)` usable PE dates, subject to skipped invalid dates.

Example:

- Students: 280
- PE capacity: 150/day
- Laboratory: 2026-09-22
- First PE candidate: 2026-09-29

Expected allocation when Sep 29 and Sep 30 are valid:

- Sep 29: CSV positions 1–150 = 150 students
- Sep 30: CSV positions 151–280 = 130 students

The existing rule that blocks publication merely because `memberCount > cpuPhysicalExamMaximumCapacity` must be removed/replaced for First Year mode.

The planner instead blocks only when it cannot find enough valid exclusive PE dates within the permitted scheduling horizon/cycle to place the complete batch.

### Date search and protected conflicts

For each required PE date, the scheduler checks the candidate date before assigning students.

If the candidate contains only eligible movable Regular/OJT/Tour/Specialized appointments, the date may be selected and those conflicts are included in the displacement plan.

If the candidate contains a non-displaceable protected appointment, the entire date is skipped for First Year allocation and the scheduler continues to the next candidate date.

Protected cases include the existing protection semantics, such as:

- completed appointments;
- manually locked appointments;
- appointments protected by finalized/verified result activity;
- other appointment/result states already classified by the application as non-displaceable;
- another active First Year reservation.

The initial import should not enter manual-resolution mode merely because one candidate PE date is protected. It should continue searching forward.

## Exclusive Service-Date Ownership

Every date selected for First Year becomes service-exclusive to the owning First Year batch.

For example, if 280 students require Sep 29 and Sep 30 for Physical Examination:

- `PHYSICAL_EXAM + 2026-09-29` is owned by the First Year batch;
- `PHYSICAL_EXAM + 2026-09-30` is owned by the same First Year batch.

Normal Regular/OJT/Tour/Specialized schedule generation must treat those PE dates as unavailable for PE placement.

Likewise, the authoritative First Year Laboratory date remains the batch's exclusive Laboratory service date.

Service exclusivity is service-specific, not a global calendar closure. A First Year PE reservation must not automatically block unrelated Laboratory activity unless a separate Laboratory reservation exists for that date.

## Displacement and Replacement

### Eligible conflicts

First Year service reservations have hard priority over movable appointments belonging to:

- Regular
- OJT
- Tour
- Specialized

The scheduler may displace eligible appointments on every exclusive service date used by the First Year batch, including overflow PE dates.

### Replacement behavior

Displaced appointments must be automatically rescheduled using their original scheduling semantics and lineage.

Preserve at least:

- original category;
- accepted timestamp/FCFS lineage;
- original source row/order lineage where available;
- Laboratory-before-Physical-Examination invariant;
- category scheduling window and capacity rules;
- existing protection rules.

If a displaced student's Laboratory date is moved and its paired PE date would become invalid, move the pair as required.

If only PE conflicts, preserve the Laboratory appointment and move only PE when valid.

### Failure during replacement

The complete First Year operation is atomic. If the system selects a date whose movable conflicts cannot all be given valid replacements under the approved rules, that candidate date should be treated as unusable during planning when possible and the scheduler should continue searching for another First Year date.

If the scheduling horizon is exhausted and the full First Year batch plus required lower-priority replacements cannot be safely planned, the First Year import fails without partial publication.

## Atomic Automatic Publication

After **Agree and schedule**, perform the mutation in one authoritative transaction/locked operation.

Conceptual sequence:

1. Re-parse/re-validate authoritative request data.
2. Validate First Year mode and Laboratory date.
3. Resolve colleges/programs and upsert/import students.
4. Ensure Year 1 academic snapshots.
5. Persist First Year source ordering/membership snapshot.
6. Load current CPU PE capacity and blocked/service-reserved dates.
7. Calculate first PE candidate = Laboratory + 7 days.
8. Search forward and allocate the entire batch across valid PE dates.
9. Lock all required First Year reservation keys and affected appointment scopes.
10. Re-check closures, reservations, protection, and capacity inside the transaction.
11. Plan and apply eligible lower-priority displacements/replacements.
12. Create First Year service reservations for the Laboratory date and every PE allocation date.
13. Create First Year Laboratory and PE appointments with OVPSA/import lineage.
14. Create schedule-import child batch/result records needed by the normal import detail page.
15. Write notifications and audit events.
16. Mark the schedule import and First Year batch published.
17. Commit.

No user-visible intermediate Draft, Validated, or Generated action is required.

Internal states may remain if useful for transactional invariants/audit compatibility, but they must be advanced automatically within the operation and must not require user interaction.

If any required step fails, rollback the complete transaction.

## Persistence and Migration Direction

Reuse the existing First Year OVPSA persistence and displacement concepts where their semantics remain correct instead of rewriting them from scratch.

However, migration `019_first_year_ovpsa_priority_scheduling.sql` currently assumes one `physical_exam_date` and one active `PHYSICAL_EXAM` reservation per revision. The new design requires one First Year revision/batch to own multiple PE dates.

A follow-up migration should make the following conceptual changes.

### Schedule import metadata

Add explicit First Year import metadata to the schedule-import model, equivalent to:

- `import_mode` / `scheduling_mode` = `STANDARD | FIRST_YEAR_OVPSA`;
- `first_year_laboratory_date` when mode is First Year;
- optional link from schedule import to the resulting OVPSA First Year batch/revision.

Do not overload `preferred_month` to carry the Laboratory date.

### First Year revision

Represent the revision's calculated PE start separately from the set of actual allocated PE dates.

The current single `physical_exam_date` column may be renamed/reinterpreted as the first PE candidate/start date, or replaced with an explicit `physical_exam_start_date`. Actual selected PE dates belong in service reservations/allocation records.

Remove any database constraint that requires all First Year membership to fit one PE date.

### Service reservations

Allow one revision to own:

- exactly one active Laboratory reservation;
- one or more active Physical Examination reservations.

The current unique index that permits only one active reservation per `(revision_id, schedule_type)` must be replaced.

Required uniqueness should prevent:

- two active First Year owners for the same `(schedule_type, reservation_date)`;
- duplicate reservation of the same date by the same revision;
- more than one active Laboratory reservation for the revision.

Multiple active PE reservations for one revision are expected.

### Membership allocation

Extend First Year membership snapshots/allocation persistence with:

- source CSV order/row number;
- assigned PE service reservation/date;
- allocation sequence/position if useful for deterministic reporting.

Appointments should continue to carry First Year batch/revision/reservation lineage.

### Historical compatibility

Existing published single-date First Year data should remain readable. Prefer additive/compatible migration where practical.

Do not delete historical audit, reservation, or appointment lineage merely because the dedicated Administration UI is retired.

## Backend Architecture

### Shared schedule import coordinator

The main schedule-import entry point should route based on scheduling mode:

- `STANDARD` → existing Regular/OJT/Tour/Specialized import scheduler;
- `FIRST_YEAR_OVPSA` → First Year specialized planner/publication path.

The API should expose one submission contract from the user's perspective while keeping the specialized First Year domain logic isolated and testable.

### Reusable First Year modules

Retain/refactor existing modules where appropriate:

- First Year planner;
- First Year repository;
- First Year displacement logic;
- First Year lifecycle/reservation logic;
- external Laboratory verification logic;
- blocked-date integration.

Remove their dependency on a manual Administration draft lifecycle where that dependency no longer serves the new flow.

Do not fold all First Year logic directly into `schedule-imports.repository.ts`. The schedule-import service should orchestrate; specialized First Year planning/displacement should remain in focused units.

### Planning result

The First Year planner should return a deterministic plan containing at least:

- member count;
- ordered membership;
- Laboratory date/location;
- first PE candidate;
- selected PE allocation dates and per-date student counts;
- per-student assigned PE date/reservation sequence;
- skipped candidate dates and reasons;
- displacement candidates and replacement plans;
- blockers that prevent complete atomic publication;
- whether the complete batch can publish.

A batch larger than one day's PE capacity is not itself a blocker.

## Administration UI Retirement

Remove the **First Year OVPSA** item from the Administration navigation/sidebar.

Retire the dedicated normal workflow under:

- `/settings/first-year-ovpsa`
- `/settings/first-year-ovpsa/[batchId]`

Remove the dedicated First Year manager/editor components from active navigation and ordinary user operation.

For existing bookmarks, prefer redirecting the old settings pages to `/students/schedule-imports/new` rather than leaving users at a dead page during the transition.

Dedicated public API routes that exist only to support manual create-draft/validate/publish interactions should be removed or deprecated once no active UI depends on them. Domain services may remain internal and be called by the consolidated import transaction.

Historical First Year records remain accessible through normal schedule/import history or other existing audit/report views as applicable.

## Schedule Import Result Page

After successful First Year publication, redirect to:

`/students/schedule-imports/[importId]`

Do not create another First-Year-specific result page.

The normal detail page should render First Year-specific result sections when `import_mode = FIRST_YEAR_OVPSA`.

Display at least:

- status = Published;
- imported/scheduled student count;
- Laboratory date;
- Laboratory location = Iloilo Mission Hospital;
- first PE candidate date;
- every actual PE allocation date;
- student count versus capacity for each PE date;
- total displacement count;
- skipped dates with reason where relevant;
- published appointment count;
- audit/notification summary where currently supported.

Example:

```text
First Year Schedule Import
Published

Students
280 / 280 scheduled

Laboratory
Sep 22, 2026
Iloilo Mission Hospital
280 students

Physical Examination
Sep 29, 2026   150 / 150
Sep 30, 2026   130 / 150

Displaced appointments
24

Skipped dates
None
```

If Sep 30 is skipped because of a protected conflict and Oct 1 is unavailable, the page should show those skipped dates and the actual replacement PE date selected for the remaining students.

## External Laboratory Completion Rule

The previously approved external Laboratory verification behavior remains in force.

First Year Laboratory appointments occur at Iloilo Mission Hospital. CPU Clinic completion of the First Year Physical Examination must remain server-side blocked until the external Laboratory requirement/result has been verified/completed according to the existing First Year verification service.

The workflow consolidation must not weaken this compliance rule.

## Concurrency and Locking

One-click publication increases the importance of authoritative locking because there is no manual preview/publish delay for the user to resolve races.

The transaction must lock or otherwise protect:

- schedule-import queue/identity as appropriate;
- First Year batch/revision being created;
- Laboratory service reservation key;
- every planned PE service reservation key;
- affected appointment scopes;
- displacement candidates/replacement capacity scopes.

Database uniqueness remains authoritative for exclusive First Year ownership.

If concurrent activity invalidates the prepared confirmation summary, the server recomputes/rechecks inside the transaction. It must never publish stale conflicting dates merely because the user previously saw them in the confirmation dialog.

## Error Handling

### Before confirmation

Return field-level validation for errors the user can fix, including:

- malformed CSV;
- non-Year-1 row in First Year mode;
- invalid College/Course reference;
- missing Laboratory date;
- Laboratory date outside allowed cycle;
- invalid academic year.

Do not create a persistent published schedule when these fail.

### During automatic publication

Return a clear import failure if the authoritative planner cannot publish the complete batch, including cases such as:

- no CPU PE capacity configuration;
- no usable First Year PE dates remaining within the allowed scheduling horizon;
- all candidate dates blocked by protected conflicts/closures/other First Year owners;
- displacement replacements cannot be safely produced within allowed rules;
- concurrent reservation race;
- database/integrity failure.

The UI should explain that nothing was partially published because the operation was rolled back.

The error should not tell the user to manually create an OVPSA draft, validate it, or publish it, because that workflow no longer exists.

## Audit and Notifications

Retain First Year-specific audit lineage even though the user no longer clicks separate Draft/Validate/Publish actions.

At minimum record events equivalent to:

- First Year import accepted/confirmed;
- First Year batch automatically planned/published;
- First Year service dates reserved;
- First Year PE allocation dates/counts;
- lower-priority displacement applied;
- replacement appointments created;
- external Laboratory result verified;
- later emergency/cancellation/reschedule actions if those lifecycle features remain supported.

Audit metadata should include the schedule import ID, batch/revision, actor, academic cycle, Laboratory date, all PE dates/counts, source filename, displaced appointments/categories, and skipped candidate dates/reasons.

Displaced Regular/OJT/Tour/Specialized students should receive existing-style schedule-change notifications containing old and replacement dates.

First Year students should receive their Laboratory location/date and their individually assigned PE date.

## Testing Requirements

### Schedule import form tests

Verify:

1. Dropdown shows Regular, OJT, Tour, Specialized, and First Year.
2. First Year shows Laboratory date and hides Preferred month.
3. Standard category behavior remains unchanged.
4. First Year requires Laboratory date.
5. Confirmation copy identifies First Year behavior and automatic publication.
6. Confirm submits exactly once and prevents duplicate requests while pending.
7. Success redirects to `/students/schedule-imports/[importId]`.

### CSV/API validation tests

Verify:

1. First Year accepts a valid nine-column Year 1 CSV.
2. Any non-Year-1 row rejects First Year import with row-level error.
3. Original CSV order is preserved.
4. Existing duplicate Student ID/reference-data rules remain intact.

### Planner/domain tests

Verify:

1. 280 students with 150/day produces two PE allocations: 150 + 130.
2. Batch size greater than one-day capacity is not a publication blocker.
3. Student allocation follows exact CSV order.
4. First PE candidate is Laboratory + 7 calendar days.
5. Weekend/unavailable candidates are skipped.
6. Protected-conflict dates are skipped rather than forcing manual resolution.
7. Dates with only movable lower-priority conflicts may be selected and displaced.
8. Every selected PE date becomes an exclusive First Year service reservation.
9. Another First Year reservation prevents reuse of that service/date.
10. Search stops with a clear blocker only when the allowed horizon cannot fit the complete batch.

### Displacement tests

Verify:

1. Regular appointments can be displaced.
2. OJT appointments can be displaced.
3. Tour appointments can be displaced.
4. Specialized appointments can be displaced.
5. Protected appointments are never displaced.
6. A PE overflow date applies the same displacement rules as the first PE date.
7. Pair invariants are preserved for displaced students.
8. Replacement scheduling preserves category and FCFS lineage.

### Transaction/integration tests

Verify:

1. Successful confirmation imports students, creates reservations, allocates all First Year appointments, applies displacements, writes notifications/audit, and publishes one atomic result.
2. Failure after planning but before commit rolls back all First Year appointments/reservations/displacements.
3. Concurrent attempts cannot own the same service/date.
4. Revalidation inside the transaction catches stale confirmation data.
5. Existing Standard imports still publish correctly.

### Result-page tests

Verify:

1. First Year import shows Laboratory date/location.
2. Multiple PE dates render with per-date counts/capacity.
3. Displacement total is visible.
4. Skipped dates/reasons render when present.
5. Normal Standard import detail rendering is unchanged.

### Navigation/retirement tests

Verify:

1. Administration no longer shows First Year OVPSA.
2. Old First Year settings URLs redirect to the new schedule-import entry point during transition.
3. No user-facing page still requires manual Create Draft → Preview → Validate → Publish.

### Compliance tests

Verify First Year PE completion is still rejected server-side until the external Iloilo Mission Hospital Laboratory requirement is verified/completed.

## Acceptance Scenario

Given:

- Academic year: 2026–2027
- Import mode: First Year
- CSV: 280 valid Year 1 students
- Laboratory date: 2026-09-22
- CPU Clinic PE maximum capacity: 150/day
- Sep 29 valid
- Sep 30 valid and containing only movable lower-priority appointments

When the coordinator clicks **Agree and schedule**,

then the expected published result is:

- 280 Laboratory appointments associated with 2026-09-22 at Iloilo Mission Hospital;
- Laboratory service reservation for 2026-09-22;
- 150 PE appointments on 2026-09-29 for the first 150 students in CSV order;
- 130 PE appointments on 2026-09-30 for the remaining students in CSV order;
- exclusive PE service reservations for Sep 29 and Sep 30;
- eligible conflicting Regular/OJT/Tour/Specialized appointments on those reserved dates rescheduled automatically;
- all required notifications/audit records created;
- one published Schedule Import result;
- redirect to `/students/schedule-imports/[importId]`;
- no manual draft/preview/validate/publish steps.

If Sep 30 contains a protected non-displaceable conflict, Sep 30 is skipped and the remaining 130 students are assigned to the next valid exclusive PE date instead.

## Out of Scope for This Revision

This revision does not introduce:

- a fifth persistent `FIRST_YEAR` student category;
- manual student-by-student First Year allocation;
- user-selected PE dates during initial import;
- silent over-capacity scheduling on a PE date;
- partial publication of a First Year import;
- changes to the nine-column CSV format;
- changes to the rule that First Year external Laboratory must be verified before PE completion.

Future emergency rescheduling/cancellation can continue to use the existing First Year lifecycle concepts, but the initial scheduling entry point remains the consolidated Schedule Import workflow.
