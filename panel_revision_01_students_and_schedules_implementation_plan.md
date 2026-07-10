# Panel Revision 01 — Unified Students and Schedule Import Implementation Plan

Repository: `https://github.com/Eida27/medclinic-scheduler-v2`

Project: Central Philippine University MedClinic Scheduler

Purpose: Implement the first set of panel revisions by removing demo student fixtures, merging the Students and Coordinator Schedules user experience, importing the official student schedule CSV from one administrator-controlled area, and displaying only published schedules in the Laboratory and Physical Exam tabs.

---

## 1. Instructions for Codex

Implement this plan against the current repository state. Inspect the existing code before changing it because the project already contains student management, coordinator schedule imports, clinic-specific batches, validation, appointment generation, publishing, capacity rules, audit logs, and tests.

Follow these rules:

1. Preserve the existing layered architecture:
   - App Router pages and components
   - Route handlers
   - Service layer
   - Repository layer
   - Rule engine
   - PostgreSQL
2. Do not move SQL into UI components or route handlers.
3. Do not replace PostgreSQL or the `pg` package.
4. Do not add Prisma, Drizzle, Supabase, Firebase, or another persistence framework.
5. Do not remove working capacity, validation, audit, appointment-status, compliance, result-history, authentication, or clinic-access behavior.
6. Add migrations for database changes. Do not silently depend on a database reset.
7. Keep destructive cleanup narrowly limited to known demo fixtures and student numbers beginning with `DEMO-`.
8. Update or replace tests that currently depend on production demo seed data.
9. Run the full verification suite before considering the work complete:

```powershell
npm test
npm run lint
npm run build
```

10. Provide a final implementation summary containing:
    - Files created, updated, redirected, or removed
    - Database migration instructions
    - Any intentional compatibility behavior
    - Test, lint, and build results

---

## 2. Revision Goals

### 2.1 Remove demo student records

The system must no longer seed the 180 students whose identifiers use `DEMO-0001` through `DEMO-0180` or the coordinator batches created only for demonstration and capacity testing.

The official imported CSV will be used for end-to-end testing.

Keep the required reference and development data unless separately instructed otherwise:

- Clinics
- Colleges
- Programs
- Priority groups
- Capacity settings
- Required local administrator and clinic-staff accounts

### 2.2 Merge Students and Coordinator Schedules

The sidebar currently exposes separate navigation entries for Students and Coordinator Schedules. Replace them with one navigation entry:

```text
Students & Schedules -> /students
```

The combined area must support:

- Viewing and searching student records
- Manually adding a student when necessary
- Importing the official schedule CSV
- Viewing schedule-import history
- Reviewing validation results
- Generating appointments
- Publishing both laboratory and physical examination schedules

### 2.3 Centralize CSV import

Only the combined Students & Schedules area may contain the master schedule CSV importer.

Remove CSV import and coordinator-batch creation controls from:

- Laboratory pages
- Physical Exam pages
- Clinic-specific coordinator schedule pages

The administrator imports one CSV containing both schedule dates. The backend separates each row into laboratory and physical examination requests.

### 2.4 Show schedules in clinic tabs after publication

After the administrator publishes an imported schedule:

- Laboratory appointments appear in the Laboratory tab.
- Physical examination appointments appear in the Physical Exam tab.

Draft, validated, or generated-but-unpublished appointments must not appear in the normal Laboratory or Physical Exam schedule lists.

---

## 3. Non-Negotiable Product Decisions

Implement the following behavior exactly.

### 3.1 Import authority

- An `ADMIN` can upload the master CSV.
- An `ADMIN` can validate, generate, and publish the complete import.
- Clinic staff cannot upload the master CSV.
- Clinic staff continue to manage operational records within their assigned clinic, subject to existing authorization rules.
- Enforce permissions in the service or route layer, not only by hiding UI controls.

### 3.2 Upload format

The user-provided Excel workbook is a format reference. The application upload remains a UTF-8 `.csv` file.

Required logical columns, in this exact order:

```csv
Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule
23-8200-01,"Abad, Aaron Miguel A.",College of Computer Studies,BSCS,3,07-29-2026,07-30-2026
```

