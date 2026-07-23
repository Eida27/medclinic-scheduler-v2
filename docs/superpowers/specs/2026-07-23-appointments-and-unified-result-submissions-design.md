# Attendance-Based Appointments and Unified Student Result Submissions

**Date:** 2026-07-23  
**Status:** Approved design  
**Repository:** `Eida27/medclinic-scheduler-v2`

## 1. Purpose

Revise two administrator workflows so that appointment attendance and student document submission are treated as separate concerns:

1. The **Appointments** tab must report whether students attended and finished their Laboratory and Physical Exam appointments. Uploading or finalizing result documents must not control appointment completion.
2. The **Student result submissions** tab must present one unified lifetime profile per student instead of one card per appointment-level submission, while preserving independent Laboratory and Physical Exam files, actions, and history.

The implementation will aggregate the existing appointment-linked submission records rather than replace the current data model.

## 2. Current Problems

### 2.1 Appointments completion is coupled to result uploads

The current appointment summary derives the Laboratory and Physical Exam columns from `laboratory_results.result_status` and `exam_results.result_status`. The overall status becomes complete only when both result records are `COMPLETED`.

A result record is changed to `COMPLETED` when a student finalizes uploaded files. This means a student can physically finish an appointment while the Appointments tab still reports it as pending until document submission occurs.

### 2.2 Result submissions are duplicated by student

The administrator result-submission list currently renders one card per `student_result_submissions` row. Laboratory and Physical Exam submissions are separate rows, so the same student appears twice.

This is correct for storage and auditability but unsuitable for the administrator-facing list and detail workflow.

## 3. Approved Product Decisions

1. Appointment columns display **appointment attendance statuses**, not result-upload statuses.
2. Overall appointment completion is **Complete** only when both current Laboratory and Physical Exam appointments are `COMPLETED`.
3. Every other appointment combination is **Incomplete**.
4. Missing published appointments display **Unscheduled** and count as incomplete.
5. A rescheduled service follows and displays the active replacement appointment.
6. Medical-result statuses such as `PENDING_UPLOAD` and `REQUIRES_FOLLOW_UP` do not appear in the Appointments tab.
7. Result submissions are presented as one lifetime student profile with separate Laboratory and Physical Exam sections.
8. A student appears in the administrator submission list as soon as either result type has been finalized. The student remains visible after invalidation.
9. The unified page keeps invalidated submissions visible as **Invalidated — awaiting resubmission** and shows their reason and date.
10. Older and invalidated submissions remain in a submission-history section.
11. Current submission progress is based only on submissions linked to the student’s latest effective Laboratory and Physical Exam appointments.
12. When a newer appointment exists without a finalized submission, the current section shows **Not submitted yet** and older submissions move to history.

## 4. Chosen Architecture

### 4.1 Preserve appointment-level submissions

Keep the existing `student_result_submissions` relationship to:

- one student,
- one appointment,
- one result type,
- its own files,
- its own finalization and invalidation lifecycle.

Do not merge Laboratory and Physical Exam files into one database row and do not create a second mutable student-result profile table.

### 4.2 Add a shared current-appointment resolver

Introduce a single server-side resolver used by both the Appointments report and unified result-submission queries. It returns the current effective published appointment for a student and service.

This resolver is the source of truth for:

- the attendance status shown in Appointments,
- the appointment whose submission is current on the unified result page,
- the combined submission progress shown on the student card.

The resolver should be implemented as a focused repository query or reusable SQL CTE rather than duplicated SQL fragments with subtly different ordering rules.

### 4.3 Aggregate submissions at read time

Add student-level repository/service responses that combine:

- student identity,
- current effective Laboratory appointment,
- current effective Physical Exam appointment,
- newest relevant submission for each current appointment,
- combined submission progress,
- all remaining finalized or invalidated submissions as history.

This is a read-model change. Existing submission mutations continue to operate on individual submission IDs.

