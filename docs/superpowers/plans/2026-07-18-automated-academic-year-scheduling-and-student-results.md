# Automated Academic-Year Scheduling and Student Result Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace date-driven coordinator imports with deterministic academic-year scheduling, add priority displacement and clinic-closure rescheduling, and provide a secure student portal for authenticated multi-file result submissions.

**Architecture:** Preserve the existing Next.js route-handler → service → repository → PostgreSQL layering. Keep scheduling calculations pure under `src/server/rule-engine`, make multi-table changes transactional, isolate student sessions from staff sessions, and store uploaded documents through a private storage adapter rather than in PostgreSQL.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, PostgreSQL 15+ with `pg`, Zod 4, Vitest 4, Testing Library, `jose`, Nodemailer, Archiver, Node.js filesystem streams

## Global Constraints

- CSV headers must be exactly `Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth`.
- `MI` and `Suffix` columns are present but their values may be blank.
- Both clinics schedule Monday–Friday only.
- Appointments are date-only. Remove `appointment_time` and every time-slot consumer.
- Laboratory is scheduled first at KABALAKA Clinic; PE uses the earliest later eligible CPU Clinic date.
- Newly accepted batches require seven calendar days of preparation notice. Automatic replacements do not.
- Regular schedules normally start in August and continue through March, then overflow into April and later months.
- OJT, Tour, and Specialized share one equal-priority FCFS tier above Regular.
- Queue order is immutable `accepted_at`, then CSV row order, then Student Number.
- Priority imports may displace eligible published future Regular appointments already shown to students.
- Never automatically move same-day, past, completed, no-show, cancelled, already-rescheduled, manually locked, or finalized-result appointments.
- A CPU Clinic closure moves PE only. A KABALAKA Clinic closure moves Laboratory and PE as a new pair.
- Students authenticate separately using Student Number and Date of Birth.
- Email setup is optional and notification-only.
- Result upload unlocks only after clinic staff marks the matching appointment `COMPLETED`.
- Per result: PDF/JPG/JPEG/PNG only, at most 10 files, at most 20 MB each, and at most 50 MB total.
- Drafts expire after seven inactive days without warning.
- Final submission immediately marks the result `COMPLETED` and locks student changes.
- Students can access only their own files. Administrators can access all files and generate file-only ZIP archives. Clinic staff and coordinators cannot access documents.
- Portal notifications are mandatory for schedule changes and invalidations. Email failure must not roll back business transactions.
- Use `APP_TIMEZONE=Asia/Manila` for date boundaries.
- Use TDD and commit after every task.

---

### Task 1: Add the additive database foundation

**Files:**
- Create: `database/migrations/008_automated_scheduling_and_student_portal.sql`
- Modify: `src/server/db/database.integration.test.ts`
- Modify: `src/test/integration-fixtures.ts`

**Interfaces:** Adds the schema required by all later tasks while retaining `appointment_time` temporarily.

- [ ] **Step 1: Write failing schema tests**

Assert these additions exist:

```ts
expect(await columnExists("students", "date_of_birth")).toBe(true);
expect(await columnExists("schedule_import_groups", "student_category")).toBe(true);
expect(await columnExists("schedule_import_groups", "accepted_at")).toBe(true);
expect(await columnExists("coordinator_schedule_items", "source_row_order")).toBe(true);
expect(await columnExists("appointments", "schedule_pair_id")).toBe(true);
expect(await tableExists("clinic_unavailable_dates")).toBe(true);
expect(await tableExists("student_result_submissions")).toBe(true);
expect(await tableExists("student_result_files")).toBe(true);
expect(await tableExists("student_portal_notifications")).toBe(true);
expect(await tableExists("email_outbox")).toBe(true);
```

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/db/database.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because migration 008 is missing.

- [ ] **Step 3: Implement migration 008**

Add:

```sql
ALTER TABLE students
  ADD COLUMN date_of_birth DATE,
  ADD COLUMN email VARCHAR(254),
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD CONSTRAINT students_birth_date_reasonable
    CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01');

ALTER TABLE schedule_import_groups
  ADD COLUMN student_category VARCHAR(30)
    CHECK (student_category IN ('REGULAR','OJT','TOUR','SPECIALIZED')),
  ADD COLUMN academic_year_start INTEGER,
  ADD COLUMN preferred_month INTEGER CHECK (preferred_month BETWEEN 1 AND 12),
  ADD COLUMN accepted_at TIMESTAMPTZ;

ALTER TABLE coordinator_schedule_items
  ADD COLUMN source_row_order INTEGER CHECK (source_row_order > 0),
  ADD COLUMN schedule_cycle_start INTEGER;

ALTER TABLE appointments
  ADD COLUMN schedule_pair_id UUID,
  ADD COLUMN is_manually_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN locked_by UUID REFERENCES users(id),
  ADD COLUMN locked_at TIMESTAMPTZ,
  ADD COLUMN lock_reason TEXT;
```

Create tables for clinic unavailable dates, student login attempts, student email verification, portal notifications, email outbox, result submissions, and result files. Use partial unique indexes so each appointment has at most one `DRAFT` and one `FINALIZED` submission. Add `storage_delete_pending`, `delete_error`, and `deleted_at` to result files for retryable deletion.

Extend exam/laboratory result status checks to include `PENDING_UPLOAD`; migrate existing `PENDING` values to `PENDING_UPLOAD`.

- [ ] **Step 4: Apply and verify GREEN**

```powershell
npm run db:migrate
npm test -- "src/server/db/database.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 5: Commit**

```powershell
git add database/migrations/008_automated_scheduling_and_student_portal.sql src/server/db/database.integration.test.ts src/test/integration-fixtures.ts
git commit -m "feat: add automated scheduling schema"
```

---

### Task 2: Replace the CSV parser and student upsert contract

**Files:**
- Create: `src/server/services/student-import-csv.ts`
- Create: `src/server/services/student-import-csv.test.ts`
- Modify: `src/server/services/schedule-imports.service.ts`
- Modify: `src/server/repositories/schedule-imports.repository.ts`
- Modify: `src/server/services/schedule-imports.integration.test.ts`
- Modify: `src/components/students/StudentForm.tsx`
- Modify: `src/server/services/students.service.ts`
- Modify: `src/server/repositories/students.repository.ts`
- Replace: `public/templates/student-schedule-import-template.csv`
- Delete: `src/server/services/student-schedule-import-csv.ts`

**Interfaces:** Produces `parseStudentImportCsv(input): ImportedStudentRow[]`.

- [ ] **Step 1: Write failing parser/upsert tests**

Use:

```ts
export type ImportedStudentRow = {
  rowNumber: number;
  studentNumber: string;
  surname: string;
  firstName: string;
  middleInitial: string | null;
  suffix: string | null;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  dateOfBirth: string;
};
```

Test exact headers, blank MI/Suffix, strict `MM-DD-YYYY` DOB conversion from the approved workbook, impossible/future dates, duplicates, unknown references, and atomic rollback. Test that an existing student's demographics update while existing same-cycle appointments remain unchanged.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/student-import-csv.test.ts" "src/server/services/schedule-imports.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement parser and metadata schema**

```ts
const EXPECTED_HEADERS = [
  "Student ID", "Surname", "First Name", "MI", "Suffix",
  "College", "Course", "Year", "Date of Birth",
] as const;
```

Add import metadata:

```ts
const metadataSchema = z.object({
  studentCategory: z.enum(["REGULAR", "OJT", "TOUR", "SPECIALIZED"]),
  academicYearStart: z.coerce.number().int().min(2020).max(2100),
  preferredMonth: z.union([z.coerce.number().int().min(1).max(12), z.literal(""), z.null()])
    .transform((value) => value === "" ? null : value),
});
```

Require a preferred month only for non-Regular categories.

- [ ] **Step 4: Implement transactional student upsert**

Use `INSERT ... ON CONFLICT (student_number) DO UPDATE` for name, college, program, year, suffix, middle name/initial, and DOB. Before creating schedule items, check whether the student already has a pair for the selected academic-year cycle. If yes, update demographics but preserve schedule/history and skip a new request.

Update manual administrator student forms to collect DOB. Existing null-DOB rows remain readable but cannot use student login until imported/edited.

Replace the template with:

```csv
Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth
23-1212-97,Abad,Aaron Miguel,A.,,College of Computer Studies,BSIT,3,08-04-2004
```

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/services/student-import-csv.test.ts" "src/server/services/schedule-imports.integration.test.ts" --maxWorkers=1 --no-file-parallelism
git add -A
git commit -m "feat: import student demographics for scheduling"
```

