# Basic Education Kinder–Grade 12 Scheduling Design

**Date:** 2026-07-28  
**Status:** Approved design

## 1. Goal

Add a separate Basic Education scheduling workflow for Kinder through Grade 12 while preserving the existing college scheduling workflow and shared clinic operations.

Confirmed service rules:

| Grade range | Laboratory | Physical Examination |
| --- | --- | --- |
| Kinder–Grade 6 | Not required | Required |
| Grade 7–Grade 12 | Required | Required |

Kinder–Grade 6 must not receive Laboratory schedule items, appointments, results, upload drafts, or hidden placeholders. User-facing views may derive **Laboratory: Not required**.

## 2. Approved architecture

Use one permanent student identity with separate academic-year enrollment and scheduling domains.

Shared infrastructure remains responsible for student authentication, clinics, capacity, appointments, attendance, closures, results, private submissions, notifications, and audits.

College and Basic Education retain separate import services and scheduling rules. Basic Education receives its own CSV, reference configuration, import history, cohort builder, and cohort scheduler.

## 3. Academic data model

### 3.1 Permanent identity

The `students` table keeps identity and portal fields: Student ID, name, date of birth, email, verification, and active status. Academic placement is removed from permanent identity after migration.

### 3.2 Academic-year registry

Add a parent record such as:

```text
student_academic_years
- id
- student_number
- academic_year_start
- population_type: COLLEGE | BASIC_EDUCATION
- enrollment_status: ACTIVE | WITHDRAWN | INACTIVE
```

Enforce `UNIQUE(student_number, academic_year_start)`. This prevents one student from having college and Basic Education enrollment in the same academic year and gives schedules a stable historical academic context.

### 3.3 College enrollments

```text
college_enrollments
- academic_year_record_id
- college_id
- program_id
- year_level
```

Future college imports update the selected academic year's enrollment instead of overwriting permanent student fields.

### 3.4 Protected grade levels

Seed fixed, non-editable grade records in this order:

`Kinder → Grade 1 → Grade 2 → … → Grade 12`

Each grade stores protected scheduling order and service requirements. Kinder–Grade 6 require Physical Examination only; Grade 7–Grade 12 require both services. Administrators cannot rename, reorder, disable, or change these rules.

### 3.5 Strands and yearly activation

Maintain a global editable strand catalog initially seeded as:

1. STEM
2. ABM
3. HUMSS
4. GAS
5. TVL

Each Basic Education academic year separately selects active strands and their scheduling order.

### 3.6 Academic-year sections

Sections belong to:

```text
Academic year + Grade + optional Senior High strand
```

Kinder–Grade 10 sections must not have a strand. Grade 11–12 sections must reference an active strand for the same academic year.

Section names and scheduling order are unique inside their exact year, grade, and strand scope. Initial placeholders are Section A through Section E. Stable IDs allow later renaming without breaking enrollments or schedules.

### 3.7 Basic Education enrollment

```text
basic_education_enrollments
- academic_year_record_id
- grade_level_id
- academic_year_strand_id nullable
- section_id
- is_late_addition
```

Database validation enforces the exact year, grade, strand, and section relationship.

## 4. Academic-year configuration

Administrators manage a dedicated Basic Education configuration under Reference Data.

For each academic year they can:

- create a draft configuration;
- activate or deactivate Senior High strands;
- set strand scheduling order;
- rename, add, disable, and order sections;
- activate the configuration for imports.

Creating a new year copies the previous year's active strands, strand order, sections, and section order into independent records. The first configured year uses STEM, ABM, HUMSS, GAS, TVL and Section A–E defaults.

Published cohorts store explicit membership and scheduling-order snapshots, so later reference edits never rebuild existing schedules. Disabling a referenced strand or section is rejected until dependencies are resolved.

## 5. Separate Basic Education import

Under **Students & Schedules**, provide separate entry points for:

- College Scheduling
- Basic Education Scheduling

Each has its own import page, template, history, detail page, and validation.

The Basic Education coordinator selects only:

- one complete Kinder–Grade 12 CSV;
- academic year.

No grade, strand, or section dropdown is required on the import page.

### 5.1 CSV format

```csv
Student ID,Surname,First Name,MI,Suffix,Grade Level,Strand,Section,Date of Birth
```

Rules:

- exact headers;
- Student ID uses `NN-NNNN-NN`;
- Date of Birth uses valid `MM-DD-YYYY`;
- Grade Level is Kinder or Grade 1–12;
- Strand is blank for Kinder–Grade 10;
- Strand is required for Grade 11–12;
- Section is required for every student;
- strand and section must match active references for the selected year;
- Student IDs are unique within the file;
- CSV row order never controls scheduling.

Unknown strands or sections are never created automatically. One invalid row rejects the complete import.

### 5.2 Review and publish

`Review import` performs a non-persistent server preflight and shows filename, academic year, accepted count, grade range, section count, Physical-only count, paired count, earliest scheduling boundary, and the all-or-nothing warning.

`Agree and import` resubmits and fully revalidates the file. It acquires the scheduling lock, plans the complete roster, and publishes atomically. The button is disabled with a visible pending state.

