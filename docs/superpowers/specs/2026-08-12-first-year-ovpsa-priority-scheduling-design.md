# First Year OVPSA Priority Scheduling Design

**Date:** 2026-08-12  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Scope:** First Year OVPSA-controlled Laboratory and Physical Examination scheduling

## Objective

Extend MedClinic so First Year college students can follow the schedule issued by the Office of the Vice President for Student Affairs (OVPSA) while preserving the existing FCFS and priority-window scheduling rules for Regular, OJT, Tour, and Specialized students.

First Year scheduling is a hard-priority, administrator-controlled reservation workflow. It is not a normal preferred-month import category. The system identifies eligible First Year students from imported academic data, groups them by college, accepts the OVPSA Laboratory date from an administrator, reserves the affected service dates exclusively for that college batch, and displaces eligible lower-priority appointments when necessary.

The First Year Laboratory is conducted at Iloilo Mission Hospital. The corresponding Physical Examination is conducted at CPU Clinic, normally seven calendar days after the Laboratory date.

## Approved Business Rules

### Priority hierarchy

Scheduling precedence is:

1. Official emergency, government, institutional, or clinic closure rules
2. Published First Year OVPSA reservation
3. OJT, Tour, and Specialized priority scheduling
4. Regular FCFS scheduling

A First Year OVPSA reservation may displace eligible Regular, OJT, Tour, and Specialized appointments. A published First Year OVPSA reservation cannot be displaced by those categories.

### First Year is a scheduling mode, not a fifth import category

The existing student-category dimension remains:

- `REGULAR`
- `OJT`
- `TOUR`
- `SPECIALIZED`

First Year OVPSA handling is a separate scheduling mode derived from academic year level and an explicit OVPSA batch reservation. This avoids forcing First Year students through the existing preferred-month rules and keeps historical student-category semantics intact.

A student is eligible for a First Year OVPSA batch when the student's effective academic record for the selected scheduling cycle has `year_level = 1` and the student belongs to the selected college.

## Batch Membership

### College-based assignment

Each OVPSA batch belongs to exactly one college for one academic scheduling cycle.

The administrator selects:

1. Academic year / scheduling cycle
2. College
3. OVPSA Laboratory date

The system resolves all eligible Year 1 students in that college for the selected cycle and presents them as the batch membership preview.

Manual student-by-student construction is not the normal workflow. If future policy requires exceptions, that should be designed separately rather than hidden inside the initial implementation.

### Membership stability

The batch preview uses current student academic data before publication. On publication, the system must persist an immutable membership snapshot so later changes to a student's college or year level do not silently rewrite historical OVPSA batches.

A student may belong to at most one active published First Year OVPSA batch for the same scheduling cycle.

## OVPSA Reservation Model

A dedicated First Year OVPSA reservation model is required. Generic `clinic_unavailable_dates` must not be overloaded for this purpose because an unavailable date means the service is closed, while an OVPSA reservation means the service remains open but is exclusively allocated to a particular First Year college batch.

### Suggested persistence model

Introduce an `ovpsa_first_year_batches` table with fields equivalent to:

- `id`
- `schedule_cycle_start`
- `college_id`
- `laboratory_date`
- `physical_exam_date`
- `laboratory_location` with initial value `ILOILO_MISSION_HOSPITAL`
- `status` such as `DRAFT`, `PUBLISHED`, `RESCHEDULED`, `CANCELLED`
- `created_by`
- `published_by`
- `created_at`
- `updated_at`
- optional `rescheduled_from_batch_id` or revision linkage

Introduce a membership table such as `ovpsa_first_year_batch_students` containing:

- `batch_id`
- `student_number`
- immutable college/year snapshot fields needed for audit

Introduce service-date reservation records, or enforce equivalent uniqueness directly from the batch table, so the database prevents two active First Year batches from owning the same Laboratory date or the same Physical Examination date.

The reservation key is service-specific:

- one active First Year owner per `LABORATORY + date`
- one active First Year owner per `PHYSICAL_EXAM + date`

A Laboratory reservation does not block the Physical Examination calendar on the same date, and a Physical Examination reservation does not block the Laboratory calendar on the same date.

## Service-Specific Exclusivity

If a First Year college batch has:

- Laboratory: 2026-09-09
- Physical Examination: 2026-09-16

then:

- 2026-09-09 Laboratory calendar is exclusive to that First Year batch.
- Other students may still attend CPU Physical Examinations on 2026-09-09.
- 2026-09-16 Physical Examination calendar is exclusive to that First Year batch.
- Other students may still have Laboratory activity on 2026-09-16.

Normal schedule generation must treat an active First Year service-date reservation as unavailable to Regular, OJT, Tour, and Specialized scheduling for that service only.

## Laboratory Location and Capacity

The First Year Laboratory is conducted at Iloilo Mission Hospital, not at the ordinary MedClinic/Kabalaka Laboratory service location.

The system must display the external location clearly on First Year Laboratory appointments and student-facing schedules.

The OVPSA Laboratory date is authoritative and is not selected by the existing Laboratory capacity search algorithm. Normal Kabalaka Laboratory capacity is therefore not consumed by First Year external Laboratory appointments.

The CPU Physical Examination remains subject to CPU Clinic operational capacity. If the number of students in the college batch exceeds the configured CPU Physical Examination maximum for the reserved date, publication must fail with a clear capacity error rather than silently exceeding the configured limit.

The initial design does not automatically split one college batch across several Physical Examination dates. The administrator must resolve an over-capacity batch using an approved OVPSA/clinic scheduling decision before publication.

## Physical Examination Date Rule

The default First Year Physical Examination date is:

`physical_exam_date = laboratory_date + 7 calendar days`

This is intentionally different from the ordinary paired scheduler, which searches for the earliest eligible Physical Examination date after Laboratory.

During draft creation or editing, the system calculates and previews the +7 date automatically.

If the calculated date is a weekend, clinic closure, emergency closure, government-declared non-working day, or otherwise unavailable CPU Clinic date, publication must not silently choose another date. The system reports the conflict and requires an administrator-approved replacement Physical Examination date.

An approved exception date may be more than seven days after Laboratory. The reason for the exception must be auditable.

## Displacement Rules

### Eligible categories

A published First Year reservation may displace active eligible appointments belonging to:

- Regular
- OJT
- Tour
- Specialized

The displaced student's original category, accepted timestamp, FCFS position, and priority semantics must be preserved during replacement scheduling.

### Protected appointments

First Year publication must not automatically displace appointments that are:

- completed
- manually locked
- protected by finalized or verified result data
- protected by active draft result files according to existing result-protection rules
- already part of another active First Year OVPSA reservation
- otherwise classified by existing calendar logic as requiring manual resolution

When a protected conflict exists, publication must stop and present an administrator-resolvable conflict instead of partially publishing the First Year batch.

### Laboratory-date displacement

When a lower-priority student's Laboratory appointment conflicts with the First Year Laboratory reservation, the system must preserve the Laboratory-before-Physical-Examination invariant.

If moving the Laboratory would invalidate the existing paired Physical Examination date, the affected pair must be rescheduled together.

Example:

- Old Laboratory: Sep 9
- Old Physical Examination: Sep 11
- First Year takes Laboratory Sep 9
- Replacement Laboratory: next eligible date
- Replacement Physical Examination: next eligible valid date after the replacement Laboratory

The replacement process must use the displaced student's original category and normal scheduling constraints.

### Physical-Exam-date displacement

When only the lower-priority student's Physical Examination conflicts with the First Year Physical Examination reservation, an already valid Laboratory appointment remains unchanged and only the Physical Examination is moved to the next eligible date that preserves Laboratory-before-Physical-Examination ordering.

### Atomicity

Publishing a First Year batch, reserving both service dates, displacing conflicting appointments, creating replacements, writing audit records, and creating notifications must occur atomically.

If all required safe replacements cannot be produced, the transaction must fail without leaving a partially published OVPSA reservation.

## External Laboratory Verification Workflow

CPU Clinic cannot directly observe completion of the First Year Laboratory because it occurs at Iloilo Mission Hospital.

The workflow is:

1. Student attends the OVPSA Laboratory appointment at Iloilo Mission Hospital.
2. Student obtains the Laboratory result from Iloilo Mission Hospital.
3. Student presents the result to CPU Clinic.
4. Authorized CPU Clinic staff verifies the external result.
5. Laboratory requirement becomes `COMPLETED`.
6. Physical Examination completion becomes permitted.