---

### Task 3: Implement scheduling windows and paired allocation

**Files:**
- Create: `src/server/services/scheduling-window.ts`
- Create: `src/server/services/scheduling-window.test.ts`
- Create: `src/server/rule-engine/generate-paired-schedule.ts`
- Create: `src/server/rule-engine/generate-paired-schedule.test.ts`
- Modify: `src/server/rule-engine/index.ts`
- Modify: `src/server/rule-engine/types.ts`

**Interfaces:** Produces `resolveSchedulingWindow()` and pure `generatePairedSchedule()`.

- [ ] **Step 1: Write failing pure tests**

Cover pre-August Regular imports, seven-day notice, selected priority month, Friday Lab → Monday PE, blocked dates, capacity overflow across months, Regular overflow past March, pair atomicity, and deterministic ordering.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/scheduling-window.test.ts" "src/server/rule-engine/generate-paired-schedule.test.ts"
```

- [ ] **Step 3: Implement window resolution**

```ts
export type SchedulingWindowInput = {
  category: "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";
  academicYearStart: number;
  preferredMonth: number | null;
  acceptedAt: string;
  timeZone: string;
};
```

Calculate `acceptedAt + 7 calendar days` in `Asia/Manila`. For Regular, compare it with August 1 of the academic year. For priority categories, compare it with the first day of the selected month resolved inside the academic year. Advance to the next Monday–Friday date.

- [ ] **Step 4: Implement the pure pair allocator**

Sort by tier, `acceptedAt`, row order, then student number. For each request, find the first eligible Laboratory date and then the earliest strictly later PE date. Increment loads only when both dates are found.

```ts
export type PairedAssignment = {
  requestId: string;
  studentNumber: string;
  schedulePairId: string;
  laboratoryDate: string;
  physicalExamDate: string;
};
```

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/services/scheduling-window.test.ts" "src/server/rule-engine/generate-paired-schedule.test.ts"
git add src/server/services/scheduling-window* src/server/rule-engine
git commit -m "feat: allocate paired academic-year schedules"
```

---

### Task 4: Serialize FCFS acceptance and publish generated pairs

**Files:**
- Modify: `src/server/repositories/schedule-imports.repository.ts`
- Modify: `src/server/services/schedule-imports.service.ts`
- Modify: `src/server/services/schedule-import-lifecycle.integration.test.ts`
- Modify: `src/server/services/schedule-import-detail.integration.test.ts`
- Modify: `src/app/api/schedule-imports/route.ts`
- Modify: `src/app/api/schedule-imports/route.test.ts`

**Interfaces:** Produces `acceptAndScheduleImport(input, actor)`.

- [ ] **Step 1: Write failing lifecycle/concurrency tests**

Run simultaneous imports and assert ordering follows committed `accepted_at`. Assert each new student gets one shared `schedule_pair_id`, Lab precedes PE, and both appointments publish together.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/schedule-import-lifecycle.integration.test.ts" "src/app/api/schedule-imports/route.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Serialize acceptance**

Inside the import transaction:

```ts
await client.query(`SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))`);
const accepted = await client.query<{ acceptedAt: Date }>(
  `SELECT clock_timestamp() AS "acceptedAt"`,
);
```

Persist `accepted_at` once. Read load, blocked dates, and queue state under the same transaction. Insert schedule items with source row order, generate pairs, create appointments, and publish atomically.