## 5. Current Effective Appointment Resolution

Resolve Laboratory and Physical Exam independently.

### 5.1 Eligible records

An appointment is eligible when:

- it belongs to the requested student,
- its `schedule_type` matches the requested service,
- `is_published = TRUE`.

Draft and unpublished appointments do not affect the administrator attendance summary or current submission requirement.

### 5.2 Reschedule chains

Appointments use `rescheduled_from` to point from a replacement to its previous appointment.

For a reschedule chain:

1. Follow published replacement appointments until the leaf appointment is reached.
2. Display the leaf appointment’s current status.
3. Do not display the superseded `RESCHEDULED` status when a replacement exists.
4. If a `RESCHEDULED` appointment has no published replacement because of inconsistent or legacy data, it remains the effective record and displays `Rescheduled` rather than disappearing.

### 5.3 Multiple appointment cycles

A student may receive a later appointment cycle after having completed an earlier one. Among effective leaf appointments, select the newest requirement using deterministic ordering:

1. appointment date descending,
2. creation timestamp descending,
3. appointment ID descending as a stable tie-breaker.

Therefore, a newer pending appointment becomes current even when an older appointment was completed and had finalized results.

### 5.4 Unscheduled state

When no eligible published appointment exists for a service, return a synthetic status of `UNSCHEDULED` with a null appointment ID and date.

`UNSCHEDULED` is a presentation/read-model value and does not need to be added to the database appointment-status constraint.

## 6. Appointments Tab Design

### 6.1 Row model

Each active student row contains:

- student number,
- student display name,
- college and program,
- current Laboratory appointment ID, date, and operational status,
- current Physical Exam appointment ID, date, and operational status,
- overall attendance completion.

The service statuses are:

- `UNSCHEDULED`
- `PENDING`
- `COMPLETED`
- `NO_SHOW`
- `RESCHEDULED`
- `CANCELLED`

### 6.2 Overall attendance status

Only two overall values are permitted:

- `COMPLETE`: both current service statuses equal `COMPLETED`.
- `INCOMPLETE`: any other combination.

Examples:

| Laboratory | Physical Exam | Overall |
|---|---|---|
| Completed | Completed | Complete |
| Completed | Pending | Incomplete |
| Completed | Unscheduled | Incomplete |
| No-show | Completed | Incomplete |
| Cancelled | Completed | Incomplete |
| Pending replacement | Completed | Incomplete |

`FOLLOW_UP` is removed from the Appointments page’s overall-status type, labels, filters, sorting priority, and tests.

### 6.3 Filters

Replace result-status filter options with attendance options.

- **Laboratory status:** Any, Unscheduled, Pending, Completed, No-show, Rescheduled, Cancelled
- **Physical Exam status:** the same options
- **Overall completion:** Any, Complete, Incomplete
- **Student name or number:** retained
- **Sort:** retained, with labels revised where they refer to result completion or attention states

Filtering must use the resolved current effective appointment statuses, not arbitrary historical appointment rows.

### 6.4 Metrics

Retain four summary cards, but define them as attendance metrics:

- Matching students
- Laboratory completed
- Physical Exam completed
- Incomplete any

Finalizing, invalidating, deleting, or replacing a student result submission must not change these counts.

### 6.5 Labels and badges

Use the existing operational status label helper for database statuses and add a readable `Unscheduled` label for the synthetic value.

Badge tones should remain consistent with the rest of the system:

- completed/complete: success,
- pending/rescheduled: warning,
- no-show/cancelled: danger,
- unscheduled/incomplete: neutral unless the existing design system defines a more appropriate established tone.

## 7. Student Result Submissions List

### 7.1 Inclusion rule

Return one card per student when the student has at least one lifetime submission whose status is `FINALIZED` or `INVALIDATED`.

Draft-only activity does not expose the student in the administrator list because drafts are still private, unfinished student work.

A student remains visible after an administrator invalidates their only finalized submission.