The Laboratory must not automatically become completed merely because the Physical Examination was completed.

### First Year Laboratory display state

Before verification, the appointment may remain operationally `PENDING`, but First Year UI should display a more specific derived state such as `Awaiting External Laboratory Result` so users understand why CPU Clinic has not marked it complete.

Avoid adding a new appointment status unless implementation proves a derived display state insufficient. Existing status transitions and reporting should remain stable where possible.

### Verification evidence

The verification action records at minimum:

- appointment/student
- external provider: Iloilo Mission Hospital
- verified by
- verified at
- optional remarks

A digital scan/upload is optional for the initial design. Verification must not depend on an uploaded file unless clinic policy later requires it.

### Physical Examination completion guard

For First Year students, the server must reject completion of the Physical Examination unless the associated external Laboratory requirement is verified/completed.

The guard must be enforced server-side, not only by disabling the UI control.

## Emergency and Official Closure Handling

First Year reservation dates are protected from ordinary scheduling displacement, but they are not immutable against legitimate emergency or official closure events.

Valid overriding causes include:

- strong typhoon or severe-weather suspension
- emergency clinic or campus closure
- government-declared holiday or suspension
- official institutional schedule revision
- another comparable administrator-recorded exceptional event

### Emergency affects Laboratory date

When the First Year Laboratory date becomes unavailable:

1. Administrator initiates or confirms an OVPSA batch reschedule.
2. System suggests the next valid date where useful, but does not unilaterally finalize an external Mission Hospital date.
3. Administrator approves the new Laboratory date.
4. Physical Examination default is recalculated as new Laboratory date + 7 calendar days.
5. The new Laboratory and Physical Examination dates are validated for exclusivity, closure conflicts, protected appointments, and Physical Examination capacity.
6. New service reservations replace the old reservations atomically.
7. Affected lower-priority appointments are displaced/rescheduled under the same rules as initial publication.

### Emergency affects Physical Examination only

If Laboratory has already occurred or remains valid and only the Physical Examination date becomes unavailable:

- Laboratory date and completion remain unchanged.
- Administrator approves the next valid CPU Physical Examination date.
- The new Physical Examination date becomes service-exclusive for the First Year batch.
- The +7 rule becomes an auditable exception rather than forcing Laboratory to move.

### Released reservation restoration

When an old First Year reservation is released, the system may attempt to restore students previously displaced specifically because of that reservation when all of the following remain true:

- the old service date is usable
- no newer protected reservation owns the slot
- restoration preserves pairing/order constraints
- the student's current replacement has not become protected by completion, manual lock, or result activity

Restoration is best-effort, not guaranteed. If safe restoration is impossible, the student's current replacement remains in effect.

Every restoration or non-restoration outcome must be auditable.

## Administrator Workflow

Add a dedicated First Year OVPSA scheduling workflow rather than embedding the feature inside the ordinary CSV import metadata form.

Recommended flow:

1. Open First Year OVPSA Scheduling.
2. Select academic year / scheduling cycle.
3. Select college.
4. System loads eligible Year 1 students for that college.
5. Enter OVPSA Laboratory date.
6. System displays Iloilo Mission Hospital as Laboratory location.
7. System calculates the default Physical Examination date (+7 days).
8. Preview batch size, CPU Physical Examination capacity, service-date conflicts, protected conflicts, and appointments that would be displaced.
9. Validate.
10. Publish atomically.

The preview must make displacement effects visible before publication, including category, old dates, proposed replacement dates, and any cases requiring manual resolution.

## Student-Facing Behavior

First Year students should see:

- Laboratory date
- `Iloilo Mission Hospital` as Laboratory location
- Physical Examination date at CPU Clinic
- clear Laboratory state such as `Awaiting External Laboratory Result` before verification
- reschedule notifications when an official emergency changes either date

Displaced Regular/OJT/Tour/Specialized students receive existing-style schedule-change notifications that clearly state their old and replacement dates.

## Integration With Existing Scheduling

### Ordinary schedule generation

The paired schedule generator and replacement schedulers must receive First Year service reservations as blocked dates for the matching service.

Do not represent First Year reservation dates as global blocked dates because that would incorrectly block the other service calendar.