## 6. Cohort construction

The original complete roster is ordered by:

1. grade scheduling order;
2. strand scheduling order for Grades 11–12;
3. section scheduling order;
4. subgroup order;
5. surname;
6. first name;
7. Student ID.

Students are grouped as:

- Kinder–Grade 10: academic year + grade + section;
- Grade 11–12: academic year + grade + strand + section.

Formal cohort and cohort-member records preserve exact membership for closures, restoration, corrections, and audits.

## 7. Keeping sections together

A complete section uses the current day's remaining capacity only when the entire section fits. Otherwise the section moves intact to the next eligible date.

Later sections cannot skip ahead to consume leftover capacity. The algorithm is ordered first-fit, not capacity-maximizing bin packing.

A section is split only when it exceeds full-day capacity.

- Kinder–Grade 6 subgroup size uses CPU Physical Examination capacity.
- Grade 7–12 subgroup size uses the smaller of KABALAKA Laboratory and CPU Physical Examination capacity.

Students are split alphabetically. The same subgroup remains together for both services. Each subgroup is independently scheduled in order; Subgroup 2 cannot precede Subgroup 1.

## 8. Scheduling window and horizon

The earliest first appointment is the later of:

- the first schedulable weekday in August of the selected academic year;
- seven Manila calendar days after import acceptance.

The seven days are preparation notice before the first appointment, not a Laboratory-to-Physical gap.

Preferred window: August through March. Overflow may continue through July 31 of the same academic cycle. Scheduling never crosses into the next academic year. If any cohort cannot fit by July 31, the complete import rolls back.

## 9. Service-specific parallel queues

### 9.1 CPU Physical Examination queue

Strict order:

`Kinder → Grade 1 → … → Grade 12`

Within a grade, use strand, section, and subgroup order. A higher-grade cohort cannot pass an unfinished lower-grade cohort, even when CPU capacity is temporarily unused.

### 9.2 KABALAKA Laboratory queue

Strict order:

`Grade 7 → Grade 8 → … → Grade 12`

This queue can progress while CPU Clinic is still scheduling younger grades.

### 9.3 Grade 7–12 pairing

Laboratory is allocated first. Physical Examination searching starts on the calendar day after Laboratory and skips weekends, unified closure dates, insufficient-capacity dates, and dates blocked by the strict earlier CPU cohort.

Both dates are planned and published together. Physical Examination is date-dependent on Laboratory, not attendance-completion-dependent.

## 10. Shared capacity and college protection

Before planning, count all effective college and Basic Education appointments against shared clinic capacity.

Basic Education scheduling:

- uses only remaining capacity;
- never displaces college appointments;
- leaves existing College Regular, OJT, Tour, and Specialized rules unchanged;
- respects the unified clinic closure calendar.

All capacity-changing imports, corrections, late additions, closures, and restorations use the existing global PostgreSQL scheduling advisory transaction lock.

## 11. Atomic publishing

The Basic Education service first builds a complete deterministic allocation plan. It publishes only when every cohort can be placed by July 31.

Inside one transaction:

1. validate CSV and references;
2. acquire immutable acceptance time and scheduling lock;
3. upsert permanent identities;
4. create or update yearly enrollments;
5. construct cohorts and subgroups;
6. read shared load and closures;
7. plan all required dates;
8. reject any unallocated cohort;
9. persist import, cohorts, members, schedule batches, items, appointments, notifications, and audits;
10. commit.

A failure leaves no partial records.

## 12. Corrected re-imports

Only students present in the new CSV are updated. Missing students remain enrolled and scheduled.

### Unchanged placement

Correct identity fields while preserving enrollment, cohort membership, and valid appointments.

### Changed grade, strand, or section

- update the yearly enrollment;
- mark previous cohort membership superseded;
- reschedule only the affected student;
- use the correct cohort's existing dates when every required service has capacity;
- otherwise create a dedicated correction cohort at the earliest safe dates;
- leave other students unchanged;
- audit and notify date changes.

Completed, manually locked, or result-protected appointments block automatic correction and roll back the correction.

### Late additions

New students added after original publication are marked late additions. They never displace college or already published Basic Education schedules. They may join the correct cohort's dates when all required capacity exists; otherwise they receive a dedicated late-addition cohort.

### Withdrawal

Withdrawal is a separate administrator action. Future pending appointments may be cancelled or deactivated while historical completed, no-show, locked, or result-protected records are preserved.

## 13. Clinic operations

Laboratory shows college students and Basic Education Grades 7–12.

Physical Examination shows college students and Basic Education Kinder–Grade 12.

Add server-backed filters for population, academic year, grade, strand, section, date, and attendance status.

Basic Education rows show cohort labels such as:

- `Grade 4 · Section B`
- `Grade 11 · STEM · Section A`
- `Grade 9 · Section A · Group 1 of 2`

Attendance remains student-specific. Cohort progress may be summarized.

Basic Education overall completion is:

- Kinder–Grade 6: Physical Examination completed;
- Grade 7–12: both Laboratory and Physical Examination completed.

This grade-aware rule must not change the approved college overall-status behavior.

## 14. Student portal and submissions

Basic Education students reuse Student ID and Date of Birth authentication.

Kinder–Grade 6 see grade, section, Physical Examination, **Laboratory: Not required**, notifications, history, and Physical result upload when eligible.

Grade 7–12 see grade, strand where applicable, section, both appointments, overall completion, notifications, history, and each corresponding upload workflow after appointment completion.

The existing upload formats, file limits, draft lifecycle, downloads, and administrator invalidation remain unchanged. Kinder–Grade 6 can never receive a Laboratory upload draft.

The same permanent identity preserves history when a Grade 12 student later enrolls in college.

## 15. Unified closures and restoration

Closure processing groups Basic Education appointments by formal cohort.

- Kinder–Grade 6: move the complete Physical Examination cohort.
- Grade 7–12: move the complete Laboratory–Physical pair.

No subset of a cohort may move. Exact oversized subgroup membership is preserved.

Same-day emergency closures may be saved while safe cohorts move and protected cohorts are reported unresolved. A cohort is protected when any required appointment is completed, manually locked, result-protected, or otherwise unsafe.

Reopening attempts all-or-nothing restoration per cohort:

- physical-only cohorts restore every member or none;
- paired cohorts restore both original dates and every member or none;
- unsafe cohorts retain replacement dates.

## 16. College enrollment migration

Create one college enrollment for each existing student's latest defensible academic-year cycle.

Evidence priority:

1. latest appointment `schedule_cycle_start`;
2. latest linked import academic year;
3. no backfill when neither exists.

Use the currently stored college, program, and year level only for that latest known cycle. Do not invent older yearly placements.

Because the system is not deployed, unresolved development rows are reported and recreated through guarded reset/seed or corrected import rather than assigned an invented year.

After all queries use enrollment context, remove or permanently retire mutable college placement fields from `students`.

## 17. Error handling, notifications, and audits

Errors identify the exact row or cohort, for example:

- `Row 28 · Strand: Strand must be blank for Grade 8.`
- `Row 64 · Section: Section F is not configured for Grade 4 in 2026–2027.`
- `Student 26-1234-56 already has a college enrollment for 2026–2027.`
- `Grade 12 · TVL · Section E could not be scheduled by July 31, 2027.`

Notify students when initial schedules publish, corrections or late additions receive dates, closures move dates, reopening restores dates, or submissions are invalidated.

Audit population, academic year, grade, strand, section, cohort, subgroup, old and new dates, cause, actor, and import or closure identifiers.

## 18. Testing

### Unit

Test CSV validation, grade parsing, strand rules, reference matching, ordering, cohort construction, subgroup splitting, no later-section backfill, Physical-only planning, paired next-day searching, closure/weekend skipping, strict CPU waiting, July 31 failure, and grade-aware completion.

### Integration

Test atomic full-roster import, rollback for invalid rows/references/capacity, shared college load, no college displacement, concurrent imports, corrected re-imports, protected correction refusal, late additions, missing-row preservation, dual-population prevention, yearly configuration copying, and latest-known college migration.

### Closure and restoration

Test complete cohort moves, pair moves, subgroup preservation, safe-versus-protected processing, no partial movement, complete restoration, refused partial restoration, and shared capacity checks.

### Browser acceptance

Test separate workflow entry points, template download, year configuration, preflight summary, disabled loading state, import details, clinic filters and cohort labels, grade-aware portal display, and mobile/desktop usability.

Retain regression coverage for college priorities, displacement, unified closures, attendance, authentication, uploads, notifications, reference data, and capacity.

## 19. Out of scope

- guardian-specific accounts
- student self-rescheduling
- time-of-day slots
- doctor scheduling
- a separate Basic Education portal
- automatic creation of unknown strands or sections
- automatic withdrawal for missing re-import rows
- Basic Education displacement of college schedules
- scheduling beyond July 31

## 20. Acceptance criteria

The feature is accepted when:

1. College and Basic Education have separate import workflows.
2. One Basic Education CSV supports Kinder–Grade 12.
3. Kinder–Grade 6 receive only Physical Examination.
4. Grade 7–12 receive Laboratory followed by Physical Examination.
5. Original scheduling follows grade, strand, section, subgroup, and alphabetical order.
6. Sections stay together whenever possible.
7. Oversized subgroup membership remains identical across services.
8. Seven preparation days precede the first appointment.
9. Physical Examination searching begins the day after Laboratory.
10. Higher CPU cohorts cannot pass unfinished lower cohorts.
11. College appointments are never displaced.
12. Shared capacity and unified closures are respected.
13. The full roster publishes atomically by July 31.
14. Yearly placement history is preserved.
15. Late additions and corrections do not rebuild valid schedules.
16. Closures move and restore complete cohorts atomically.
17. One permanent identity survives transition into college.
18. Portal and clinic views show only required services.
19. Migration does not invent historical college placement.
20. Unit, integration, closure, browser, and regression tests pass.