- [ ] **Step 4: Update route input/result**

Submit `studentCategory`, `academicYearStart`, `preferredMonth`, and file. Return inserted/updated/skipped counts, published appointments, generated date range, and overflow summary.

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/services/schedule-import-lifecycle.integration.test.ts" "src/server/services/schedule-import-detail.integration.test.ts" "src/app/api/schedule-imports/route.test.ts" --maxWorkers=1 --no-file-parallelism
git add -A
git commit -m "feat: publish fcfs academic-year imports"
```

---

### Task 5: Add minimal priority displacement

**Files:**
- Create: `src/server/services/priority-displacement.service.ts`
- Create: `src/server/services/priority-displacement.integration.test.ts`
- Create: `src/server/repositories/priority-displacement.repository.ts`
- Modify: `src/server/services/schedule-imports.service.ts`
- Modify: `src/server/repositories/appointments.repository.ts`

**Interfaces:** Produces `makeCapacityForPriorityBatch(input, client)`.

- [ ] **Step 1: Write failing displacement tests**

Assert priority imports can take capacity from eligible published Regular pairs, only the minimum required students move, original records become `RESCHEDULED`, replacements publish immediately, and Regular FCFS order is preserved. Assert protected appointments never move.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/priority-displacement.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement locked candidate selection**

Use the current Manila date. Select only future `PENDING`, unlocked Regular pairs without finalized submissions. Lock candidates with `FOR UPDATE SKIP LOCKED`. Choose the minimum number needed, preferring later Regular queue commitments for displacement, then reschedule selected students in ascending original FCFS order.

- [ ] **Step 4: Persist replacement history**

Keep originals, create published replacements linked by `rescheduled_from`, audit the causing priority import and old/new dates, and emit notification events.

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/services/priority-displacement.integration.test.ts" "src/server/services/schedule-import-lifecycle.integration.test.ts" --maxWorkers=1 --no-file-parallelism
git add -A
git commit -m "feat: displace regular schedules for priority imports"
```

---

### Task 6: Add clinic unavailable dates and remove appointment times

**Files:**
- Create: `src/server/repositories/clinic-unavailable-dates.repository.ts`
- Create: `src/server/services/clinic-calendar.service.ts`
- Create: `src/server/services/clinic-calendar.integration.test.ts`
- Create: `src/app/api/clinic-unavailable-dates/route.ts`
- Create: `src/app/api/clinic-unavailable-dates/route.test.ts`
- Create: `database/migrations/009_remove_appointment_times.sql`
- Modify every active `appointmentTime`/`appointment_time` consumer

**Interfaces:** Produces admin-only clinic blocking with automatic replacement behavior.

- [ ] **Step 1: Write failing closure tests**

Test overlapping ranges, CPU closure moving PE only, KABALAKA closure moving the full pair, protected appointments reported unresolved, and admin-only API authorization.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/clinic-calendar.integration.test.ts" "src/app/api/clinic-unavailable-dates/route.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement closure workflow**

Validate clinic, date range, reason, and category. In one transaction insert the block, lock affected future appointments, apply the approved move rule, publish replacements, and write audits/notifications.

- [ ] **Step 4: Remove appointment times**

After all consumers are date-only:

```sql
ALTER TABLE appointments DROP COLUMN appointment_time;
```

Run:

```powershell
git grep -n "appointmentTime\|appointment_time\|Appointment time\|Time slot"
```

Expected: no active application references.

- [ ] **Step 5: Test/build/commit**

```powershell
npm run db:migrate
npm test -- "src/server/services/clinic-calendar.integration.test.ts" "src/server/repositories/appointment-no-show.integration.test.ts" --maxWorkers=1 --no-file-parallelism
npm run build
git add -A
git commit -m "feat: manage clinic closures with date-only schedules"
```

---

### Task 7: Update coordinator and administrator scheduling UI