### Existing priority displacement

Current priority displacement logic is Regular-specific. Introduce an OVPSA-specific displacement path that can select eligible appointments from all four lower categories while reusing existing protection, locking, replacement, notification, and audit concepts where possible.

Avoid weakening the existing OJT/Tour/Specialized-over-Regular displacement rule.

### Clinic calendar closure system

The existing clinic calendar remains authoritative for true service closures. A closure can invalidate a First Year reservation and initiate an OVPSA reschedule workflow.

OVPSA reservations must not masquerade as closures.

## Concurrency and Locking

Publication and rescheduling must lock:

- the OVPSA batch
- the service-date reservation keys
- affected appointment scopes
- candidate displacement appointments

The implementation must prevent two administrators from simultaneously publishing competing First Year batches for the same service/date.

Use database uniqueness plus transactional row/advisory locking as appropriate; UI preflight alone is insufficient.

## Audit Requirements

Add explicit audit events equivalent to:

- `OVPSA_FIRST_YEAR_BATCH_CREATED`
- `OVPSA_FIRST_YEAR_BATCH_VALIDATED`
- `OVPSA_FIRST_YEAR_BATCH_PUBLISHED`
- `OVPSA_FIRST_YEAR_BATCH_RESCHEDULED`
- `OVPSA_FIRST_YEAR_BATCH_CANCELLED`
- `OVPSA_FIRST_YEAR_LAB_RESULT_VERIFIED`
- `OVPSA_DISPLACEMENT_APPLIED`
- `OVPSA_DISPLACEMENT_RESTORED`

Audit metadata should include batch, academic cycle, college, old/new dates where applicable, affected appointment IDs, displaced student categories, actor, and exception reason.

## Error Handling

The server should expose specific conflict errors for at least:

- selected college has no eligible Year 1 students
- student already belongs to another active First Year batch in the cycle
- Laboratory service date already belongs to another First Year batch
- Physical Examination service date already belongs to another First Year batch
- CPU Physical Examination capacity is insufficient
- selected date is closed/unavailable
- protected appointment prevents automatic displacement
- replacement capacity is exhausted
- Physical Examination completion attempted before Laboratory verification
- concurrent/stale batch update

Validation must be repeatable and publication must re-check authoritative database state inside the transaction.

## Database Migration Direction

A migration is expected to add:

1. First Year OVPSA batch table
2. First Year batch membership snapshot table
3. service-specific active reservation uniqueness/lookup support
4. external Laboratory verification metadata if existing result tables cannot represent the requirement cleanly
5. audit/reschedule linkage fields or event causes needed to distinguish OVPSA displacement from ordinary priority displacement and clinic closure

Prefer additive schema changes. Do not rewrite existing historical schedule categories.

## Expected Server Components

Implementation will likely introduce or extend units equivalent to:

- `ovpsa-first-year-batches.repository.ts`
- `ovpsa-first-year-batches.service.ts`
- `ovpsa-first-year-planner.ts`
- OVPSA-specific displacement/replacement helpers
- appointment completion guard for First Year Physical Examinations
- external Laboratory verification repository/service action
- normal scheduling blocked-date loaders to include service-specific OVPSA reservations

Existing `priority-displacement`, `clinic-calendar`, `appointments`, academic snapshot, notification, and audit layers should be reused where their semantics match.

Do not grow one existing service into a single oversized First Year implementation file; keep batch lifecycle, planning, displacement, and verification responsibilities independently testable.

## UI Direction

Add an administrator-only First Year OVPSA scheduling page or section with:

- academic year selector
- college selector
- eligible student count/list preview
- Laboratory date input
- fixed location label: Iloilo Mission Hospital
- calculated Physical Examination date
- CPU PE capacity indicator
- conflict/displacement preview
- publish action
- published batch history/status
- emergency reschedule action

The ordinary schedule import form remains focused on Regular/OJT/Tour/Specialized imports and should not gain a misleading `FIRST_YEAR` category option.

## Testing Requirements

### Domain and planner tests

Verify:

1. Year 1 + selected college determines batch membership.
2. Other year levels and colleges are excluded.
3. Default PE date is exactly Laboratory + 7 calendar days.
4. service exclusivity blocks only the matching service.
5. First Year reservations rank above all four ordinary categories.
6. First Year cannot displace another active First Year reservation.
7. CPU PE capacity is enforced.