Rules:

- File extension: `.csv`
- Maximum file size: retain the existing 1 MB limit unless a test proves it insufficient.
- Maximum data rows: retain the existing 500-row limit.
- Encoding: UTF-8; accept an optional UTF-8 BOM.
- Date format: `MM-DD-YYYY`.
- Ignore trailing columns only when every trailing value is blank. This is important because spreadsheet exports may include formatted but empty columns.
- Reject unexpected non-empty extra columns.
- Reject a file without a header and at least one data row.
- Trim surrounding whitespace in headers and values, but continue requiring the defined header names and order.
- At least one of the two schedule dates must be present for every row.
- Normally both dates will be present.
- A blank laboratory date means no laboratory request for that row.
- A blank physical examination date means no physical examination request for that row.
- The old `Appointment Date` and `Appointment Type` columns are no longer part of the supported master format.

### 3.3 Name format

The official format uses:

```text
Last Name, First Name Middle Name/Initial
```

Example:

```text
Abad, Aaron Miguel A.
```

Parse it as:

```text
last_name   = Abad
first_name  = Aaron
middle_name = Miguel A.
suffix      = null
```

Implementation requirements:

- Split at the first comma.
- Require a non-empty surname before the comma.
- Require at least one given-name token after the comma.
- Store the first token after the comma as `first_name`.
- Store the remaining tokens as `middle_name` unless a recognized suffix is deliberately extracted.
- Do not store the surname in `first_name`.
- Preserve punctuation inside initials.
- Normalize repeated whitespace.
- Compare existing students using parsed canonical components instead of comparing incompatible display strings such as `First Last` against `Last, First`.

Recognized suffix extraction is optional. If implemented, restrict it to an explicit allowlist such as `Jr.`, `Sr.`, `II`, `III`, and `IV`.

### 3.4 Per-row schedule expansion

Each valid CSV row becomes zero, one, or two schedule items according to its date columns:

```text
Laboratory Schedule present
    -> schedule_type = LABORATORY
    -> clinic = KABALAKA_CLINIC
    -> target_date = parsed laboratory date

Physical Examination Schedule present
    -> schedule_type = PHYSICAL_EXAM
    -> clinic = CPU_CLINIC
    -> target_date = parsed physical examination date
```

A row with both dates produces two schedule items for the same student.

The importer must no longer infer services from an `Appointment Type` value.

### 3.5 One visible import operation

The database may continue storing separate clinic-specific schedule batches, but the administrator must experience the upload as one import operation.

One import operation must group:

- The source CSV metadata
- The created or matched students
- The laboratory batch
- The physical examination batch
- Combined validation status
- Combined generation status
- Combined publication status

Do not make the administrator locate and manage two unrelated batches after uploading one file.

### 3.6 Atomic publication

Publishing the combined import must publish all generated child batches in one transaction.

- If both laboratory and physical batches exist, both must publish successfully or neither must publish.
- If the CSV contains only one service, publish the one existing batch.
- Do not leave the import partially published after an error.
- Write audit records that identify the import group and its child batch IDs.

### 3.7 Published-only clinic views

Normal Laboratory and Physical Exam schedule views must query published appointments by default.

Use an explicit repository filter equivalent to:

```ts
isPublished: true
```

Do not depend on a URL query parameter to hide drafts.

Administrators may review drafts only in the Students & Schedules import-detail workflow.

---

## 4. Target User Flow

```text
Administrator signs in
        ↓
Opens Students & Schedules
        ↓
Selects Schedule Imports
        ↓
Uploads one UTF-8 CSV
        ↓
System validates file structure, names, references, students, dates, and duplicates
        ↓
System creates missing students and grouped clinic schedule batches atomically
        ↓
Administrator reviews one import summary
        ↓
Administrator validates both child batches
        ↓
Administrator generates laboratory and physical appointment drafts
        ↓
Administrator publishes the complete import atomically
        ↓
Published laboratory appointments appear in Laboratory
Published physical appointments appear in Physical Exam
        ↓
Clinic staff updates appointment statuses and results in the appropriate clinic workspace
```

---