**Files:**
- Modify: `src/components/schedules/ScheduleImportForm.tsx`
- Modify: `src/components/schedules/ScheduleImportForm.test.tsx`
- Modify: `src/app/(dashboard)/students/schedule-imports/new/page.tsx`
- Modify: `src/app/(dashboard)/students/schedule-imports/[importId]/page.tsx`
- Modify: `src/components/schedules/ScheduleImportHistoryTable.tsx`
- Create: `src/components/settings/ClinicUnavailableDateForm.tsx`
- Create: `src/components/settings/ClinicUnavailableDateForm.test.tsx`
- Create: `src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert exact new headers, category selector, academic-year selector, conditional preferred-month selector, seven-day notice copy, and removal of CSV schedule-date instructions. Test the closure confirmation and moved/unresolved result summary.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/components/schedules/ScheduleImportForm.test.tsx" "src/components/settings/ClinicUnavailableDateForm.test.tsx"
```

- [ ] **Step 3: Implement import UI**

Regular hides/clears preferred month. OJT/Tour/Specialized require it. Detail/history views show category, accepted timestamp, generated range, overflow, updated/skipped students, and displacement counts.

- [ ] **Step 4: Implement closure UI**

Admin selects clinic, one date/range, category, and reason, then confirms automatic rescheduling impact.

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/components/schedules/ScheduleImportForm.test.tsx" "src/components/settings/ClinicUnavailableDateForm.test.tsx"
npm run lint
git add -A
git commit -m "feat: update automated scheduling controls"
```

---

### Task 8: Add separate student authentication and portal schedules

**Files:**
- Create: `src/server/auth/student-session.ts`
- Create: `src/server/auth/student-session.test.ts`
- Create: `src/server/auth/current-student.ts`
- Create: `src/server/repositories/student-auth.repository.ts`
- Create: `src/server/services/student-auth.service.ts`
- Create: `src/server/services/student-auth.integration.test.ts`
- Create: `src/app/api/student-auth/login/route.ts`
- Create: `src/app/api/student-auth/logout/route.ts`
- Create: `src/app/(student)/student/login/page.tsx`
- Create: `src/app/(student)/student/layout.tsx`
- Create: `src/app/(student)/student/page.tsx`
- Create: `src/server/repositories/student-portal.repository.ts`
- Modify: `src/proxy.ts`

**Interfaces:** Produces `medclinic_student_session` and `requireStudent()`.

- [ ] **Step 1: Write failing authentication/ownership tests**

Test correct Student Number/DOB, generic invalid errors, inactive/missing-DOB rejection, rate limiting, staff/student cookie separation, and strict own-record queries.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/auth/student-session.test.ts" "src/server/services/student-auth.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement student JWT and throttling**

```ts
export const STUDENT_SESSION_COOKIE = "medclinic_student_session";
export type StudentSession = { studentNumber: string; sessionType: "STUDENT" };
```

Lock for 15 minutes after five failed attempts per Student Number/IP pair. Never put DOB in the token.

- [ ] **Step 4: Implement portal schedule access**

Protect `/student` except `/student/login`. Revalidate active student in the layout. Show published date-only Lab/PE schedules and reschedule history using only the session Student Number.

- [ ] **Step 5: Test/build/commit**

```powershell
npm test -- "src/server/auth/student-session.test.ts" "src/server/services/student-auth.integration.test.ts" --maxWorkers=1 --no-file-parallelism
npm run build
git add -A
git commit -m "feat: add student authentication portal"
```

---

### Task 9: Add optional email verification and notifications

**Files:**
- Modify: `package.json`, `package-lock.json`, `.env.example`, `src/lib/env.ts`
- Create: `src/server/repositories/student-notifications.repository.ts`
- Create: `src/server/services/student-notifications.service.ts`
- Create: `src/server/services/student-email.service.ts`
- Create: `src/server/services/student-email.integration.test.ts`
- Create: `src/app/api/student/email/request-verification/route.ts`
- Create: `src/app/api/student/email/verify/route.ts`
- Create: `src/app/api/student/notifications/route.ts`
- Create: `src/app/(student)/student/notifications/page.tsx`
- Modify displacement/closure services

- [ ] **Step 1: Install Nodemailer and write failing tests**

```powershell
npm install nodemailer
npm install -D @types/nodemailer
```

Assert portal notification is always created, outbox is created only for verified email, schedule transactions survive email failures, verification stores only token hashes, and prior verified email remains active until replacement verification.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/student-email.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement notification/outbox creation**

Create portal notification in the business transaction; enqueue email only when a verified address exists. Use 32 random token bytes, SHA-256 storage, and 30-minute expiry.

- [ ] **Step 4: Implement optional portal UI**

Show a dismissible verification reminder, request/verify flows, unread count, and notification list. Never block schedules or uploads.

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/services/student-email.integration.test.ts" "src/server/services/priority-displacement.integration.test.ts" "src/server/services/clinic-calendar.integration.test.ts" --maxWorkers=1 --no-file-parallelism
git add -A
git commit -m "feat: notify students of schedule changes"
```

