# Automated Academic-Year Scheduling and Student Result Uploads — Design Specification

**Date:** 2026-07-18  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Purpose

Revise the current clinic scheduler so coordinators import student demographic data rather than preassigned appointment dates. The system must automatically generate date-only Laboratory and Physical Examination appointments, prioritize OJT, Tour, and Specialized students, preserve first-come-first-served ordering, manage clinic closures and automatic rescheduling, and provide a separate student portal for result uploads.

The approved design keeps the existing import lifecycle—import, validate, generate, and publish—but replaces the date-driven input model with a category-and-scheduling-window model.

## 2. Scope

This revision includes:

- A new coordinator CSV format based on the uploaded spreadsheet.
- Student profile upsert by Student ID.
- Automated academic-year scheduling.
- Equal-priority handling for OJT, Tour, and Specialized batches.
- Regular-student displacement when priority capacity is required.
- Date-only appointments and removal of time-slot functionality.
- Per-clinic unavailable-date management.
- Automatic rescheduling and student notifications.
- Student authentication using Student Number and Date of Birth.
- Optional verified student email addresses.
- Multi-file Laboratory and Physical Examination result submissions.
- Private file access, administrative invalidation, and audit logging.

This design does not introduce appointment times, self-service student rescheduling, coordinator access to medical documents, or manual approval before a valid student upload is marked complete.

## 3. Existing System Impact

The current system already has useful foundations:

- Schedule imports can be validated, generated, and published automatically.
- The rule engine distributes requests across eligible dates while enforcing clinic capacity.
- Students are identified by `student_number`.
- Appointments support Laboratory and Physical Examination services.
- Staff authentication and role-based authorization already exist.
- Result status records and audit logs already exist.

The revision changes the source data and scheduling rules rather than replacing the complete workflow.

## 4. Terminology

### 4.1 Student categories

- **Regular:** Standard academic-year scheduling from August through March, with overflow into April and later months.
- **OJT:** Priority student category.
- **Tour:** Priority student category.
- **Specialized:** Priority category for approved special cases not covered by OJT or Tour.

OJT, Tour, and Specialized are collectively called **priority categories**. They are equal in priority.

### 4.2 Appointment pair

A student's normal schedule consists of:

1. Laboratory appointment at KABALAKA Clinic.
2. Physical Examination appointment at CPU Clinic on the earliest available clinic day after Laboratory.

The two records are logically linked even though they remain separate appointments.

### 4.3 Accepted batch

A batch becomes accepted after its file structure and student rows pass import validation. At that point the system assigns an immutable `accepted_at` timestamp. This timestamp determines FCFS order and must not change during retries, edits, validation reruns, generation, or publication.

## 5. Coordinator Import Design

### 5.1 Required CSV headers

The coordinator exports the approved spreadsheet as UTF-8 CSV using this exact header order:

```text
Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth
```

Schedule dates must not appear in the CSV.

### 5.2 Parsed row model

Each valid row produces:

```ts
type ImportedStudentRow = {
  rowNumber: number;
  studentNumber: string;
  surname: string;
  firstName: string;
  middleInitial: string | null;
  suffix: string | null;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  dateOfBirth: string; // ISO YYYY-MM-DD after parsing
};
```

### 5.3 CSV validation

The parser must:

- Require all nine headers in the approved order.
- Treat `MI` and `Suffix` as nullable cells while retaining their columns.
- Normalize surrounding whitespace.
- Reject missing Student ID, surname, first name, college, course, year, or date of birth.
- Validate Student ID length and supported format.
- Validate year level using the supported institutional range.
- Parse Date of Birth from the approved spreadsheet date format and store it as PostgreSQL `DATE`.
- Reject impossible or future birth dates.
- Reject duplicate Student IDs within one CSV and report both row positions.
- Resolve College and Course against active reference data.
- Return row-specific errors without partially accepting an invalid file.

File-size and row-count limits should remain configurable, with the existing limits retained unless a later operational test proves they are too low.

### 5.4 Import form metadata

The import form collects values applying to the entire batch:

- Student category: Regular, OJT, Tour, or Specialized.
- Academic year, such as 2026–2027.
- Preferred month for OJT, Tour, and Specialized batches.
- CSV file.