## 5. Navigation and Page Structure

### 5.1 Target sidebar

Use this primary navigation:

```text
Dashboard
Laboratory
Physical exam
Students & Schedules
Appointments
Compliance
Results
```

Administration section remains:

```text
Users
Reference data
Capacity
```

Remove the standalone `Coordinator schedules` link.

### 5.2 Combined `/students` page

Refactor `/students` into the Students & Schedules workspace.

Recommended header:

```text
Title: Students & Schedules
Description: Manage student records and publish imported clinic schedules.
```

Recommended actions:

- `Import schedule CSV` — visible only to administrators
- `Add student` — preserve according to the intended role policy
- `Download CSV template`

Use two clear views or tabs:

#### Students view

Preserve and improve the existing student table:

- Search by student number or name
- Filter by college
- Filter by course/program
- Filter by year level
- Pagination
- Open student details
- Add student action

#### Schedule Imports view

Display grouped import operations, not individual clinic batches.

Recommended columns:

- Import name or source filename
- Imported date
- Imported by
- Student rows
- Laboratory items
- Physical examination items
- Validation summary
- Status
- Action

Recommended status values:

```text
DRAFT
VALIDATED
GENERATED
PUBLISHED
CANCELLED
```

If child batches are not synchronized because of pre-existing data, show a safe transitional status such as `NEEDS_REVIEW`. New grouped workflows must keep child batches synchronized.

### 5.3 Import page or dialog

Recommended route:

```text
/students/schedule-imports/new
```

Fields:

- CSV file
- Import or batch name, defaulted from filename
- Priority group
- Submitted-by/coordinator name, optional
- Description, optional

Provide:

- Exact required headers
- A downloadable template
- Date-format reminder
- Maximum row/file limits
- Selected filename
- Pending state that prevents duplicate submissions
- Row-specific validation errors

On success, redirect to:

```text
/students/schedule-imports/[importId]
```

### 5.4 Grouped import detail page

Recommended route:

```text
/students/schedule-imports/[importId]
```

Show:

- Source filename
- Import name
- Importer
- Import timestamp
- Total CSV rows
- Existing students matched
- New students created
- Laboratory request count
- Physical examination request count
- Child batch IDs only when useful for technical support; do not make them the primary UX
- Combined status
- Validation totals
- Capacity results by clinic and date
- Row-level issues

Use separate sections inside the same page:

```text
Laboratory — KABALAKA Clinic
Physical Examination — CPU Clinic
```

Actions:

- Validate import
- Generate appointments
- Publish schedules
- Return to import history

The action buttons must operate on the import group and all applicable child batches.

### 5.5 Laboratory page

The `/laboratory` tab should directly prioritize the published laboratory schedule instead of presenting a coordinator-schedule creation workspace.

Display:

- Published laboratory appointments
- Student name and student number
- Appointment date
- Status
- Search and date filters
- Operational links to appointment details
- Summary metrics where useful

Remove:

- CSV import
- New batch button
- Coordinator schedules button

Recommended compatibility behavior:

- Reuse the existing clinic appointment component or query.
- Redirect `/laboratory/appointments` to `/laboratory`, or make both routes render the same shared published-only component.
- Redirect old `/laboratory/coordinator-schedules` routes to `/students?view=schedule-imports` or a suitable replacement.

### 5.6 Physical Exam page

Apply the same changes to `/physical-exam`:

- Directly show published CPU Clinic physical examination appointments.
- Remove CSV and coordinator-batch controls.
- Redirect or reuse `/physical-exam/appointments`.
- Redirect old clinic-specific coordinator-schedule routes to the combined import history.

### 5.7 Legacy coordinator schedule routes

Do not leave duplicate active workflows.

For existing routes under:

```text
/coordinator-schedules
/laboratory/coordinator-schedules
/physical-exam/coordinator-schedules
```

Prefer redirects to the new Students & Schedules routes so bookmarks do not produce confusing 404 pages.

Examples:

```text
/coordinator-schedules
    -> /students?view=schedule-imports

/coordinator-schedules/new
    -> /students/schedule-imports/new

/coordinator-schedules/[batchId]
    -> resolve its import group and redirect to /students/schedule-imports/[importId]
```