---

### Task 10: Implement private gradual result drafts

**Files:**
- Modify: `.env.example`, `src/lib/env.ts`
- Create: `src/server/storage/result-storage.ts`
- Create: `src/server/storage/local-result-storage.ts`
- Create: `src/server/files/result-file-validation.ts`
- Create tests for both
- Create: `src/server/repositories/student-result-submissions.repository.ts`
- Create: `src/server/services/student-result-submissions.service.ts`
- Create: `src/server/services/student-result-submissions.integration.test.ts`
- Create draft/file API routes under `src/app/api/student/result-submissions/`
- Create: `src/components/student-results/ResultDraftManager.tsx`
- Create: `src/app/(student)/student/results/[appointmentId]/page.tsx`

- [ ] **Step 1: Write failing policy/draft tests**

Test PDF/JPEG/PNG signatures, mismatched extension/MIME, 20 MB file limit, 10 files, 50 MB total, appointment ownership, `COMPLETED` requirement, draft resume/remove, and rollback when metadata fails.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/files/result-file-validation.test.ts" "src/server/storage/local-result-storage.test.ts" "src/server/services/student-result-submissions.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement private storage**

Add `RESULT_UPLOAD_ROOT=.data/private-result-uploads`. Generate keys as `${submissionId}/${uuid}.${extension}`. Write temporary files then atomically rename. Never use original filename in paths.

- [ ] **Step 4: Implement draft routes/UI**

Each route calls `requireStudent()`. Add/remove one file at a time, lock aggregate limits, retain draft for resume, and show count/individual/total sizes plus seven-day inactivity policy.

- [ ] **Step 5: Test and commit**

```powershell
npm test -- "src/server/files/result-file-validation.test.ts" "src/server/storage/local-result-storage.test.ts" "src/server/services/student-result-submissions.integration.test.ts" --maxWorkers=1 --no-file-parallelism
git add -A
git commit -m "feat: add private result submission drafts"
```

---

### Task 11: Finalize, download, ZIP, and invalidate submissions

**Files:**
- Install `archiver` and types
- Modify submission service/repository/tests
- Create student/admin download routes
- Create admin ZIP and invalidation routes
- Create admin submission component/page

- [ ] **Step 1: Install and write failing lifecycle/access tests**

```powershell
npm install archiver
npm install -D @types/archiver
```

Test atomic finalization, automatic result completion, student mutation lock, own-file access, cross-student denial, clinic/coordinator denial, admin individual/ZIP access, mandatory invalidation reason, result reset to `PENDING_UPLOAD`, appointment remaining `COMPLETED`, and replacement-draft access.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/services/student-result-submissions.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement atomic finalization**

Lock the draft/files and revalidate all limits and appointment ownership/status. Set submission `FINALIZED`, set result `COMPLETED`, leave `encoded_by=NULL`, and audit file count/bytes without storing content or DOB.

- [ ] **Step 4: Implement access, ZIP, and invalidation**