### Displacement tests

Verify:

1. Regular conflicting Laboratory pair can be displaced and replaced.
2. OJT conflicting Laboratory pair can be displaced and retains OJT category semantics.
3. Tour and Specialized follow the same preservation rule.
4. Laboratory displacement never leaves PE before the replacement Laboratory.
5. PE-only conflict moves only PE when Laboratory remains valid.
6. completed, manually locked, draft-result-protected, and finalized-result-protected appointments are not auto-displaced.
7. publication rolls back when any required replacement cannot be produced.

### Reservation tests

Verify:

1. Sep 9 Laboratory reservation does not block Sep 9 Physical Examination scheduling.
2. Sep 16 Physical Examination reservation does not block Sep 16 Laboratory scheduling.
3. a lower-category schedule cannot later consume either reserved service/date.
4. concurrent publication cannot create duplicate service/date ownership.

### External result tests

Verify:

1. First Year Laboratory remains pending/awaiting verification before CPU verification.
2. verification records provider, actor, and timestamp.
3. Physical Examination completion is rejected before Laboratory verification.
4. Physical Examination completion succeeds after Laboratory verification.
5. completing PE does not itself create a false Laboratory completion event.

### Emergency reschedule tests

Verify:

1. official closure may supersede a First Year reservation.
2. moving Laboratory recalculates default PE to +7 days.
3. moving PE only does not rewrite completed Laboratory.
4. old service reservations are released atomically with new reservations.
5. newly conflicting lower-priority appointments are safely displaced.
6. eligible prior displacements can be restored when safe.
7. protected/current replacements are not forcibly restored.
8. all changes generate audit history and notifications.

### UI and acceptance tests

Verify:

1. admin can choose academic year and college.
2. only Year 1 students from that college appear.
3. Mission Hospital location is visible and not editable as a normal clinic selection.
4. +7 PE date preview updates when Laboratory date changes.
5. capacity/conflict preview is visible before publish.
6. protected conflicts block publication with actionable messaging.
7. student portal shows correct locations and dates.
8. emergency reschedule updates student-facing schedules and notifications.

## Out of Scope

- Changing the nine-column student CSV format
- Adding `FIRST_YEAR` to the existing Regular/OJT/Tour/Specialized import-category enum
- Automatically importing OVPSA schedules from an external OVPSA system
- Automatically determining whether a student completed Mission Hospital Laboratory without CPU verification
- Automatically uploading/scanning Mission Hospital documents
- Allowing one initial OVPSA batch to represent multiple colleges
- Automatically splitting an over-capacity college batch across multiple PE dates
- Making an OVPSA reservation a global clinic closure
- Removing existing FCFS or OJT/Tour/Specialized priority behavior

## Acceptance Criteria

The feature is complete when:

- Admin can create a First Year OVPSA batch by academic cycle and college.
- Batch membership consists of eligible Year 1 students from that college and is snapshotted on publication.
- Admin supplies the OVPSA Laboratory date; Laboratory location is Iloilo Mission Hospital.
- The default Physical Examination date is Laboratory + 7 calendar days.
- The Laboratory reservation is exclusive only to the Laboratory calendar for that date.
- The Physical Examination reservation is exclusive only to the PE calendar for that date.
- CPU Physical Examination capacity remains enforced.
- Publishing may safely displace eligible Regular, OJT, Tour, and Specialized appointments while preserving their categories and Lab-before-PE ordering.
- Completed, locked, result-protected, or other First Year reservations are never silently displaced.
- Publication is atomic and fails cleanly if protected conflicts or replacement-capacity failures remain.
- First Year Laboratory completion is recorded only after CPU verifies the Iloilo Mission Hospital result.
- First Year PE cannot be completed before Laboratory verification.
- Emergency/official closures may supersede First Year reservations through an administrator-controlled reschedule flow.
- Old reservations are released and safe restoration of previously displaced appointments is attempted where valid.
- All reservation, displacement, verification, emergency-reschedule, and restoration actions are auditable and notify affected students where appropriate.
- Existing Regular/OJT/Tour/Specialized import and scheduling behavior remains backward compatible.