For an old batch without an import group, either show a read-only legacy detail page or redirect to a filtered legacy-review state. Do not destroy historical data merely to support redirects.

---

## 6. Database Changes

Use the next available migration number. Suggested migration name:

```text
database/migrations/006_unified_student_schedule_imports.sql
```

Adjust the number if newer migrations already exist.

### 6.1 Add an import-group table

Recommended schema:

```sql
CREATE TABLE schedule_import_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_name VARCHAR(150) NOT NULL,
  source_filename VARCHAR(255) NOT NULL,
  total_rows INTEGER NOT NULL CHECK (total_rows > 0),
  created_student_count INTEGER NOT NULL DEFAULT 0 CHECK (created_student_count >= 0),
  matched_student_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_student_count >= 0),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Optional metadata may include:

- Description
- Submitted-by name
- Original file hash for duplicate-upload detection

Do not store the complete CSV contents unless there is a clear retention and privacy reason.

### 6.2 Link schedule batches to their import group

Add:

```sql
ALTER TABLE schedule_batches
  ADD COLUMN import_group_id UUID REFERENCES schedule_import_groups(id);
```

Add an index:

```sql
CREATE INDEX schedule_batches_import_group_idx
  ON schedule_batches (import_group_id, status);
```

Use child batch status as the source of truth. A group status may be computed in repository/service code to avoid maintaining duplicate lifecycle state.

### 6.3 Optional unique constraints

Prevent more than one child batch for the same clinic inside one import group:

```sql
CREATE UNIQUE INDEX schedule_batches_group_clinic_unique
  ON schedule_batches (import_group_id, clinic_id)
  WHERE import_group_id IS NOT NULL;