Regular imports do not require a preferred month.

The preferred priority month is resolved within the selected academic year: August–December use the first calendar year, and January–July use the second calendar year. It is a preferred starting month, not a hard ending boundary.

### 5.5 Existing student upsert

`student_number` remains the stable primary identifier.

When a Student ID already exists:

- Update name fields, college, course, year level, suffix, middle initial, and date of birth.
- Preserve existing appointments, result records, uploads, appointment history, and original queue position.
- Do not create a new schedule request when the student already has an active or historical Laboratory/PE schedule pair from an earlier accepted import.
- Record the profile update in the audit log.

New students are inserted and receive schedule requests from the new batch.

## 6. Scheduling Model

### 6.1 Date-only appointments

Appointments contain an `appointment_date` only. Remove `appointment_time` and all time-slot fields, validation, display logic, API properties, fixtures, and tests.

Capacity is calculated per:

```text
clinic + appointment date + service type
```

### 6.2 Clinic operating days

Both clinics schedule appointments Monday through Friday only.

The scheduler excludes:

- Saturdays.
- Sundays.
- Clinic-specific blocked dates.
- Dates at maximum capacity.

### 6.3 Daily capacity

The current capacity model remains:

- Safe daily capacity: 120.
- Maximum daily capacity: 150.

The scheduler should normally remain at or below safe capacity and must not exceed maximum capacity automatically. Any legacy manual override path must not be used by this automated workflow.

### 6.4 Appointment sequencing

For each newly scheduled student:

1. Find the earliest eligible Laboratory date.
2. Find the earliest later eligible Physical Examination date.
3. Persist the pair only when both dates can be assigned.

Physical Examination must never occur on the same date as or before Laboratory.

“Next available day” means the earliest later Monday–Friday date that is open for CPU Clinic and has remaining PE capacity. It does not necessarily mean the next calendar day.

### 6.5 Seven-calendar-day preparation rule

All newly imported categories require seven calendar days of preparation notice before Laboratory.

For a new request:

```text
earliest Laboratory date =
max(batch accepted date + 7 calendar days, category scheduling-window start)
```

After calculating the date, the scheduler moves forward to the first eligible Monday–Friday clinic date.

The seven-day rule does not apply to automatic rescheduling. Replacement appointments use the earliest available future date.

### 6.6 Regular scheduling window

For Regular batches:

- Coordinators may upload future academic-year batches before August.
- The normal scheduling window begins in August of the selected academic year.
- The intended normal window continues through March.
- When capacity is insufficient, scheduling continues into April and later months until all eligible students have a pair.
- A pre-August upload keeps its early FCFS position even though appointments begin in August.

The effective start date is the later of August's scheduling start and the seven-day preparation date.

### 6.7 Priority-category scheduling window

For OJT, Tour, and Specialized batches:

- The coordinator selects a preferred month within the academic year.
- The effective start is the later of the first day of the selected month and the seven-day preparation date.
- If the selected month cannot hold the complete batch, scheduling continues into the following month and later months until all eligible students are scheduled.

### 6.8 Priority tiers and FCFS order

Scheduling priority is:

```text
Tier 1: OJT = Tour = Specialized
Tier 2: Regular
```

Within each tier, ordering is deterministic:

1. Immutable batch `accepted_at` timestamp.
2. Original CSV row order.
3. Student number as a final tie-breaker.

A later OJT batch does not outrank an earlier Tour or Specialized batch. All three categories share one FCFS queue.

### 6.9 Concurrency

Import acceptance and schedule generation must be serialized sufficiently to preserve FCFS order. Use a database transaction plus an appropriate PostgreSQL advisory lock or locked queue row around:

- assigning `accepted_at`,
- reading current capacity,
- selecting displacement candidates,
- generating new appointments,
- creating replacement appointments, and
- publishing the result.

Two simultaneous imports must produce the same ordering as their committed acceptance sequence.

## 7. Priority Displacement of Regular Appointments

### 7.1 Displacement permission

A newly accepted OJT, Tour, or Specialized batch may displace published Regular appointments when required to obtain capacity.

A Regular appointment is automatically movable only when:

- Its appointment date is later than the current date in `Asia/Manila`.
- Its status is `PENDING`.
- It has no finalized upload or result document.
- It is not manually locked.
- It is not completed, no-show, cancelled, or already rescheduled.

Because appointments are date-only, an appointment becomes ineligible for automatic displacement at midnight when its appointment date begins.

### 7.2 Minimal displacement

The scheduler must move the minimum number of Regular students required to place the priority batch. It must not rebuild the entire academic-year schedule unnecessarily.

Affected Regular students retain their ordering relative to one another:

1. Original Regular batch `accepted_at`.
2. Original CSV row order.
3. Student number.

### 7.3 Replacement behavior

- Original appointments remain as `RESCHEDULED` history records.
- Replacement appointments are created, linked to their originals, marked `PENDING`, and published immediately.
- The cause of displacement, priority batch, previous dates, new dates, and actor are audited.
- Portal notifications are created.
- Email notifications are queued when a verified student email exists.

Email delivery failure never rolls back a committed schedule change.

## 8. Clinic Unavailable Dates

### 8.1 Administration

Administrators manage unavailable dates separately for KABALAKA Clinic and CPU Clinic.

An unavailable-date record supports:

- One date or a continuous date range.
- Clinic.
- Reason.
- Optional category such as holiday, closure, maintenance, or staff unavailability.
- Creator and timestamps.

Overlapping records for the same clinic should be prevented or merged by the service layer.

### 8.2 Blocking dates with published appointments

When an administrator creates a block affecting future published appointments, rescheduling is part of the same operational workflow.

#### CPU Clinic / PE date blocked

- Keep the existing Laboratory appointment.
- Mark the affected PE appointment `RESCHEDULED`.
- Move only PE to the earliest available date after Laboratory.
- Publish the replacement immediately.

#### KABALAKA Clinic / Laboratory date blocked

- Mark both Laboratory and PE appointments `RESCHEDULED`.
- Find a new earliest Laboratory date.
- Find the earliest available PE date after the new Laboratory date.
- Publish the replacement pair immediately.

Protected appointments are not moved automatically and must be reported to the administrator for manual resolution.

## 9. Student Authentication

### 9.1 Separate student identity flow

Staff continue using email and password through the existing staff session.

Students authenticate using:

- Student Number.
- Date of Birth.

Student sessions must be separate from staff sessions, for example:

- Staff cookie: `medclinic_session`.
- Student cookie: `medclinic_student_session`.

A student session contains the student number and a student-session marker only. Date of birth must never be included in the token.

### 9.2 Security controls

The student login endpoint must:

- Normalize Student Number consistently.
- Compare the provided date against `students.date_of_birth`.
- Require the student record to be active.
- Return a generic invalid-credentials message.
- Apply per-IP and per-student-number rate limiting.
- Apply temporary throttling after repeated failures.
- Use secure, HTTP-only, same-site cookies.
- Restrict every student API query by the session's Student Number.

Student Number plus Date of Birth is an institution-approved low-friction authentication method, but the rate limiting and strict ownership checks are mandatory because date of birth is not a secret comparable to a password.

## 10. Optional Student Email Verification

### 10.1 Email setup

After login, students may add an email address for notifications. Email setup is optional and must not block:

- Viewing schedules.
- Reading portal notifications.
- Uploading result documents.
- Viewing or downloading their own finalized submissions.

### 10.2 Verification

- Send a one-time verification code or link.
- Store only a hash of the verification token.
- Expire unused verification requests.
- Keep the previous verified address active until a replacement address is verified.
- Normalize email addresses and enforce uniqueness only if institutional policy requires one student per address.

### 10.3 Notification behavior

Automatic schedule changes always create a portal notification. Email is queued only when a verified address exists.

## 11. Result Submission Lifecycle

### 11.1 Upload eligibility

A student may start a result submission only when the matching published appointment belongs to that student and clinic staff has marked it `COMPLETED`.

- Completed Laboratory unlocks Laboratory upload only.
- Completed PE unlocks PE upload only.
- `PENDING`, `NO_SHOW`, `CANCELLED`, and `RESCHEDULED` appointments do not allow uploads.
- There is no upload deadline after appointment completion.

Until final submission:

```text
appointment status = COMPLETED
result status = PENDING_UPLOAD
```