### 7.2 Card model

Each card displays:

- student name,
- student number,
- current Laboratory submission state and file count,
- current Physical Exam submission state and file count,
- combined submission progress,
- most recent finalized or invalidated activity timestamp.

The current per-service state is determined only from the newest relevant submission linked to that service’s current effective appointment.

### 7.3 Per-service card states

- `FINALIZED`: show `Finalized` and the active file count.
- `INVALIDATED`: show `Invalidated — awaiting resubmission`.
- no current finalized or invalidated submission: show `Not submitted yet`.
- no current appointment: also show `Not submitted yet`; the detail page separately identifies the service as unscheduled.

### 7.4 Combined progress

Calculate in this priority order:

1. `AWAITING_RESUBMISSION` when either current service submission is invalidated and has no newer finalized replacement.
2. `FULLY_SUBMITTED` when both current service submissions are finalized.
3. `PARTIALLY_SUBMITTED` when exactly one current service submission is finalized.
4. `NOT_SUBMITTED` when neither current service submission is finalized or invalidated but the student remains listed because of historical submission activity.

User-facing labels:

- Awaiting resubmission
- Fully submitted
- Partially submitted
- Not submitted

The `Not submitted` combined state is an edge case that occurs when a student has older history but newer current appointments without submissions.

### 7.5 Sorting

Default ordering is most recent submission activity descending, followed by student name and student number for deterministic results.

Pagination should operate after grouping by student so one student cannot occupy multiple list slots.

## 8. Unified Student Result Page

### 8.1 Canonical route

Use a student-number-based canonical route:

`/settings/student-result-submissions/students/[studentNumber]`

Encode the student number when generating links. Next.js route handling must correctly decode it before repository lookup.

The existing submission-ID detail route may be retained as a compatibility redirect: resolve the submission ID to its student number and redirect to the canonical unified page. Internal links should use only the canonical student route.

### 8.2 Page header

Show:

- student display name,
- student number,
- college/program where available,
- combined submission progress badge,
- link back to the submissions list.

### 8.3 Current Laboratory section

Display:

- current effective appointment status and date,
- current submission state,
- finalized date or invalidation date,
- invalidation reason when applicable,
- file count and total size,
- files with individual download actions when finalized,
- ZIP download when finalized and files exist,
- administrator invalidation action when the submission is currently finalized.

States:

- **Finalized**
- **Not submitted yet**
- **Invalidated — awaiting resubmission**
- **Unscheduled appointment** as supporting appointment context, while the submission state remains `Not submitted yet`.

### 8.4 Current Physical Exam section

Use the same structure and rules as the Laboratory section. The two sections remain independently actionable and independently invalidatable.

### 8.5 Current submission selection

For each current appointment, select the newest submission in `FINALIZED` or `INVALIDATED` status using deterministic activity ordering:

1. latest of invalidation/finalization/last-activity timestamp,
2. creation timestamp descending,
3. submission ID descending.

When an invalidated submission is followed by a new finalized submission for the same appointment, the finalized replacement becomes current and the invalidated submission moves to history.

Drafts are not shown to administrators as current submissions.

## 9. Submission History

### 9.1 Included records

History contains every finalized or invalidated submission that is not selected as one of the two current submissions, including:

- finalized submissions linked to older appointments,
- invalidated submissions linked to older appointments,
- an invalidated submission for the current appointment after a newer finalized replacement exists,
- superseded finalized submissions if legacy or corrected data contains more than one candidate.

### 9.2 History fields

Each entry shows:

- result type,
- appointment date and appointment ID context,
- appointment status where useful,
- submission status,
- finalized date,
- invalidation date,
- invalidation reason,
- file count and total size.

Order history by most recent submission activity descending.

### 9.3 Historical downloads