Student file queries constrain file ID and session Student Number. Admin routes require `ADMIN`. ZIP streams on demand and includes uploaded files only; prefix duplicate-safe entry names with sequence numbers. Invalidation first makes metadata inaccessible, resets result to `PENDING_UPLOAD`, creates audit/notification, then deletes files with retry markers.

- [ ] **Step 5: Test/build/commit**

```powershell
npm test -- "src/server/services/student-result-submissions.integration.test.ts" --maxWorkers=1 --no-file-parallelism
npm run build
git add -A
git commit -m "feat: finalize and administer student results"
```

---

### Task 12: Add draft cleanup and email delivery workers

**Files:**
- Create result-draft cleanup worker/test
- Create email-outbox repository/service/worker/test
- Modify `src/instrumentation.ts`, its test, `.env.example`, and `src/lib/env.ts`

- [ ] **Step 1: Write failing worker tests**

Test expiration exactly after seven inactive days, activity reset, finalized immunity, idempotency, delete retries, concurrent email claiming, SMTP success, exponential retry, and permanent failure after ten attempts.

- [ ] **Step 2: Verify RED**

```powershell
npm test -- "src/server/workers/result-draft-cleanup.worker.test.ts" "src/server/workers/email-outbox.worker.test.ts" "src/instrumentation.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Implement workers**

Add SMTP environment variables. Claim email rows using `FOR UPDATE SKIP LOCKED`. Use bounded exponential retry. Run cleanup at startup/daily and email delivery at startup/every minute. Call `unref()` on timers.

- [ ] **Step 4: Register all Node workers**

Keep the existing automatic no-show worker and add cleanup/email workers only when `NEXT_RUNTIME=nodejs`.

- [ ] **Step 5: Test/build/commit**

```powershell
npm test -- "src/server/workers/result-draft-cleanup.worker.test.ts" "src/server/workers/email-outbox.worker.test.ts" "src/instrumentation.test.ts" --maxWorkers=1 --no-file-parallelism
npm run build
git add -A
git commit -m "feat: clean drafts and deliver notifications"
```

---

### Task 13: Complete end-to-end verification and documentation

**Files:**
- Create: `src/test/automated-scheduling-student-portal.e2e.integration.test.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Update fixtures/snapshots exposed by the full suite

- [ ] **Step 1: Write one complete database-backed scenario**

The test must import a future Regular batch, verify August/seven-day scheduling, import a later priority batch and verify Regular displacement, block CPU and KABALAKA dates using their respective move rules, log in as a student, complete an appointment as clinic staff, build/finalize a multi-file draft, verify access controls/ZIP, invalidate as admin, and verify replacement upload reopens.

- [ ] **Step 2: Run the E2E scenario**

```powershell
npm test -- "src/test/automated-scheduling-student-portal.e2e.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

- [ ] **Step 3: Update documentation**

Replace the old seven-column CSV and demonstration flow. Document student login, optional email verification, private storage permissions, SMTP variables, clinic unavailable dates, date-only appointments, upload limits, draft expiry, and administrator-only access to other students' medical documents. Remove statements saying students do not authenticate or holidays/notifications are out of scope.

- [ ] **Step 4: Run the release gate**

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism
npm run lint
npm run build
git grep -n "Laboratory Schedule,Physical Examination Schedule\|appointment_time\|appointmentTime\|Students do not authenticate"
```

Expected: tests, lint, and build pass; grep shows no active application/documentation references except intentional historical migrations/specs/plans.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "docs: verify automated scheduling rollout"
```

---

## Execution Order and Review Gates

1. Tasks 1–4 establish schema, parser, paired allocation, and serialized FCFS imports.
2. Tasks 5–7 add priority displacement, clinic closures, date-only migration, and staff UI.
3. Tasks 8–9 add student identity, optional email verification, and notifications.
4. Tasks 10–12 add private result storage, finalization, access control, and workers.
5. Task 13 is the full release gate.

Use an isolated worktree before implementation. Review each task commit before continuing. Preserve `docs/superpowers/specs/2026-07-18-automated-academic-year-scheduling-and-student-results-design.md` as the source of truth.