### 11.2 Allowed files and limits

Each Laboratory or PE submission supports:

- PDF (`application/pdf`).
- JPG/JPEG (`image/jpeg`).
- PNG (`image/png`).
- Maximum 10 files.
- Maximum 20 MB per file.
- Maximum 50 MB combined.

Validation must inspect both extension and detected MIME/file signature. A mismatched or unsupported file rejects the operation.

### 11.3 Draft submission

Students may build a draft gradually:

- Add files.
- Remove files.
- Replace draft files.
- Leave and continue later.
- View count and combined size.

Each draft operation validates ownership, appointment completion, file type, per-file size, total file count, and combined size.

### 11.4 Draft expiration

A draft expires after seven days of inactivity.

- Activity includes adding or removing a file.
- Cleanup deletes private storage objects and database draft metadata.
- No warning is sent.
- Finalized submissions are never affected.
- The appointment remains `COMPLETED` and the result remains `PENDING_UPLOAD`.
- The student may start a new draft.

A scheduled cleanup job should run at least daily and be idempotent.

### 11.5 Final submission

When the student presses Submit:

1. Lock the draft row.
2. Revalidate appointment ownership and `COMPLETED` status.
3. Revalidate every file and aggregate limits.
4. Finalize the submission atomically.
5. Lock all files against student modification.
6. Mark the corresponding result record `COMPLETED`.
7. Record the submission in the audit log.

No staff review is required for completion.

Students cannot add, remove, replace, or delete finalized files themselves.

## 12. Administrative Invalidation

An administrator may mark a finalized submission incomplete when the files are wrong, unreadable, unrelated, or otherwise invalid.

The action requires a reason and performs:

1. Authorization and row locking.
2. Mark submission as invalidated/incomplete.
3. Delete all associated private files.
4. Retain minimal non-document audit metadata.
5. Change the result status to `PENDING_UPLOAD` or an equivalent incomplete state.
6. Keep the appointment status `COMPLETED`.
7. Permit the student to create a replacement draft.
8. Create a portal notification and queue email when verified.

Students may not replace a finalized upload until this administrator action occurs.

## 13. File Storage and Access Control

### 13.1 Storage

Store files in private object storage or a protected server-managed file store. PostgreSQL stores metadata and storage keys, not file bytes.

Storage object names must be generated by the server and must not trust user filenames for paths.

### 13.2 Access matrix

| Actor | Own finalized files | Other student files | Invalidate submission | ZIP download |
|---|---:|---:|---:|---:|
| Student | View/download | No | No | No |
| Coordinator | No | No | No | No |
| Clinic staff | No | No | No | No |
| Administrator | Yes | Yes | Yes | Yes |

Administrators can download individual files or an entire finalized submission as an on-demand ZIP. The ZIP contains uploaded files only and is not stored permanently.

All access must pass through an authenticated application route or short-lived signed URL. Permanent public object URLs are prohibited.

Administrator views and downloads must be audited. Student access may also be logged for security monitoring.

## 14. Proposed Data Model Changes

The implementation plan should translate this logical design into migrations. The expected additions are:

### 14.1 Students

Add:

- `date_of_birth DATE NOT NULL` after safe migration/backfill handling.
- `email VARCHAR(254)`.
- `email_verified_at TIMESTAMPTZ`.

Persist middle initial consistently using the current middle-name field or a deliberate migration to a dedicated field; do not maintain two conflicting sources.

### 14.2 Schedule imports

Add or retain fields for:

- `student_category`.
- `academic_year_start` and `academic_year_end`, or an equivalent normalized academic-year representation.
- `preferred_month` for priority categories.
- Immutable `accepted_at`.
- Original row order on schedule items.

### 14.3 Appointment linkage and locking

Add or ensure:

- A pair/group identifier linking Laboratory and PE for one scheduling request.
- A manual-lock indicator and lock metadata.
- Rescheduling-cause metadata or a normalized rescheduling event table.
- Removal of `appointment_time`.

### 14.4 Clinic unavailable dates

Create a clinic unavailable-date/range table with clinic, start date, end date, reason, category, creator, and timestamps.

### 14.5 Student sessions and email verification

Create the required persistence for:

- Rate-limit/login-attempt tracking when not handled by external infrastructure.
- Email verification token hashes and expiration.

### 14.6 Result submissions

Use a parent-child model:

- `student_result_submissions`: appointment, student, result type, status, draft activity, finalized time, invalidation reason, invalidating administrator.
- `student_result_files`: submission, storage key, original filename, MIME type, byte size, checksum, upload time.

Suggested submission statuses:

- `DRAFT`.
- `FINALIZED`.
- `INVALIDATED`.
- `EXPIRED` when retaining cleanup history is useful; otherwise expired drafts may be hard-deleted after audit logging.

Update result statuses to represent at least:

- `PENDING_UPLOAD`.
- `COMPLETED`.

An invalidated document returns the result to `PENDING_UPLOAD`.

### 14.7 Notifications and email outbox

Create:

- Portal notification records scoped to Student Number.
- An email outbox with retry state so email delivery is independent of appointment transactions.

## 15. Service Boundaries

Keep responsibilities isolated:

- **CSV parser:** structural parsing and row-level validation only.
- **Student import service:** reference resolution and student upsert.
- **Scheduling-window resolver:** converts category, academic year, month, and preparation rule into an earliest eligible date.
- **Rule engine:** deterministic allocation and pair generation.
- **Displacement service:** selects movable Regular appointments and produces minimal replacements.
- **Clinic calendar service:** unavailable-date administration and closure-triggered rescheduling.
- **Student authentication service:** credential verification and student sessions.
- **Submission service:** draft management, finalization, invalidation, and result-status synchronization.
- **Storage adapter:** private file upload, delete, read, signed access, and ZIP streaming.
- **Notification service:** portal events and transactional email outbox.
- **Audit repository:** immutable operational history.

The rule engine should remain pure where possible: receive candidate items, capacities, existing load, blocked dates, and ordering metadata; return proposed assignments, displacements, and unscheduled reasons without performing database writes.

## 16. Transaction and Failure Rules

- CSV structural failure saves no batch or student changes.
- Student upserts, batch acceptance, and initial scheduling should use a controlled transaction boundary.
- Schedule generation and displacement must lock relevant queue/capacity state.
- A failed email never rolls back scheduling.
- A failed storage upload must not create finalized file metadata.
- Final submission is all-or-nothing.
- If one file fails final validation, the draft remains editable and the result remains `PENDING_UPLOAD`.
- Administrative invalidation must be idempotent and must handle storage deletion retries without exposing files after invalidation.
- Clinic-date blocking must either finish the required automatic rescheduling or clearly report protected/unresolved appointments before the administrator considers the closure operation complete.

## 17. User Interface Changes

### 17.1 Coordinator

- Replace the old schedule-date CSV instructions and template.
- Add category, academic year, and preferred-month controls.
- Show accepted timestamp and queue order.
- Show generated date range, overflow, warnings, and displacement summary.

### 17.2 Administrator

- Clinic unavailable-date calendar by clinic.
- Schedule displacement and closure-rescheduling reports.
- Student result-submission viewer.
- Individual and ZIP downloads.
- Mark-incomplete action with mandatory reason.
- Audit trail for accesses, downloads, invalidations, and schedule movement.

### 17.3 Clinic staff

- Continue managing appointment attendance/status.
- Mark appointment `COMPLETED` to unlock the matching student upload.
- Do not display document links or result file contents.

### 17.4 Student portal

- Student Number + Date of Birth login.
- Date-only Laboratory and PE schedule cards.
- Portal notifications with old date, new date, and reason.
- Optional email setup and verification.
- Separate Laboratory and PE result sections.
- Upload button only after matching appointment completion.
- Draft file manager with count, individual sizes, total size, and expiration behavior.
- Final Submit confirmation.
- View/download own finalized files.
- Incomplete reason and replacement-upload access after administrator invalidation.

## 18. Notifications

Automatic schedule-change notification content must include:

- Service affected.
- Previous date.
- Replacement date.
- Reason.
- Change timestamp.
- Link to the student portal.

When Laboratory moves as a pair, one notification may summarize both changed dates. When only PE moves, the notification must state that Laboratory remains unchanged.

Administrative invalidation notifications include the reason and instructions to submit a replacement.

## 19. Auditing