- Older `FINALIZED` submissions keep individual and ZIP download access when their files still exist and pass integrity checks.
- `INVALIDATED` submissions show metadata, invalidation reason, and dates but no download controls after cleanup removes their files.
- Missing or failed-integrity files must produce the existing controlled error behavior and audit trail rather than a broken link.

## 10. Service and Repository Boundaries

### 10.1 Appointment read model

Create or refactor a focused current-appointment query/CTE that can be reused by:

- `appointment-summary.repository.ts`,
- student-level result-submission queries,
- tests for reschedule-chain and latest-cycle behavior.

It should expose service appointment ID, date, status, and any fields needed for deterministic selection.

### 10.2 Appointment summary repository

Revise the appointment summary so that:

- `laboratoryStatus` and `physicalExamStatus` are operational appointment statuses,
- result-table lateral joins are removed from attendance status calculation,
- `overallStatus` has only `COMPLETE | INCOMPLETE`,
- metrics and filters use the same resolved status fields.

Rename misleading result-oriented types and helper functions where practical, while avoiding unrelated refactors.

### 10.3 Student result submission repository

Add student-level query methods, for example:

- list aggregated student submission profiles,
- fetch one unified student submission profile,
- resolve submission ID to student number for legacy redirects.

The exact function names may follow repository conventions, but the return types should explicitly separate:

- current Laboratory appointment/submission,
- current Physical Exam appointment/submission,
- history.

### 10.4 Student result submission service

Keep existing submission-level mutation methods for:

- file download,
- ZIP download,
- invalidation.

Add administrator student-profile service methods that enforce `ADMIN` access once and return the aggregated read models.

The unified page should use one service response to avoid independent queries selecting different current appointments during concurrent changes.

## 11. Permissions, Privacy, and Audit

Existing access rules remain unchanged:

- only administrators may access the administrator submission list and unified detail pages,
- students may access only their own upload workflow and files,
- clinic staff do not receive access to private uploaded medical documents through this revision,
- individual downloads remain audited,
- ZIP downloads remain audited,
- invalidation remains administrator-only and requires a reason,
- appointment attendance pages may continue following their existing admin/clinic-staff permissions.

The aggregation layer must not weaken file ownership checks or allow a file ID from one student/submission to be downloaded through another student’s profile.

## 12. Concurrency and Error Handling

Handle these cases explicitly:

- student not found,
- no current appointment for one or both services,
- appointment rescheduled while the page is open,
- submission finalized or invalidated while the page is open,
- invalidation requested for a submission that is no longer current or finalized,
- file missing from storage,
- checksum/integrity failure,
- unauthorized access.

Mutation behavior:

1. Mutations continue to target immutable IDs such as submission ID and file ID.
2. Repository/service code validates the expected current state inside the transaction.
3. A conflict returns a clear `409`-style error.
4. The UI reports that the record changed and refreshes or revalidates the unified profile instead of silently retaining stale controls.

Changing appointments or submissions should trigger route revalidation for both the relevant unified result page and list page where existing application patterns support it.

## 13. Database and Migration Strategy

### 13.1 No destructive migration

Do not merge, rewrite, or delete existing appointment-level Laboratory and Physical Exam submission rows.

No persistent student-profile table is required.

### 13.2 Optional performance indexes

Add a migration only when query plans or existing indexes show a need. Candidate indexes include:

- `appointments (student_number, schedule_type, is_published, appointment_date DESC, created_at DESC)`
- `appointments (rescheduled_from)`
- `student_result_submissions (student_number, appointment_id, status)`
- activity-ordering indexes involving `finalized_at`, `invalidated_at`, or `last_activity_at` where supported and useful.

Before adding overlapping indexes, inspect existing schema migrations and PostgreSQL indexes. Prefer the smallest set justified by the new queries.

## 14. Testing Strategy

### 14.1 Appointment repository and page tests

Verify:

- statuses come from appointment rows rather than result rows,
- both completed appointments produce `Complete`,
- one completed and one pending produce `Incomplete`,
- an absent service produces `Unscheduled` and `Incomplete`,
- a rescheduled appointment follows its replacement,
- a later appointment cycle supersedes an older completed cycle,
- an unresolved rescheduled record remains visible as `Rescheduled`,
- `Needs follow-up` is absent from overall filters and output,
- attendance filters match the displayed current statuses,
- metrics count grouped students correctly,
- finalizing or invalidating result submissions does not change appointment attendance output.

### 14.2 Aggregated list tests

Verify:

- Laboratory and Physical Exam submissions for one student produce one card,
- a student appears after the first finalized submission,
- an invalidated-only student remains visible,
- draft-only activity remains hidden,
- current states use only latest effective appointments,
- a newer appointment without submission yields `Not submitted yet`,
- both current finalized submissions yield `Fully submitted`,
- exactly one current finalized submission yields `Partially submitted`,
- a current invalidated submission yields `Awaiting resubmission`,
- historical activity with neither current submission yields `Not submitted`,
- grouping occurs before pagination,
- ordering is deterministic.

### 14.3 Unified page tests

Verify:

- both current sections render independently,
- current appointment status/date are correct,
- finalized files expose individual and ZIP downloads,
- invalidation controls appear only for current finalized submissions,
- invalidated current submissions show reason and date,
- a later finalized replacement becomes current,
- older finalized and invalidated records move to history,
- invalidated deleted files do not expose download controls,
- legacy submission-ID links redirect when compatibility support is implemented,
- encoded student-number routes resolve correctly,
- non-admin users are denied.

### 14.4 Mutation regression tests

Existing tests for upload, finalization, file validation, downloads, ZIP generation, invalidation, audit logging, and appointment correction must continue passing.

Add tests proving that the new aggregated read model does not change submission-level mutation semantics.

### 14.5 End-to-end acceptance workflow

1. Clinic staff completes the Laboratory appointment.
2. Appointments immediately shows Laboratory `Completed` before any upload.
3. The student finalizes Laboratory files.
4. One unified administrator card appears as `Partially submitted`.
5. Clinic staff completes the Physical Exam appointment.
6. Appointments becomes `Complete` before Physical Exam files are uploaded.
7. The student finalizes Physical Exam files.
8. The unified card becomes `Fully submitted`.
9. An administrator invalidates Laboratory results.
10. The card becomes `Awaiting resubmission`; the invalidated record remains visible with reason/date.
11. The student finalizes replacement Laboratory files.
12. The card returns to `Fully submitted`; the invalidated submission appears in history.
13. A newer Laboratory appointment is created.
14. The current Laboratory submission state becomes `Not submitted yet`; prior Laboratory submissions remain in history.

## 15. Acceptance Criteria

The revision is accepted when all of the following are true:

1. Completing an appointment changes the Appointments attendance status immediately, independent of result upload.
2. The Appointments overall status is complete only when both current service appointments are completed.
3. Rescheduled appointments display the replacement appointment’s status.
4. Unscheduled services display `Unscheduled` and remain incomplete.
5. Appointments no longer exposes medical-result follow-up as an overall status.
6. The result-submission list contains at most one card per student.
7. One unified student page displays separate current Laboratory and Physical Exam sections.
8. Current submission progress is based on submissions for the latest effective appointments.
9. Older finalized and invalidated submissions remain available in history according to file-retention rules.
10. Existing privacy, authorization, file-integrity, audit, and invalidation safeguards remain intact.
11. The relevant unit, integration, page, API, and end-to-end tests pass.

## 16. Non-Goals

This revision does not:

- change how clinic staff mark appointment attendance,
- grant clinic staff access to private student files,
- combine Laboratory and Physical Exam files into one submission row,
- alter student upload limits or file-type validation,
- change draft retention or cleanup policy,
- introduce medical diagnosis or follow-up management into the Appointments tab,
- separate result profiles by academic year or schedule batch,
- delete historical valid submissions.