```

### 6.4 Auditability

Audit events should include:

```text
SCHEDULE_IMPORT_CREATED
SCHEDULE_IMPORT_VALIDATED
SCHEDULE_IMPORT_GENERATED
SCHEDULE_IMPORT_PUBLISHED
```

Metadata should include:

- Import group ID
- Source filename
- Child batch IDs
- Total rows
- Laboratory item count
- Physical examination item count
- Created student count

### 6.5 Demo fixture cleanup migration

Add a narrowly scoped migration or one-time cleanup SQL file for existing development databases.

Delete only:

- Known demo schedule batches
- Child coordinator schedule items and appointments associated with those batches
- Related demo result/status records where applicable
- Students whose student number matches `DEMO-%`

Use a transaction and dependency-safe deletion order. Do not delete real student numbers.

Document the cleanup in the README.

---

## 7. Seed Data Changes

### 7.1 Remove production-style demo fixtures

Delete or empty the existing demo-data seed that creates:

- `DEMO-0001` through `DEMO-0180`
- Demo capacity batches
- Demo week-distribution batches
- Demo coordinator schedule items

The seed runner must continue working when this file is removed.

### 7.2 Retain required startup data

Keep seeds for:

- KABALAKA Clinic
- CPU Clinic
- User accounts required for local development
- Colleges
- Programs
- Priority groups
- Capacity settings

### 7.3 Test fixture isolation

Tests must not depend on the removed demo seed.

Create test-specific fixtures inside integration-test setup using deterministic IDs and explicit cleanup or transaction rollback.

Do not restore demo students merely to make tests pass.

---

## 8. CSV Parser Refactor

Refactor the existing coordinator schedule CSV parser rather than building parsing logic inside a React component or route handler.

Suggested file direction:

```text
src/server/services/student-schedule-import-csv.ts
```

Renaming the existing parser is optional. Internal module names may remain coordinator-oriented if renaming creates unnecessary risk, but exported types and behavior must match the new format.

### 8.1 New row type

Use a shape similar to:

```ts
type StudentScheduleCsvRow = {
  rowNumber: number;
  studentNumber: string;
  rawName: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  laboratoryDate: string | null;
  physicalExaminationDate: string | null;
};
```

### 8.2 Header validation

Expected headers:

```ts
const expectedHeaders = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
] as const;
```

Remove trailing blank cells before comparing headers and row lengths.

### 8.3 Date validation

Reuse or extract strict date parsing that:

- Accepts only `MM-DD-YYYY`
- Rejects impossible dates such as `02-30-2026`
- Returns ISO `YYYY-MM-DD`
- Allows a blank service date
- Rejects the row when both service dates are blank

### 8.4 Student-number validation

Continue enforcing a practical maximum length, but add format validation appropriate to CPU student numbers when safe:

```text
NN-NNNN-NN
```

Recommended regex:

```regex
^\d{2}-\d{4}-\d{2}$
```

If legacy records use other identifiers, keep compatibility by validating length and documenting the accepted formats instead of breaking legitimate data.

### 8.5 Duplicate validation

Reject:

- Repeated student IDs with conflicting demographic data
- Duplicate laboratory requests for one student in the same file
- Duplicate physical examination requests for one student in the same file

One student should normally appear once because both dates are stored in the same row.

If the same student appears twice with complementary dates, prefer rejecting it with a clear message directing the administrator to combine the dates into one row. This keeps the official template unambiguous.

### 8.6 Reference-data validation

Continue matching active colleges and course codes case-insensitively.

Validate that:

- College exists and is active
- Course/program exists and is active
- Course belongs to the specified college
- Year is a whole number within the supported range
- Priority group selected in the form exists and is active

### 8.7 Existing student behavior

For an existing student number:

- Do not silently overwrite the record.
- Verify parsed name components, college, program, and year.
- Return row-specific errors for mismatches.
- Normalize casing, punctuation, and repeated whitespace carefully enough to avoid false mismatches, while not hiding genuinely different identities.

For a missing student number:

- Create the student inside the same database transaction as the import group and child batches.

If any row fails, roll back the complete import. Do not leave partially created students or batches.

---

## 9. Repository and Service Refactor

### 9.1 Import creation transaction

Refactor the current imported-batch creation into one transaction that:

1. Validates the selected priority group.
2. Resolves colleges and programs.
3. Resolves existing students.
4. Collects all row errors before writing.
5. Creates the import group.
6. Creates missing students.
7. Expands each CSV row into laboratory and physical schedule items.
8. Creates up to two clinic-specific child batches.
9. Links child batches to the import group.
10. Writes one import audit record.
11. Returns the import group summary.

Suggested return shape:

```ts
type ScheduleImportResult = {
  importId: string;
  status: "DRAFT";
  totalRows: number;
  createdStudentCount: number;
  matchedStudentCount: number;
  laboratoryItemCount: number;
  physicalExaminationItemCount: number;
  batchIds: string[];
};
```

### 9.2 Group repository functions

Add repository functions similar to:

```ts
createScheduleImportGroup(...)
getScheduleImportGroup(importId)
listScheduleImportGroups(filters)
getImportChildBatches(importId)
getImportValidationSummary(importId)
```

Keep SQL inside repository files.

### 9.3 Group service functions

Add service functions similar to:

```ts
importStudentScheduleCsv(input, actor)
validateScheduleImport(importId, actor)
generateScheduleImport(importId, actor, overrideReason?)
publishScheduleImport(importId, actor)
```

All functions must enforce administrator authorization.

### 9.4 Group validation

`validateScheduleImport` should validate every child batch and return one response containing per-clinic results.

Example:

```ts
{
  importId,
  status,
  totals: {
    items,
    valid,
    warnings,
    conflicts,
  },
  clinics: {
    laboratory: { ... },
    physicalExamination: { ... },
  },
}
```

### 9.5 Group generation

Generate all applicable child batches from the grouped detail action.

Requirements:

- Validate first using existing rules.
- Preserve clinic-specific capacity calculations.
- Block non-capacity conflicts.
- Preserve administrator capacity override behavior and required override reason.
- Return a combined summary.
- Avoid duplicate active appointments.

Generation may use one surrounding database transaction if the current service structure allows it safely. At minimum, prevent the UI from reporting the import as fully generated when only one child succeeds.

### 9.6 Group publication

Implement one transaction that:

- Locks or verifies all child batches.
- Confirms each child batch is generated and publishable.
- Publishes all child appointments.
- Updates child batch statuses.
- Writes audit records.
- Returns the grouped published summary.

### 9.7 Backward compatibility

Existing ungrouped schedule batches may remain readable.

Do not require historical batches to have an import group. New master CSV imports must always have one.

---

## 10. API Routes

Recommended new routes:

```text
POST /api/schedule-imports
GET  /api/schedule-imports/[importId]
POST /api/schedule-imports/[importId]/validate
POST /api/schedule-imports/[importId]/generate
POST /api/schedule-imports/[importId]/publish
```

### 10.1 Import request

Use `multipart/form-data` with:

```text
file
importName
priorityGroupId
submittedByName
description
```

### 10.2 Authorization

Every write route must:

1. Require an authenticated user.
2. Require `role === "ADMIN"`.
3. Return a consistent 403 response when unauthorized.

### 10.3 Error responses

Preserve the existing structured error approach.

Return field errors such as:

```text
file
priorityGroupId
rows.2.Name
rows.2.Laboratory Schedule
rows.2.Physical Examination Schedule
rows.3.Course
```

### 10.4 Old import endpoint

The existing coordinator import endpoint should not remain as an unrestricted duplicate.

Choose one approach:

- Redirect/delegate it internally to the new service for compatibility, while enforcing admin access and the new format; or
- Deprecate it and update all callers and tests.

Do not support both the old and new CSV schemas indefinitely unless explicitly required.

---

## 11. Component Changes

Recommended components:

```text
src/components/students/StudentsSchedulesTabs.tsx
src/components/schedules/ScheduleImportForm.tsx
src/components/schedules/ScheduleImportHistoryTable.tsx
src/components/schedules/ScheduleImportSummary.tsx
src/components/schedules/ScheduleImportActions.tsx
src/components/schedules/ScheduleImportClinicPanel.tsx
src/components/appointments/ClinicPublishedSchedule.tsx
```

Reuse existing UI components and styling conventions.

### 11.1 Import form behavior

- Automatically derive import name from the filename.
- Allow the administrator to edit the name.
- Display the selected file.
- Disable repeat submission while pending.
- Preserve form values after a validation error.
- Display a top-level error and row-specific errors.
- Redirect to the grouped detail page after success.

### 11.2 Import detail actions

Buttons should follow the lifecycle:

```text
DRAFT -> Validate
VALIDATED -> Generate appointments
GENERATED -> Publish schedules
PUBLISHED -> View published schedules
```

Disable invalid actions and explain why they are unavailable.

### 11.3 Empty states

Students:

```text
No active students match these filters.
```

Schedule imports:

```text
No schedule CSV files have been imported yet.
```

Laboratory:

```text
No published laboratory appointments match these filters.
```

Physical examination:

```text
No published physical examination appointments match these filters.
```

---

## 12. CSV Template

Add a downloadable template:

```text
public/templates/student-schedule-import-template.csv
```

Content:

```csv
Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule
23-8200-01,"Abad, Aaron Miguel A.",College of Computer Studies,BSCS,3,07-29-2026,07-30-2026
```

Add a `Download CSV template` link to the import form and combined page.

Do not commit real private student data as a public template.

---

## 13. Clinic Schedule Queries

### 13.1 Laboratory

The Laboratory list must always apply:

```ts
clinicCode: "KABALAKA_CLINIC"
scheduleType: "LABORATORY"
isPublished: true
```

### 13.2 Physical examination

The Physical Exam list must always apply:

```ts
clinicCode: "CPU_CLINIC"
scheduleType: "PHYSICAL_EXAM"
isPublished: true
```

### 13.3 Filters

Preserve useful filters:

- Student number or name
- Appointment date
- Status
- College/program where supported

Do not expose an ordinary filter that allows clinic staff to reveal unpublished drafts in these tabs.

---

## 14. Testing Plan

Update existing tests and add coverage for the new workflow.

### 14.1 Parser unit tests

Test:

- Exact seven headers
- UTF-8 BOM
- Trimming whitespace
- Trailing blank columns accepted
- Non-empty extra columns rejected
- Correct `Last, First Middle` parsing
- Missing comma rejected
- Missing surname rejected
- Missing given name rejected
- Valid laboratory date
- Valid physical date
- One blank date allowed
- Both dates blank rejected
- Invalid date format rejected
- Impossible date rejected
- Duplicate student row rejected
- More than 500 rows rejected

### 14.2 Service integration tests

Test one CSV row with both dates:

- One student created
- One import group created
- One KABALAKA child batch created
- One CPU Clinic child batch created
- One laboratory schedule item created
- One physical examination schedule item created
- Correct target dates stored

Test multiple rows:

- Existing students matched
- Missing students created
- Counts returned correctly
- Mixed programs supported
- Transaction rolls back on any row error
- No partial students or batches remain after failure

### 14.3 Authorization tests

Test:

- Admin can import
- Clinic staff receives 403
- Anonymous user receives authentication error
- Admin can validate, generate, and publish group
- Clinic staff cannot perform grouped master-import actions

### 14.4 Publication tests

Test:

- Both child batches publish together
- Failure in one child rolls back publication of the other
- Published appointments become visible through clinic queries
- Generated but unpublished appointments remain hidden
- Public student lookup continues to expose only published appointments

### 14.5 UI tests

Test:

- Sidebar contains Students & Schedules
- Sidebar no longer contains Coordinator schedules
- Combined page shows Students and Schedule Imports views
- Import button is visible to admin
- Import button is hidden from clinic staff
- Import form sends multipart data
- New headers and errors are displayed
- Success navigates to grouped detail page
- Pending submission disables the button
- Laboratory page has no import or coordinator-schedule button
- Physical Exam page has no import or coordinator-schedule button

### 14.6 Seed and database tests

Test:

- Seed completes without demo students
- No `DEMO-%` student exists after clean seed
- Reference data remains available
- Capacity settings remain available
- Test fixtures are created independently of production seed

---

## 15. Documentation Updates

Update `README.md`:

1. Remove the Demo Fixtures section describing the 180 demo students and demo batches.
2. Replace the old CSV format with:

```csv
Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule
```

3. Explain that the workbook format should be exported as UTF-8 CSV before upload.
4. Document the combined Students & Schedules workflow.
5. Document that the administrator performs the master import and publication.
6. Document that clinic tabs display published schedules only.
7. Document the migration and demo cleanup process.
8. Update the demonstration flow:

```text
1. Sign in as administrator.
2. Open Students & Schedules.
3. Import the official CSV.
4. Review validation results.
5. Generate appointments.
6. Publish the grouped schedules.
7. Open Laboratory and verify published laboratory appointments.
8. Open Physical Exam and verify published physical examination appointments.
9. Use student lookup to verify the published student schedule.
```

---

## 16. Suggested Implementation Order

### Phase 1 — Safety and baseline

- Create a working branch.
- Run existing tests, lint, and build.
- Record existing failures before changing code.
- Inspect current migrations and choose the next migration number.

### Phase 2 — Database and seed cleanup

- Add `schedule_import_groups`.
- Add `schedule_batches.import_group_id` and indexes.
- Add narrowly scoped demo cleanup.
- Remove demo-data seed fixtures.
- Update integration-test fixture setup.

### Phase 3 — CSV parser

- Replace old Appointment Date/Type schema.
- Add dual date columns.
- Add correct comma-name parsing.
- Add trailing-empty-column normalization.
- Add parser unit tests.

### Phase 4 — Transactional import service

- Create import group.
- Resolve/create students.
- Expand each row to clinic-specific items.
- Create and link child batches.
- Return grouped summary.
- Add integration tests.

### Phase 5 — Group lifecycle services

- Add grouped read/list functions.
- Add grouped validation.
- Add grouped generation.
- Add atomic grouped publication.
- Add authorization and audit tests.

### Phase 6 — APIs

- Add schedule-import routes.
- Enforce admin access.
- Update or deprecate old import route.
- Add route tests.

### Phase 7 — Combined Students & Schedules UI

- Update sidebar.
- Refactor `/students`.
- Add import history.
- Add import form and template.
- Add grouped detail page and actions.
- Add UI tests.

### Phase 8 — Clinic tabs

- Refactor `/laboratory` to show published laboratory appointments.
- Refactor `/physical-exam` to show published physical appointments.
- Remove clinic import/batch controls.
- Add redirects for old nested routes.
- Add published-only tests.

### Phase 9 — Documentation and verification

- Update README.
- Run database migration against a populated development database.
- Verify demo cleanup does not delete non-demo students.
- Run all tests.
- Run lint.
- Run production build.
- Manually complete the end-to-end acceptance scenario.

---

## 17. Acceptance Criteria

The revision is complete only when every criterion below passes.

### Demo data

- [ ] A clean seed creates no student with a number beginning `DEMO-`.
- [ ] Existing known demo batches and demo students can be removed safely through the documented migration or cleanup.
- [ ] Clinics, references, users, priorities, and capacities still exist after seeding.

### Navigation and UX

- [ ] Sidebar contains one `Students & Schedules` entry.
- [ ] Sidebar does not contain a standalone `Coordinator schedules` entry.
- [ ] Administrator can access students and imports from the combined page.
- [ ] Clinic pages contain no CSV importer.
- [ ] Old coordinator routes redirect or remain safely readable without creating a duplicate workflow.

### CSV format

- [ ] The importer accepts the seven-column official format.
- [ ] The importer no longer requires Appointment Date or Appointment Type.
- [ ] `Abad, Aaron Miguel A.` is stored with `Abad` as the last name.
- [ ] One row with both dates creates both service requests.
- [ ] Blank optional service dates behave correctly.
- [ ] Invalid rows produce row-and-column-specific errors.
- [ ] A failed import leaves no partial student or batch records.

### Authorization

- [ ] Administrator can upload the master CSV.
- [ ] Clinic staff cannot upload the master CSV through UI or API.
- [ ] Administrator can validate, generate, and publish the grouped import.

### Group workflow

- [ ] One CSV appears as one import operation.
- [ ] The grouped detail page shows both clinic sections.
- [ ] Validation summarizes both child batches.
- [ ] Generation handles both child batches.
- [ ] Publication is atomic across all child batches.

### Published schedules

- [ ] Generated-but-unpublished laboratory appointments do not appear in Laboratory.
- [ ] Generated-but-unpublished physical appointments do not appear in Physical Exam.
- [ ] Published laboratory appointments appear in Laboratory.
- [ ] Published physical appointments appear in Physical Exam.
- [ ] Student public lookup continues to show published appointments only.

### Quality

- [ ] `npm test` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] No real student data is committed as a public template or test fixture.
- [ ] README reflects the revised workflow and CSV format.

---

## 18. Manual End-to-End Test Scenario

Use a CSV exported from the provided spreadsheet format.

1. Start with a migrated database containing reference data but no demo students.
2. Sign in as administrator.
3. Open Students & Schedules.
4. Confirm that no demo students are listed.
5. Upload the official CSV containing the seven required columns.
6. Confirm the importer reports the correct student-row count.
7. Open the grouped import detail.
8. Confirm laboratory and physical examination item counts are separated correctly.
9. Validate the import.
10. Review capacity warnings or conflicts.
11. Generate appointments.
12. Confirm the appointments are still absent from normal Laboratory and Physical Exam lists.
13. Publish the grouped import.
14. Open Laboratory and verify the laboratory schedule dates.
15. Open Physical Exam and verify the physical examination schedule dates.
16. Search for several student numbers and compare both dates with the source CSV.
17. Open the public student lookup and confirm only published appointments are visible.
18. Sign in as clinic staff and confirm the master CSV import control is unavailable.
19. Confirm clinic staff can still perform permitted operational appointment tasks.

---

## 19. Out of Scope for This Revision

Do not add these unless required to complete the described workflow:

- Direct `.xlsx` upload
- Email or SMS notifications
- QR check-in
- Doctor assignment
- AI scheduling
- Student accounts
- Student self-rescheduling
- New clinic locations
- A complete redesign of compliance or result-history modules
- Removal of required development login accounts

Focus on the unified student/import experience, correct official CSV parsing, removal of demo student fixtures, grouped publication, and published-only clinic schedule views.