Audit at minimum:

- Import accepted.
- Student inserted or profile updated.
- Schedule generated and published.
- Priority displacement.
- Closure-triggered rescheduling.
- Manual appointment lock/unlock.
- Student result finalized.
- Administrator file view/download.
- Administrator ZIP download.
- Submission invalidated and files deleted.
- Email delivery failure state changes where operationally useful.

Do not place raw Date of Birth, verification tokens, or file contents in audit metadata.

## 20. Testing Strategy

### 20.1 Parser tests

- Exact new headers.
- Nullable MI and Suffix.
- Date-of-birth conversion and invalid dates.
- Duplicate Student IDs.
- Unknown college/course.
- Existing-student upsert without rescheduling.

### 20.2 Rule-engine tests

- Laboratory before PE.
- Friday Laboratory followed by Monday PE.
- Blocked date exclusion by clinic.
- Seven-day notice for every category.
- No seven-day requirement for replacements.
- Regular August start and April overflow.
- Priority selected-month start and cross-month overflow.
- Equal OJT/Tour/Specialized FCFS ordering.
- Minimal Regular displacement.
- Deterministic concurrent import ordering.
- Protected appointment exclusion.

### 20.3 Closure tests

- PE block moves PE only.
- Laboratory block moves the full pair.
- Published replacements and historical `RESCHEDULED` links.
- Protected records reported, not silently altered.

### 20.4 Authentication tests

- Valid and invalid Student Number/DOB.
- Generic error responses.
- Rate limiting.
- Student ownership enforcement.
- Separation from staff session roles.

### 20.5 Upload tests

- Appointment must be `COMPLETED`.
- Correct result type only.
- Allowed MIME signatures.
- Ten-file maximum.
- Twenty-MB individual maximum.
- Fifty-MB combined maximum.
- Draft add/remove/resume.
- Seven-day inactivity cleanup.
- Finalization lock and automatic result completion.
- Student cannot replace finalized files.
- Administrator invalidation reopens upload.
- Access matrix and ZIP authorization.

### 20.6 Notification and outbox tests

- Portal notification always created after rescheduling.
- Email queued only for verified address.
- Email failure does not undo schedule changes.

## 21. Migration and Rollout

Implementation should be staged:

1. Add new database fields and tables without removing legacy date/time paths.
2. Add the new CSV parser and import template behind the revised coordinator UI.
3. Implement the deterministic scheduling-window and pair allocator.
4. Add priority displacement and closure rescheduling.
5. Remove appointment-time usage and migrate all consumers to date-only behavior.
6. Add student authentication and portal.
7. Add private result drafts, finalization, access control, and invalidation.
8. Add notifications, email outbox, and cleanup jobs.
9. Remove obsolete date-driven CSV columns and legacy parser only after end-to-end tests pass.
10. Reset or migrate demo data as appropriate for adviser testing with the approved spreadsheet.

Database migrations must be forward-only and safe to run on a non-empty development database. Any destructive cleanup should be a separate explicitly invoked development/reset operation.

## 22. Acceptance Criteria

The revision is accepted when:

- Coordinators can import the approved nine-column student CSV without schedule dates.
- Existing students are updated without changing their existing schedules.
- New students receive deterministic date-only Laboratory-then-PE schedules.
- All new appointments meet the seven-day preparation rule.
- OJT, Tour, and Specialized batches share one FCFS priority queue above Regular students.
- Priority imports can minimally displace eligible published Regular appointments.
- Clinic closures automatically reschedule affected appointments using the approved PE-only or pair behavior.
- Both clinics schedule Monday–Friday and respect separate blocked dates and capacities.
- Students authenticate using Student Number and Date of Birth.
- Email verification remains optional and notification-only.
- Students can draft and finalize up to 10 PDF/JPEG/PNG files, 20 MB each and 50 MB combined.
- Drafts expire after seven inactive days without warning.
- Final submission automatically completes the result and prevents student replacement.
- Administrators alone can access other students' files, invalidate submissions, and generate file-only ZIP downloads.
- Students can view and download their own finalized files.
- Schedule changes and invalidations generate portal notifications and email when verified.
- Audit logs capture sensitive actions without storing document contents or raw Date of Birth.
