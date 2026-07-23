# Attendance-Based Appointments and Unified Student Result Submissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Appointments tab report clinic attendance independently from document uploads, and replace duplicate appointment-level administrator submission cards with one lifetime student result profile containing separate current Laboratory and Physical Exam sections plus history.

**Architecture:** Preserve appointment-level submissions and all existing mutation, privacy, audit, storage, and integrity safeguards. Add one shared SQL current-effective-appointment read model, use it in the attendance summary and administrator result-profile queries, aggregate result profiles at read time, and keep all submission mutations addressed by immutable submission and file IDs.

**Tech Stack:** Next.js 16.2.6 App Router, React 19.2.4, TypeScript 5, Tailwind CSS 4, PostgreSQL via `pg`, Zod 4.4.3, Vitest 4.1.8, Testing Library.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-23-appointments-and-unified-result-submissions-design.md` exactly.
- Appointment attendance and student result-document submission are separate sources of truth.
- The Appointments page may show only `COMPLETE` or `INCOMPLETE` as overall attendance status.
- The service attendance statuses are exactly `UNSCHEDULED`, `PENDING`, `COMPLETED`, `NO_SHOW`, `RESCHEDULED`, and `CANCELLED`.
- `UNSCHEDULED` is a read-model value only; do not add it to the database appointment-status constraint.
- A current effective appointment is the newest published, non-draft leaf appointment for the student and schedule type, ordered by appointment date descending, creation timestamp descending, then appointment ID descending.
- A published replacement appointment supersedes its `RESCHEDULED` predecessor; an unresolved rescheduled appointment with no published replacement remains visible.
- Keep one database submission per appointment and result type. Do not merge Laboratory and Physical Exam submissions and do not create a mutable student-profile table.
- Administrator profile cards are grouped by student before pagination.
- Draft-only result activity remains private and does not place a student in the administrator list.
- Current submission progress is based only on submissions linked to the latest effective Laboratory and Physical Exam appointments.
- Preserve administrator-only document access, individual and ZIP download auditing, file integrity verification, and reason-required invalidation.
- Invalidated files remain unavailable for download after storage cleanup; invalidated metadata, dates, and reasons remain visible.
- Use TDD: add a focused failing test before every production behavior change.
- Run focused tests after each task, then run database migration, the complete test suite, lint, and production build before completion.

---

## File Structure

### New files

- `src/server/repositories/current-effective-appointments.repository.ts` — shared status types, reusable SQL CTE, and direct student resolver.
- `src/server/repositories/current-effective-appointments.integration.test.ts` — replacement-chain, latest-cycle, unpublished, unresolved-reschedule, and unscheduled tests.
- `database/migrations/011_current_appointment_and_submission_read_indexes.sql` — targeted partial indexes for the new read models.
- `src/server/student-results/admin-student-result-profile.ts` — pure administrator profile types and state/progress calculation.
- `src/server/student-results/admin-student-result-profile.test.ts` — pure current-state and combined-progress tests.
- `src/server/repositories/student-result-submission-profiles.integration.test.ts` — grouped list, current appointment, replacement submission, and history query tests.
- `src/components/admin-results/submission-status.ts` — administrator submission labels, badge tones, byte formatting, and date formatting.
- `src/components/admin-results/submission-status.test.ts` — label, tone, and formatting tests.
- `src/components/admin-results/student-result-submission-pagination.ts` — page-size constant and strict page parser.
- `src/components/admin-results/StudentResultSubmissionPagination.tsx` — grouped student-list pagination UI.
- `src/app/(dashboard)/settings/student-result-submissions/page.test.tsx` — one-card-per-student list-page tests.
- `src/components/admin-results/StudentResultSection.tsx` — reusable current Laboratory or Physical Exam result section.
- `src/components/admin-results/SubmissionHistory.tsx` — older finalized and invalidated submission history.
- `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.tsx` — canonical unified lifetime student result page.
- `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx` — unified page rendering and authorization-boundary tests.
- `src/app/(dashboard)/settings/student-result-submissions/[submissionId]/page.test.tsx` — compatibility redirect tests.
- `src/app/api/admin/student-result-submissions/route.test.ts` — grouped list API contract test.

### Modified files

- `src/components/appointments/appointment-summary.ts`
- `src/components/appointments/status-labels.ts`
- `src/components/appointments/status-labels.test.ts`
- `src/server/repositories/appointment-summary.repository.ts`
- `src/server/repositories/appointment-summary.repository.test.ts`
- `src/server/repositories/appointment-summary.integration.test.ts`
- `src/app/(dashboard)/appointments/page.tsx`
- `src/app/(dashboard)/appointments/page.test.tsx`
- `src/server/repositories/student-result-submissions.repository.ts`
- `src/server/services/student-result-submissions.service.ts`
- `src/server/services/student-result-submissions.integration.test.ts`
- `src/app/(dashboard)/settings/student-result-submissions/page.tsx`
- `src/app/(dashboard)/settings/student-result-submissions/[submissionId]/page.tsx`
- `src/app/api/admin/student-result-submissions/route.ts`
- `src/components/admin-results/AdminSubmissionActions.tsx`
- `src/components/admin-results/AdminSubmissionActions.test.tsx`
- `src/server/db/database.integration.test.ts`
- `src/test/automated-scheduling-student-portal.e2e.integration.test.ts`

---

### Task 1: Add the shared current-effective-appointment read model and indexes

**Files:**
- Create: `src/server/repositories/current-effective-appointments.repository.ts`
- Create: `src/server/repositories/current-effective-appointments.integration.test.ts`
- Create: `database/migrations/011_current_appointment_and_submission_read_indexes.sql`
- Modify: `src/server/db/database.integration.test.ts`

**Interfaces:**
- Produces: `CURRENT_EFFECTIVE_APPOINTMENTS_CTE: string` containing CTE names `published_leaf_appointments`, `ranked_effective_appointments`, and `current_effective_appointments`.
- Produces: `OperationalAttendanceStatus = "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED"`.
- Produces: `AttendanceStatus = OperationalAttendanceStatus | "UNSCHEDULED"`.
- Produces: `ScheduleType = "LABORATORY" | "PHYSICAL_EXAM"`.
- Produces: `getCurrentEffectiveAppointmentsForStudent(studentNumber: string): Promise<{ laboratory: CurrentEffectiveAppointment | null; physicalExam: CurrentEffectiveAppointment | null }>`.
- Consumers in later tasks must prepend `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE},` before their own CTEs.

- [ ] **Step 1: Write the failing current-effective-appointment integration tests**

Create fixtures for one student with an old completed Laboratory appointment, a rescheduled Laboratory appointment with a published pending replacement, an unpublished later Laboratory appointment, and an unresolved rescheduled Physical Exam appointment. Add a second student with no appointments.

```ts
const resolved = await getCurrentEffectiveAppointmentsForStudent("TEST-CURRENT-0001");
expect(resolved.laboratory).toMatchObject({
  id: replacementId,
  scheduleType: "LABORATORY",
  appointmentDate: "2046-08-20",
  status: "PENDING",
});
expect(resolved.physicalExam).toMatchObject({
  id: unresolvedPhysicalId,
  scheduleType: "PHYSICAL_EXAM",
  status: "RESCHEDULED",
});

await expect(getCurrentEffectiveAppointmentsForStudent("TEST-CURRENT-0002"))
  .resolves.toEqual({ laboratory: null, physicalExam: null });
```

Also assert that a newer published cycle supersedes an older completed leaf even when the older appointment has results.

- [ ] **Step 2: Run the focused integration test and verify RED**

```bash
npm test -- src/server/repositories/current-effective-appointments.integration.test.ts
```

Expected: FAIL because the module and resolver do not exist.

- [ ] **Step 3: Implement the shared CTE and direct resolver**

Create the repository with this exact query contract:

```ts
import "server-only";
import { query } from "@/server/db/pool";

export type ScheduleType = "LABORATORY" | "PHYSICAL_EXAM";
export type OperationalAttendanceStatus =
  | "PENDING"
  | "COMPLETED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "CANCELLED";
export type AttendanceStatus = OperationalAttendanceStatus | "UNSCHEDULED";

export type CurrentEffectiveAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: ScheduleType;
  appointmentDate: string;
  status: OperationalAttendanceStatus;
  createdAt: Date;
};

export const CURRENT_EFFECTIVE_APPOINTMENTS_CTE = `
  published_leaf_appointments AS (
    SELECT appointment.id,
           appointment.student_number AS "studentNumber",
           appointment.schedule_type AS "scheduleType",
           appointment.appointment_date,
           appointment.status,
           appointment.created_at
      FROM appointments appointment
     WHERE appointment.is_published=TRUE
       AND appointment.status<>'DRAFT'
       AND NOT EXISTS (
         SELECT 1
           FROM appointments replacement
          WHERE replacement.rescheduled_from=appointment.id
            AND replacement.is_published=TRUE
            AND replacement.status<>'DRAFT'
       )
  ),
  ranked_effective_appointments AS (
    SELECT leaf.*,
           ROW_NUMBER() OVER (
             PARTITION BY leaf."studentNumber", leaf."scheduleType"
             ORDER BY leaf.appointment_date DESC, leaf.created_at DESC, leaf.id DESC
           ) AS effective_rank
      FROM published_leaf_appointments leaf
  ),
  current_effective_appointments AS (
    SELECT id, "studentNumber", "scheduleType", appointment_date, status, created_at
      FROM ranked_effective_appointments
     WHERE effective_rank=1
  )`;

export async function getCurrentEffectiveAppointmentsForStudent(studentNumber: string) {
  const result = await query<CurrentEffectiveAppointment>(
    `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE}
     SELECT id, "studentNumber", "scheduleType",
            appointment_date::text AS "appointmentDate", status,
            created_at AS "createdAt"
       FROM current_effective_appointments
      WHERE "studentNumber"=$1
      ORDER BY "scheduleType"`,
    [studentNumber],
  );
  return {
    laboratory: result.rows.find((row) => row.scheduleType === "LABORATORY") ?? null,
    physicalExam: result.rows.find((row) => row.scheduleType === "PHYSICAL_EXAM") ?? null,
  };
}
```

- [ ] **Step 4: Add targeted indexes through migration 011**

Create the migration with no schema or data rewrite:

```sql
BEGIN;

CREATE INDEX IF NOT EXISTS appointments_current_service_lookup_idx
  ON appointments (
    student_number,
    schedule_type,
    appointment_date DESC,
    created_at DESC,
    id DESC
  )
  WHERE is_published = TRUE AND status <> 'DRAFT';

CREATE INDEX IF NOT EXISTS student_result_submissions_admin_profile_idx
  ON student_result_submissions (
    student_number,
    appointment_id,
    last_activity_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE status IN ('FINALIZED', 'INVALIDATED');

COMMIT;
```

Do not add a second `rescheduled_from` index because the existing `UNIQUE (rescheduled_from)` constraint already creates one.

- [ ] **Step 5: Add failing then passing database index assertions**

Extend `database.integration.test.ts` with:

```ts
const indexes = await pool.query<{ indexname: string; indexdef: string }>(
  `SELECT indexname, indexdef
     FROM pg_indexes
    WHERE schemaname='public'
      AND indexname IN (
        'appointments_current_service_lookup_idx',
        'student_result_submissions_admin_profile_idx'
      )
    ORDER BY indexname`,
);
expect(indexes.rows).toEqual([
  expect.objectContaining({
    indexname: "appointments_current_service_lookup_idx",
    indexdef: expect.stringContaining("student_number, schedule_type, appointment_date DESC"),
  }),
  expect.objectContaining({
    indexname: "student_result_submissions_admin_profile_idx",
    indexdef: expect.stringContaining("student_number, appointment_id, last_activity_at DESC"),
  }),
]);
```

Run the assertion before migration and confirm it fails, then run the migration and rerun it.

```bash
npm test -- src/server/db/database.integration.test.ts
npm run db:migrate
npm test -- src/server/db/database.integration.test.ts src/server/repositories/current-effective-appointments.integration.test.ts
```

Expected: the first database run fails because migration 011 is unapplied; after migration both focused files pass.

- [ ] **Step 6: Commit the shared resolver and indexes**

```bash
git add src/server/repositories/current-effective-appointments.repository.ts src/server/repositories/current-effective-appointments.integration.test.ts database/migrations/011_current_appointment_and_submission_read_indexes.sql src/server/db/database.integration.test.ts
git commit -m "feat: resolve current effective appointments"
```

---

### Task 2: Convert the appointment summary repository to attendance statuses

**Files:**
- Modify: `src/server/repositories/appointment-summary.repository.ts`
- Modify: `src/server/repositories/appointment-summary.repository.test.ts`
- Modify: `src/server/repositories/appointment-summary.integration.test.ts`

**Interfaces:**
- Consumes: `CURRENT_EFFECTIVE_APPOINTMENTS_CTE` and `AttendanceStatus` from Task 1.
- Produces: `AppointmentSummaryItem.laboratoryStatus: AttendanceStatus`.
- Produces: `AppointmentSummaryItem.physicalExamStatus: AttendanceStatus`.
- Produces: `AppointmentSummaryItem.overallStatus: "COMPLETE" | "INCOMPLETE"`.
- Keeps current appointment IDs, dates, `nextSchedule`, pagination, search, and metrics.

- [ ] **Step 1: Replace result-based integration fixtures with attendance combinations**

Create appointment fixtures for these students and expected states:

```ts
const attendanceCases = [
  ["TEST-ATTENDANCE-0001", "COMPLETED", "COMPLETED", "COMPLETE"],
  ["TEST-ATTENDANCE-0002", "COMPLETED", "PENDING", "INCOMPLETE"],
  ["TEST-ATTENDANCE-0003", "NO_SHOW", "COMPLETED", "INCOMPLETE"],
  ["TEST-ATTENDANCE-0004", null, "COMPLETED", "INCOMPLETE"],
] as const;
```

Insert result rows with conflicting statuses for at least two students, then assert they do not alter the attendance output:

```ts
expect(byStudent.get("TEST-ATTENDANCE-0002")).toMatchObject({
  laboratoryStatus: "COMPLETED",
  physicalExamStatus: "PENDING",
  overallStatus: "INCOMPLETE",
});
expect(byStudent.get("TEST-ATTENDANCE-0004")).toMatchObject({
  laboratoryStatus: "UNSCHEDULED",
  physicalExamStatus: "COMPLETED",
  overallStatus: "INCOMPLETE",
});
```

Add one reschedule-chain fixture and assert the replacement status and ID are returned.

- [ ] **Step 2: Run the repository integration test and verify RED**

```bash
npm test -- src/server/repositories/appointment-summary.integration.test.ts
```

Expected: FAIL because the repository still reads `exam_results` and `laboratory_results`.

- [ ] **Step 3: Replace result joins with the shared current-appointment CTE**

Import the Task 1 helper and change the summary CTE to join current service appointments twice:

```ts
import {
  CURRENT_EFFECTIVE_APPOINTMENTS_CTE,
  type AttendanceStatus,
} from "@/server/repositories/current-effective-appointments.repository";

const summaryRowsCte = `
  WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE},
  summary_rows AS (
    SELECT
      s.student_number AS "studentNumber",
      ${studentDisplayNameSql("s")} AS "studentName",
      s.first_name AS "firstName",
      s.last_name AS "lastName",
      s.college_id AS "collegeId",
      s.program_id AS "programId",
      c.name AS "collegeName",
      p.name AS "programName",
      COALESCE(physical.status, 'UNSCHEDULED') AS "physicalExamStatus",
      COALESCE(laboratory.status, 'UNSCHEDULED') AS "laboratoryStatus",
      physical.id AS "physicalExamAppointmentId",
      physical.appointment_date AS "physicalExamAppointmentDate",
      physical.status AS "physicalExamAppointmentStatus",
      laboratory.id AS "laboratoryAppointmentId",
      laboratory.appointment_date AS "laboratoryAppointmentDate",
      laboratory.status AS "laboratoryAppointmentStatus",
      LEAST(
        CASE WHEN physical.status='PENDING' AND physical.appointment_date >= CURRENT_DATE
             THEN physical.appointment_date END,
        CASE WHEN laboratory.status='PENDING' AND laboratory.appointment_date >= CURRENT_DATE
             THEN laboratory.appointment_date END
      ) AS "nextSchedule",
      CASE
        WHEN physical.status='COMPLETED' AND laboratory.status='COMPLETED'
        THEN 'COMPLETE'
        ELSE 'INCOMPLETE'
      END AS "overallStatus"
    FROM students s
    JOIN colleges c ON c.id=s.college_id
    JOIN programs p ON p.id=s.program_id
    LEFT JOIN current_effective_appointments physical
      ON physical."studentNumber"=s.student_number
     AND physical."scheduleType"='PHYSICAL_EXAM'
    LEFT JOIN current_effective_appointments laboratory
      ON laboratory."studentNumber"=s.student_number
     AND laboratory."scheduleType"='LABORATORY'
    WHERE s.is_active=TRUE
  )`;
```

Remove the `exam_results` and `laboratory_results` lateral joins from this repository. Keep legacy optional appointment-date and organization filters only when they operate on the resolved current appointment fields.

Update the item type:

```ts
physicalExamStatus: AttendanceStatus;
laboratoryStatus: AttendanceStatus;
overallStatus: "COMPLETE" | "INCOMPLETE";
```

- [ ] **Step 4: Update filter clauses, metrics, and sort order**

Use direct resolved status filters:

```ts
if (filters.physicalExamStatus) {
  add(`summary_rows."physicalExamStatus"=?`, filters.physicalExamStatus);
}
if (filters.laboratoryStatus) {
  add(`summary_rows."laboratoryStatus"=?`, filters.laboratoryStatus);
}
```

Keep metric names but count attendance:

```sql
COUNT(*) FILTER (WHERE summary_rows."physicalExamStatus"='COMPLETED')::int AS physical_completed,
COUNT(*) FILTER (WHERE summary_rows."laboratoryStatus"='COMPLETED')::int AS laboratory_completed,
COUNT(*) FILTER (WHERE summary_rows."overallStatus"='INCOMPLETE')::int AS pending_any
```

Preserve the `attention_first` URL value for compatibility, but redefine it as incomplete first:

```ts
attention_first: `CASE summary_rows."overallStatus" WHEN 'INCOMPLETE' THEN 0 ELSE 1 END,
  summary_rows."nextSchedule" ASC NULLS LAST,
  summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
```

- [ ] **Step 5: Update SQL-construction unit tests**

Replace result-status expectations with:

```ts
expect(itemSql).toContain("current_effective_appointments");
expect(itemSql).not.toContain("FROM exam_results result");
expect(itemSql).not.toContain("FROM laboratory_results result");
expect(itemWhere).toContain('summary_rows."physicalExamStatus"=$1');
expect(itemWhere).toContain('summary_rows."laboratoryStatus"=$2');
expect(summaryValues).toEqual(["COMPLETED", "UNSCHEDULED"]);
expect(itemSql).toContain("CASE summary_rows.\"overallStatus\" WHEN 'INCOMPLETE' THEN 0 ELSE 1 END");
```

- [ ] **Step 6: Run focused repository verification and commit**

```bash
npm test -- src/server/repositories/current-effective-appointments.integration.test.ts src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts
git add src/server/repositories/appointment-summary.repository.ts src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts
git commit -m "feat: derive appointment completion from attendance"
```

Expected: all three focused files pass.

---

### Task 3: Update Appointments filters, labels, rows, and tests

**Files:**
- Modify: `src/components/appointments/appointment-summary.ts`
- Modify: `src/components/appointments/status-labels.ts`
- Modify: `src/components/appointments/status-labels.test.ts`
- Modify: `src/app/(dashboard)/appointments/page.tsx`
- Modify: `src/app/(dashboard)/appointments/page.test.tsx`

**Interfaces:**
- Consumes: attendance-based `AppointmentSummaryItem` from Task 2.
- Produces: `OverallStatus = "COMPLETE" | "INCOMPLETE"`.
- Keeps sort key `attention_first`, but displays `Incomplete students first`.
- Uses `operationalStatusLabel` for both service columns.

- [ ] **Step 1: Write failing status-label and page tests**

Add label assertions:

```ts
expect(operationalStatusLabel("UNSCHEDULED")).toBe("Unscheduled");
expect(statusTone("UNSCHEDULED")).toBe("neutral");
expect(overallStatusLabel("INCOMPLETE")).toBe("Incomplete");
```

Update the page fixture and assertions:

```ts
const summaryItem = {
  studentNumber: "23-8200-01",
  studentName: "Aaron Abad",
  collegeName: "College of Computer Studies",
  programName: "BS Computer Science",
  physicalExamStatus: "COMPLETED",
  laboratoryStatus: "NO_SHOW",
  physicalExamAppointmentId: "physical-1",
  physicalExamAppointmentDate: "2026-07-30",
  physicalExamAppointmentStatus: "COMPLETED",
  laboratoryAppointmentId: "laboratory-1",
  laboratoryAppointmentDate: "2026-07-29",
  laboratoryAppointmentStatus: "NO_SHOW",
  nextSchedule: null,
  overallStatus: "INCOMPLETE",
};
```

For each service filter, assert exact options and values:

```ts
expect(within(select).getByRole("option", { name: "Unscheduled" })).toHaveValue("UNSCHEDULED");
expect(within(select).getByRole("option", { name: "Pending" })).toHaveValue("PENDING");
expect(within(select).getByRole("option", { name: "Completed" })).toHaveValue("COMPLETED");
expect(within(select).getByRole("option", { name: "No-show" })).toHaveValue("NO_SHOW");
expect(within(select).getByRole("option", { name: "Rescheduled" })).toHaveValue("RESCHEDULED");
expect(within(select).getByRole("option", { name: "Cancelled" })).toHaveValue("CANCELLED");
expect(within(select).queryByRole("option", { name: "Needs follow-up" })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run UI tests and verify RED**

```bash
npm test -- src/components/appointments/status-labels.test.ts src/app/\(dashboard\)/appointments/page.test.tsx
```

Expected: FAIL because `FOLLOW_UP` and result-upload options are still present.

- [ ] **Step 3: Narrow overall status and add Unscheduled labeling**

Change the shared types and labels:

```ts
export type OverallStatus = "COMPLETE" | "INCOMPLETE";
```

```ts
const operationalStatusLabels: Record<string, string> = {
  UNSCHEDULED: "Unscheduled",
  PENDING: "Pending",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
};
```

Keep `appointmentResultStatusLabel` because the student lookup/result workflow still uses it. Remove only `FOLLOW_UP` from `overallStatusLabels`.

- [ ] **Step 4: Replace Appointments page filter values and rendering helper**

Use these constants:

```ts
const attendanceStatuses = [
  "UNSCHEDULED",
  "PENDING",
  "COMPLETED",
  "NO_SHOW",
  "RESCHEDULED",
  "CANCELLED",
] as const;
const overallStatuses: OverallStatus[] = ["INCOMPLETE", "COMPLETE"];
```

Change the sort label:

```ts
["attention_first", "Incomplete students first"],
```

Render both service badges with:

```tsx
<Badge tone={statusTone(item.laboratoryStatus)}>
  {operationalStatusLabel(item.laboratoryStatus)}
</Badge>
```

and the equivalent physical status. Do not display result status, result dates, or medical follow-up on this page.

- [ ] **Step 5: Run focused UI and repository tests and commit**

```bash
npm test -- src/components/appointments/status-labels.test.ts src/app/\(dashboard\)/appointments/page.test.tsx src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts
git add src/components/appointments/appointment-summary.ts src/components/appointments/status-labels.ts src/components/appointments/status-labels.test.ts src/app/\(dashboard\)/appointments/page.tsx src/app/\(dashboard\)/appointments/page.test.tsx
git commit -m "feat: show attendance statuses in appointments"
```

Expected: all focused files pass and no Appointments test contains `PENDING_UPLOAD`, `REQUIRES_FOLLOW_UP`, `NOT_APPLICABLE`, or `FOLLOW_UP` as a filter/overall value.

---

### Task 4: Add the pure administrator student-result profile model

**Files:**
- Create: `src/server/student-results/admin-student-result-profile.ts`
- Create: `src/server/student-results/admin-student-result-profile.test.ts`

**Interfaces:**
- Produces: `CurrentSubmissionState = "FINALIZED" | "INVALIDATED" | "NOT_SUBMITTED"`.
- Produces: `AdminSubmissionProgress = "AWAITING_RESUBMISSION" | "FULLY_SUBMITTED" | "PARTIALLY_SUBMITTED" | "NOT_SUBMITTED"`.
- Produces: `currentSubmissionState(submission): CurrentSubmissionState`.
- Produces: `combinedSubmissionProgress(laboratory, physicalExam): AdminSubmissionProgress`.
- Produces shared profile, section, submission, file, and history types used by repository, service, and server components.

- [ ] **Step 1: Write failing pure-state tests**

Cover all priority combinations:

```ts
it.each([
  ["FINALIZED", "FINALIZED", "FULLY_SUBMITTED"],
  ["FINALIZED", "NOT_SUBMITTED", "PARTIALLY_SUBMITTED"],
  ["NOT_SUBMITTED", "FINALIZED", "PARTIALLY_SUBMITTED"],
  ["INVALIDATED", "FINALIZED", "AWAITING_RESUBMISSION"],
  ["FINALIZED", "INVALIDATED", "AWAITING_RESUBMISSION"],
  ["NOT_SUBMITTED", "NOT_SUBMITTED", "NOT_SUBMITTED"],
] as const)("maps %s and %s to %s", (laboratory, physicalExam, expected) => {
  expect(combinedSubmissionProgress(laboratory, physicalExam)).toBe(expected);
});
```

Also assert null maps to `NOT_SUBMITTED`, `FINALIZED` maps to `FINALIZED`, and `INVALIDATED` maps to `INVALIDATED`.

- [ ] **Step 2: Run the pure unit test and verify RED**

```bash
npm test -- src/server/student-results/admin-student-result-profile.test.ts
```

Expected: FAIL because the model does not exist.

- [ ] **Step 3: Implement exact profile types and progress precedence**

Create these core types and functions:

```ts
import type {
  AttendanceStatus,
  ScheduleType,
} from "@/server/repositories/current-effective-appointments.repository";

export type CurrentSubmissionState = "FINALIZED" | "INVALIDATED" | "NOT_SUBMITTED";
export type AdminSubmissionProgress =
  | "AWAITING_RESUBMISSION"
  | "FULLY_SUBMITTED"
  | "PARTIALLY_SUBMITTED"
  | "NOT_SUBMITTED";

export type AdminResultFile = {
  id: string;
  originalFilename: string;
  detectedMimeType: string;
  byteSize: number;
};

export type AdminResultSubmission = {
  id: string;
  appointmentId: string;
  resultType: ScheduleType;
  status: "FINALIZED" | "INVALIDATED";
  finalizedAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
  lastActivityAt: Date;
  fileCount: number;
  totalBytes: number;
  files: AdminResultFile[];
};

export type AdminCurrentResultSection = {
  resultType: ScheduleType;
  appointment: {
    id: string;
    appointmentDate: string;
    status: Exclude<AttendanceStatus, "UNSCHEDULED">;
  } | null;
  state: CurrentSubmissionState;
  submission: AdminResultSubmission | null;
};

export type AdminStudentResultListItem = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  progress: AdminSubmissionProgress;
  latestActivityAt: Date;
  laboratory: Pick<AdminCurrentResultSection, "state"> & { fileCount: number };
  physicalExam: Pick<AdminCurrentResultSection, "state"> & { fileCount: number };
};

export type AdminStudentResultProfile = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  progress: AdminSubmissionProgress;
  latestActivityAt: Date | null;
  laboratory: AdminCurrentResultSection;
  physicalExam: AdminCurrentResultSection;
  history: AdminResultSubmission[];
};

export function currentSubmissionState(
  submission: Pick<AdminResultSubmission, "status"> | null,
): CurrentSubmissionState {
  return submission?.status ?? "NOT_SUBMITTED";
}

export function combinedSubmissionProgress(
  laboratory: CurrentSubmissionState,
  physicalExam: CurrentSubmissionState,
): AdminSubmissionProgress {
  if (laboratory === "INVALIDATED" || physicalExam === "INVALIDATED") {
    return "AWAITING_RESUBMISSION";
  }
  if (laboratory === "FINALIZED" && physicalExam === "FINALIZED") {
    return "FULLY_SUBMITTED";
  }
  if (laboratory === "FINALIZED" || physicalExam === "FINALIZED") {
    return "PARTIALLY_SUBMITTED";
  }
  return "NOT_SUBMITTED";
}
```

- [ ] **Step 4: Run the pure test and commit**

```bash
npm test -- src/server/student-results/admin-student-result-profile.test.ts
git add src/server/student-results/admin-student-result-profile.ts src/server/student-results/admin-student-result-profile.test.ts
git commit -m "feat: define admin student result profiles"
```

Expected: all pure model tests pass.

---

### Task 5: Aggregate administrator result profiles in the repository

**Files:**
- Modify: `src/server/repositories/student-result-submissions.repository.ts`
- Create: `src/server/repositories/student-result-submission-profiles.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 current-effective-appointment CTE.
- Consumes: Task 4 profile types and progress functions.
- Produces: `listAdminStudentResultProfileRows(input: { limit: number; offset: number }): Promise<{ items: AdminStudentResultListItem[]; total: number }>`.
- Produces: `getAdminStudentResultProfileRow(studentNumber: string): Promise<AdminStudentResultProfile | null>`.
- Produces: `getStudentNumberForSubmission(submissionId: string): Promise<string | null>`.
- Existing submission-ID file, ZIP, invalidation, draft, and finalization functions remain unchanged.

- [ ] **Step 1: Write grouped list integration tests and verify their expected profile states**

Use isolated students and appointment/submission fixtures to assert:

```ts
const listed = await listAdminStudentResultProfileRows({ limit: 50, offset: 0 });
const student = listed.items.find((item) => item.studentNumber === "TEST-PROFILE-0001");
expect(student).toMatchObject({
  progress: "PARTIALLY_SUBMITTED",
  laboratory: { state: "FINALIZED", fileCount: 2 },
  physicalExam: { state: "NOT_SUBMITTED", fileCount: 0 },
});
expect(listed.items.filter((item) => item.studentNumber === "TEST-PROFILE-0001"))
  .toHaveLength(1);
```

Add fixtures and assertions for:

- both current submissions finalized: `FULLY_SUBMITTED`;
- current invalidated submission: `AWAITING_RESUBMISSION`;
- invalidated-only student remains listed;
- draft-only student is excluded;
- pagination occurs after grouping by asserting two submissions for one student consume one result slot;
- newest appointment cycle without submission produces `NOT_SUBMITTED` for that service;
- a rescheduled appointment uses its replacement.

- [ ] **Step 2: Write unified detail/history integration tests**

Assert a newer current appointment moves an older finalized submission into history:

```ts
const profile = await getAdminStudentResultProfileRow("TEST-PROFILE-0004");
expect(profile?.laboratory).toMatchObject({
  appointment: { id: newerLaboratoryId, status: "PENDING" },
  state: "NOT_SUBMITTED",
  submission: null,
});
expect(profile?.history.map((submission) => submission.id)).toContain(oldFinalizedId);
```

Assert an invalidated submission followed by a new finalized submission for the same appointment selects the finalized replacement and keeps the invalidated row in history:

```ts
expect(profile?.laboratory.submission?.id).toBe(replacementFinalizedId);
expect(profile?.laboratory.state).toBe("FINALIZED");
expect(profile?.history.find((submission) => submission.id === invalidatedId))
  .toMatchObject({ status: "INVALIDATED", files: [] });
```

Also assert `getStudentNumberForSubmission` returns the owning student and returns null for an unknown UUID.

- [ ] **Step 3: Run the new integration test and verify RED**

```bash
npm test -- src/server/repositories/student-result-submission-profiles.integration.test.ts
```

Expected: FAIL because the grouped repository functions do not exist.

- [ ] **Step 4: Implement the grouped list query**

Build the list with the shared CTE and one `submission_students` row per student:

```sql
WITH current effective appointment CTE,
submission_students AS (
  SELECT submission.student_number,
         MAX(GREATEST(
           COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
           COALESCE(submission.finalized_at, '-infinity'::timestamptz),
           submission.last_activity_at
         )) AS latest_activity_at
    FROM student_result_submissions submission
   WHERE submission.status IN ('FINALIZED','INVALIDATED')
   GROUP BY submission.student_number
),
profile_rows AS (
  SELECT student identity,
         activity.latest_activity_at,
         current Laboratory appointment fields,
         current Physical Exam appointment fields,
         current Laboratory submission status and file count,
         current Physical Exam submission status and file count
    FROM submission_students activity
    JOIN students student ON student.student_number=activity.student_number
    JOIN colleges college ON college.id=student.college_id
    JOIN programs program ON program.id=student.program_id
    LEFT JOIN current_effective_appointments laboratory_appointment
      ON laboratory_appointment."studentNumber"=student.student_number
     AND laboratory_appointment."scheduleType"='LABORATORY'
    LEFT JOIN current_effective_appointments physical_appointment
      ON physical_appointment."studentNumber"=student.student_number
     AND physical_appointment."scheduleType"='PHYSICAL_EXAM'
)
SELECT profile fields
  FROM profile_rows
 ORDER BY latest_activity_at DESC, student name fields, student_number
 LIMIT limit OFFSET offset
```

The two current-submission lateral joins must use this deterministic ordering and file count:

```sql
SELECT submission.id, submission.status,
       COUNT(file.id)::int AS file_count
  FROM student_result_submissions submission
  LEFT JOIN student_result_files file
    ON file.submission_id=submission.id
   AND file.deleted_at IS NULL
   AND file.storage_delete_pending=FALSE
 WHERE submission.appointment_id=current_appointment.id
   AND submission.status IN ('FINALIZED','INVALIDATED')
 GROUP BY submission.id
 ORDER BY GREATEST(
            COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
            COALESCE(submission.finalized_at, '-infinity'::timestamptz),
            submission.last_activity_at
          ) DESC,
          submission.created_at DESC,
          submission.id DESC
 LIMIT 1
```

Map null submissions to `NOT_SUBMITTED` and calculate progress with Task 4 functions. Count from `submission_students`, not from raw submission rows.

- [ ] **Step 5: Implement one-snapshot detail query and mapper**

Fetch student identity, both current appointments, every finalized/invalidated submission, and active file metadata in one SQL statement. Group repeated file rows by submission ID in TypeScript. Select current submissions only when `submission.appointmentId` equals the current appointment ID. Sort candidate submissions by:

```ts
function activityTime(submission: AdminResultSubmission) {
  return Math.max(
    submission.invalidatedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    submission.finalizedAt.getTime(),
    submission.lastActivityAt.getTime(),
  );
}
```

Use this exact classification:

```ts
const currentIds = new Set(
  [laboratorySubmission?.id, physicalExamSubmission?.id].filter(
    (id): id is string => Boolean(id),
  ),
);
const history = submissions
  .filter((submission) => !currentIds.has(submission.id))
  .sort((left, right) => activityTime(right) - activityTime(left));
```

A direct student URL may return a valid profile with both states `NOT_SUBMITTED` even when the student is absent from the list. Return null only when the student record does not exist.

- [ ] **Step 6: Run focused repository tests and commit**

```bash
npm test -- src/server/student-results/admin-student-result-profile.test.ts src/server/repositories/current-effective-appointments.integration.test.ts src/server/repositories/student-result-submission-profiles.integration.test.ts src/server/services/student-result-submissions.integration.test.ts
git add src/server/repositories/student-result-submissions.repository.ts src/server/repositories/student-result-submission-profiles.integration.test.ts
git commit -m "feat: aggregate student result submission profiles"
```

Expected: all focused tests pass and existing upload/download/invalidation tests remain green.

---

### Task 6: Add service methods, grouped list UI, pagination, labels, and API contract

**Files:**
- Modify: `src/server/services/student-result-submissions.service.ts`
- Create: `src/components/admin-results/submission-status.ts`
- Create: `src/components/admin-results/submission-status.test.ts`
- Create: `src/components/admin-results/student-result-submission-pagination.ts`
- Create: `src/components/admin-results/StudentResultSubmissionPagination.tsx`
- Modify: `src/app/(dashboard)/settings/student-result-submissions/page.tsx`
- Create: `src/app/(dashboard)/settings/student-result-submissions/page.test.tsx`
- Modify: `src/app/api/admin/student-result-submissions/route.ts`
- Create: `src/app/api/admin/student-result-submissions/route.test.ts`

**Interfaces:**
- Produces: `listAdminStudentResultProfiles(actor, input)`.
- Produces: `getAdminStudentResultProfile(studentNumber, actor)`.
- Produces: `getAdminSubmissionStudentNumber(submissionId, actor)`.
- Produces: `RESULT_SUBMISSION_PAGE_SIZE = 50`.
- Produces: `parseStudentResultSubmissionPage(value?: string): number` using strict positive-integer parsing.
- Produces label/format helpers used by list and detail server components.

- [ ] **Step 1: Add failing service authorization tests**

Extend the existing integration test to assert:

```ts
await expect(listAdminStudentResultProfiles(coordinator, { page: 1, limit: 50, offset: 0 }))
  .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
await expect(getAdminStudentResultProfile("99-9409-09", clinicStaff))
  .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
await expect(getAdminSubmissionStudentNumber(finalized.id, admin))
  .resolves.toBe("99-9409-09");
```

- [ ] **Step 2: Implement service wrappers without changing existing mutations**

Add these wrappers after `assertAdmin`:

```ts
export async function listAdminStudentResultProfiles(
  actor: SessionUser,
  input: { page: number; limit: number; offset: number },
) {
  assertAdmin(actor);
  return listAdminStudentResultProfileRows({ limit: input.limit, offset: input.offset });
}

export async function getAdminStudentResultProfile(
  studentNumber: string,
  actor: SessionUser,
) {
  assertAdmin(actor);
  return getAdminStudentResultProfileRow(studentNumber);
}

export async function getAdminSubmissionStudentNumber(
  submissionId: string,
  actor: SessionUser,
) {
  assertAdmin(actor);
  return getStudentNumberForSubmission(submissionId);
}
```

Keep `getAdminStudentResultSubmission`, download, ZIP, and invalidation functions because submission-ID actions and compatibility APIs still need them.

- [ ] **Step 3: Add failing pure label, byte, date, and page-parser tests**

Assert:

```ts
expect(submissionProgressLabel("FULLY_SUBMITTED")).toBe("Fully submitted");
expect(submissionProgressLabel("AWAITING_RESUBMISSION")).toBe("Awaiting resubmission");
expect(currentSubmissionStateLabel("NOT_SUBMITTED")).toBe("Not submitted yet");
expect(formatResultBytes(1024)).toBe("1 KB");
expect(parseStudentResultSubmissionPage("2")).toBe(2);
expect(parseStudentResultSubmissionPage("1e3")).toBe(1);
expect(parseStudentResultSubmissionPage("0")).toBe(1);
```

Use `Asia/Manila` in `formatResultDateTime` so rendered activity dates are stable for the project locale.

- [ ] **Step 4: Implement exact list presentation helpers**

Use these mappings:

```ts
const progressLabels = {
  AWAITING_RESUBMISSION: "Awaiting resubmission",
  FULLY_SUBMITTED: "Fully submitted",
  PARTIALLY_SUBMITTED: "Partially submitted",
  NOT_SUBMITTED: "Not submitted",
} as const;

const stateLabels = {
  FINALIZED: "Finalized",
  INVALIDATED: "Invalidated — awaiting resubmission",
  NOT_SUBMITTED: "Not submitted yet",
} as const;
```

Use `danger` for awaiting resubmission, `success` for fully submitted, `warning` for partially submitted, and `neutral` for not submitted. Format byte values using B, KB, MB with at most one decimal place.

- [ ] **Step 5: Write the failing grouped list page test**

Mock `listAdminStudentResultProfiles` and `requireUser`, then assert:

```ts
expect(screen.getAllByRole("link", { name: /Aaron Abad/ })).toHaveLength(1);
expect(screen.getByText("Laboratory: Finalized · 2 files")).toBeVisible();
expect(screen.getByText("Physical Exam: Not submitted yet")).toBeVisible();
expect(screen.getByText("Partially submitted")).toBeVisible();
expect(screen.getByRole("link", { name: /Aaron Abad/ })).toHaveAttribute(
  "href",
  "/settings/student-result-submissions/students/23-8200-01",
);
expect(screen.getByText("Page 2 of 3")).toBeVisible();
```

Also test the empty state and malformed page normalization.

- [ ] **Step 6: Replace the list page with student-level cards and grouped pagination**

The server page must:

```ts
const actor = await requireUser(["ADMIN"]);
const params = await searchParams;
const page = parseStudentResultSubmissionPage(params.page);
const report = await listAdminStudentResultProfiles(actor, {
  page,
  limit: RESULT_SUBMISSION_PAGE_SIZE,
  offset: (page - 1) * RESULT_SUBMISSION_PAGE_SIZE,
});
```

Render one link per `studentNumber`, encode it with `encodeURIComponent`, show both service lines, one combined badge, and the latest activity time. Use the dedicated pagination component with `aria-label="Student result submission pagination"`.

- [ ] **Step 7: Update and test the list API**

Change `GET` to parse `page` from the request URL and return the grouped report:

```ts
export async function GET(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const page = parseStudentResultSubmissionPage(new URL(request.url).searchParams.get("page") ?? undefined);
    return dataResponse(await listAdminStudentResultProfiles(actor, {
      page,
      limit: RESULT_SUBMISSION_PAGE_SIZE,
      offset: (page - 1) * RESULT_SUBMISSION_PAGE_SIZE,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
```

The route test must verify the service receives `{ page: 2, limit: 50, offset: 50 }` and that authorization failures use the existing error response format.

- [ ] **Step 8: Run focused tests and commit**

```bash
npm test -- src/server/services/student-result-submissions.integration.test.ts src/components/admin-results/submission-status.test.ts src/app/\(dashboard\)/settings/student-result-submissions/page.test.tsx src/app/api/admin/student-result-submissions/route.test.ts
git add src/server/services/student-result-submissions.service.ts src/server/services/student-result-submissions.integration.test.ts src/components/admin-results/submission-status.ts src/components/admin-results/submission-status.test.ts src/components/admin-results/student-result-submission-pagination.ts src/components/admin-results/StudentResultSubmissionPagination.tsx src/app/\(dashboard\)/settings/student-result-submissions/page.tsx src/app/\(dashboard\)/settings/student-result-submissions/page.test.tsx src/app/api/admin/student-result-submissions/route.ts src/app/api/admin/student-result-submissions/route.test.ts
git commit -m "feat: group admin result submissions by student"
```

Expected: all focused tests pass.

---

### Task 7: Build the unified student result page, history, and compatibility redirect

**Files:**
- Create: `src/components/admin-results/StudentResultSection.tsx`
- Create: `src/components/admin-results/SubmissionHistory.tsx`
- Create: `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.tsx`
- Create: `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx`
- Modify: `src/app/(dashboard)/settings/student-result-submissions/[submissionId]/page.tsx`
- Create: `src/app/(dashboard)/settings/student-result-submissions/[submissionId]/page.test.tsx`
- Modify: `src/components/admin-results/AdminSubmissionActions.tsx`
- Modify: `src/components/admin-results/AdminSubmissionActions.test.tsx`

**Interfaces:**
- Consumes: `AdminStudentResultProfile`, `AdminCurrentResultSection`, and `AdminResultSubmission` from Task 4.
- Consumes: service methods and formatting helpers from Task 6.
- Keeps all existing file and ZIP API URLs addressed by submission ID.
- Produces canonical page route `/settings/student-result-submissions/students/[studentNumber]`.
- Existing `/settings/student-result-submissions/[submissionId]` becomes a server redirect to the canonical route.

- [ ] **Step 1: Write failing action-component tests for two independent sections**

Change the action component contract to:

```ts
type Props = {
  submissionId: string;
  resultLabel: "Laboratory" | "Physical Exam";
};
```

Test that Laboratory renders `Laboratory invalidation reason`, uses the existing submission-ID ZIP URL, opens `Invalidate Laboratory submission?`, posts the reason, reports an API conflict, and refreshes after success. Add a second render with `Physical Exam` and verify labels remain unique.

- [ ] **Step 2: Update `AdminSubmissionActions`**

Use result-specific labels and clear stale errors before each request:

```ts
setError(undefined);
setPending(true);
```

Keep the existing API URL and confirmation semantics. On non-OK responses, keep the dialog open and display `payload.error?.message`. On success, close the dialog and call `router.refresh()`.

- [ ] **Step 3: Write the failing canonical page tests**

Mock `requireUser` and `getAdminStudentResultProfile`. Cover:

- header identity and combined badge;
- Laboratory finalized with files, individual downloads, ZIP, and invalidation controls;
- Physical Exam not submitted;
- invalidated section with reason/date and no download links;
- unscheduled appointment context;
- older finalized history with download controls;
- invalidated history with metadata but no download controls;
- unknown student calls `notFound`.

Representative assertions:

```ts
expect(screen.getByRole("heading", { name: "Abad, Aaron" })).toBeVisible();
expect(screen.getByText("Partially submitted")).toBeVisible();
expect(screen.getByRole("heading", { name: "Laboratory results" })).toBeVisible();
expect(screen.getByRole("heading", { name: "Physical Exam results" })).toBeVisible();
expect(screen.getByRole("link", { name: "Download laboratory.pdf" })).toHaveAttribute(
  "href",
  "/api/admin/student-result-submissions/lab-submission/files/lab-file",
);
expect(screen.getByText("Not submitted yet")).toBeVisible();
```

- [ ] **Step 4: Implement `StudentResultSection`**

Render appointment context first:

```tsx
<p className="text-sm text-muted">
  Appointment: {section.appointment
    ? `${operationalStatusLabel(section.appointment.status)} · ${section.appointment.appointmentDate}`
    : "Unscheduled"}
</p>
```

Render state rules exactly:

- `NOT_SUBMITTED`: explanatory text only, no file or mutation controls;
- `INVALIDATED`: invalidation reason and date, no file or ZIP controls;
- `FINALIZED`: file list, individual download links, ZIP link/action component, finalization date, file count, and total size.

Use unique accessible download names such as `Download laboratory.pdf`.

- [ ] **Step 5: Implement `SubmissionHistory`**

For every history entry show result type, appointment date, status, finalized date, invalidation date/reason when present, file count, and total size. Render downloads only when `status === "FINALIZED"` and files are present. Invalidated entries must not render individual or ZIP links.

Use this empty state:

```tsx
<Card className="p-5 text-sm text-muted">No older submissions yet.</Card>
```

- [ ] **Step 6: Implement the canonical server page**

Use one service response:

```ts
const actor = await requireUser(["ADMIN"]);
const studentNumber = decodeURIComponent((await params).studentNumber);
const profile = await getAdminStudentResultProfile(studentNumber, actor);
if (!profile) notFound();
```

Render a PageHeader, back link, combined badge, two current sections, and history. Do not query Laboratory and Physical Exam separately from the page.

- [ ] **Step 7: Convert the old submission page to a compatibility redirect**

Implement:

```ts
const actor = await requireUser(["ADMIN"]);
const submissionId = (await params).submissionId;
const studentNumber = await getAdminSubmissionStudentNumber(submissionId, actor);
if (!studentNumber) notFound();
redirect(
  `/settings/student-result-submissions/students/${encodeURIComponent(studentNumber)}`,
);
```

The compatibility test must mock `redirect`, assert the exact encoded target, and assert unknown submission IDs call `notFound`.

- [ ] **Step 8: Run focused page/action tests and commit**

```bash
npm test -- src/components/admin-results/AdminSubmissionActions.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/students/\[studentNumber\]/page.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/\[submissionId\]/page.test.tsx src/server/repositories/student-result-submission-profiles.integration.test.ts
git add src/components/admin-results/StudentResultSection.tsx src/components/admin-results/SubmissionHistory.tsx src/components/admin-results/AdminSubmissionActions.tsx src/components/admin-results/AdminSubmissionActions.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/students/\[studentNumber\]/page.tsx src/app/\(dashboard\)/settings/student-result-submissions/students/\[studentNumber\]/page.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/\[submissionId\]/page.tsx src/app/\(dashboard\)/settings/student-result-submissions/\[submissionId\]/page.test.tsx
git commit -m "feat: add unified student result submission pages"
```

Expected: all focused tests pass.

---

### Task 8: Add the full attendance-to-submission regression story and complete verification

**Files:**
- Modify: `src/test/automated-scheduling-student-portal.e2e.integration.test.ts`
- Modify if failures reveal stale expectations only: `src/server/services/student-result-submissions.integration.test.ts`
- Modify if failures reveal stale attendance expectations only: `src/server/repositories/appointment-summary.integration.test.ts`

**Interfaces:**
- Consumes every public interface created in Tasks 1–7.
- Produces one end-to-end regression proving attendance completion changes before uploads and unified submission progress changes only after finalization/invalidation.

- [ ] **Step 1: Extend the end-to-end test imports and assertions**

Import:

```ts
import { appointmentSummaryReport } from "@/server/repositories/appointment-summary.repository";
import {
  getAdminStudentResultProfile,
  listAdminStudentResultProfiles,
} from "@/server/services/student-result-submissions.service";
```

After Laboratory appointment completion and before any upload, assert:

```ts
const afterLaboratoryAttendance = await appointmentSummaryReport({
  search: "99-9003-03",
  sort: "name_asc",
  page: 1,
  limit: 20,
  offset: 0,
});
expect(afterLaboratoryAttendance.items[0]).toMatchObject({
  laboratoryStatus: "COMPLETED",
  physicalExamStatus: "PENDING",
  overallStatus: "INCOMPLETE",
});
```

- [ ] **Step 2: Assert grouped progress after the first finalization**

After finalizing Laboratory files:

```ts
const partial = await listAdminStudentResultProfiles(admin, {
  page: 1,
  limit: 50,
  offset: 0,
});
expect(partial.items.find((item) => item.studentNumber === "99-9003-03"))
  .toMatchObject({ progress: "PARTIALLY_SUBMITTED" });
```

- [ ] **Step 3: Complete Physical Exam and prove attendance is complete before its upload**

Complete the current Physical Exam appointment with the administrator actor, then assert:

```ts
const afterPhysicalAttendance = await appointmentSummaryReport({
  search: "99-9003-03",
  sort: "name_asc",
  page: 1,
  limit: 20,
  offset: 0,
});
expect(afterPhysicalAttendance.items[0]).toMatchObject({
  laboratoryStatus: "COMPLETED",
  physicalExamStatus: "COMPLETED",
  overallStatus: "COMPLETE",
});
```

Then upload/finalize one Physical Exam file and assert `FULLY_SUBMITTED`.

- [ ] **Step 4: Assert invalidation and replacement history**

After invalidating the Laboratory submission, assert:

```ts
const awaiting = await getAdminStudentResultProfile("99-9003-03", admin);
expect(awaiting).toMatchObject({ progress: "AWAITING_RESUBMISSION" });
expect(awaiting?.laboratory).toMatchObject({ state: "INVALIDATED" });
```

Finalize the replacement Laboratory draft, then assert:

```ts
const replaced = await getAdminStudentResultProfile("99-9003-03", admin);
expect(replaced).toMatchObject({ progress: "FULLY_SUBMITTED" });
expect(replaced?.laboratory).toMatchObject({ state: "FINALIZED" });
expect(replaced?.history.some((submission) => (
  submission.id === finalized.id && submission.status === "INVALIDATED"
))).toBe(true);
```

- [ ] **Step 5: Add a newer Laboratory appointment and assert the old result becomes history**

Insert a later published pending Laboratory appointment for the same student, then assert:

```ts
const newCycle = await getAdminStudentResultProfile("99-9003-03", admin);
expect(newCycle?.laboratory).toMatchObject({
  appointment: { id: newerLaboratoryId, status: "PENDING" },
  state: "NOT_SUBMITTED",
  submission: null,
});
expect(newCycle?.progress).toBe("PARTIALLY_SUBMITTED");
expect(newCycle?.history.some((submission) => submission.id === replacementFinalized.id))
  .toBe(true);
```

The Appointments summary must also show Laboratory `PENDING` and overall `INCOMPLETE` for the new cycle.

- [ ] **Step 6: Run the end-to-end regression alone**

```bash
npm test -- src/test/automated-scheduling-student-portal.e2e.integration.test.ts
```

Expected: PASS within the existing 60-second test timeout. Increase the timeout only if the test consistently completes successfully but exceeds 60 seconds on the project’s Windows/PostgreSQL environment; do not weaken assertions.

- [ ] **Step 7: Run all focused revision tests together**

```bash
npm test -- src/server/repositories/current-effective-appointments.integration.test.ts src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts src/app/\(dashboard\)/appointments/page.test.tsx src/server/student-results/admin-student-result-profile.test.ts src/server/repositories/student-result-submission-profiles.integration.test.ts src/server/services/student-result-submissions.integration.test.ts src/components/admin-results/submission-status.test.ts src/components/admin-results/AdminSubmissionActions.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/page.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/students/\[studentNumber\]/page.test.tsx src/app/\(dashboard\)/settings/student-result-submissions/\[submissionId\]/page.test.tsx src/app/api/admin/student-result-submissions/route.test.ts src/test/automated-scheduling-student-portal.e2e.integration.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 8: Run complete verification**

```bash
npm run db:migrate
npm test
npm run lint
npm run build
```

Expected:

- migration reports migration 011 applied or already applied;
- the complete Vitest suite passes;
- ESLint exits with no errors;
- Next.js production build completes successfully.

- [ ] **Step 9: Inspect the final diff for forbidden coupling and stale UI copy**

Run:

```bash
git diff --check
git grep -n "FOLLOW_UP\|REQUIRES_FOLLOW_UP\|PENDING_UPLOAD\|NOT_APPLICABLE" -- 'src/app/(dashboard)/appointments' 'src/server/repositories/appointment-summary.repository.ts'
git grep -n "student-result-submissions/\${submission.id}" -- 'src/app/(dashboard)/settings/student-result-submissions' 'src/components/admin-results'
```

Expected:

- `git diff --check` prints nothing;
- the Appointments scope contains none of the medical result-status values;
- internal result-profile links do not use submission IDs.

- [ ] **Step 10: Commit the end-to-end verification changes**

```bash
git add src/test/automated-scheduling-student-portal.e2e.integration.test.ts src/server/services/student-result-submissions.integration.test.ts src/server/repositories/appointment-summary.integration.test.ts
git commit -m "test: verify attendance and unified result workflow"
```

Only stage the two optional integration files when they were changed to remove stale expectations directly caused by this revision.

---

## Completion Checklist

- [ ] Appointments displays operational attendance statuses, including Unscheduled.
- [ ] Appointments overall status is Complete only when both latest effective appointments are completed.
- [ ] Medical result upload/follow-up status no longer affects Appointments rows, filters, metrics, or sorting.
- [ ] Published replacement appointments supersede rescheduled predecessors.
- [ ] Newer appointment cycles supersede older completed cycles.
- [ ] The administrator submissions list has at most one card per student.
- [ ] Draft-only students remain hidden from the administrator list.
- [ ] Combined submission progress uses only the latest effective appointments.
- [ ] The canonical student route shows independent Laboratory and Physical Exam current sections.
- [ ] Invalidated current submissions show reason/date and no downloads.
- [ ] Older finalized and invalidated submissions appear in history.
- [ ] Older finalized files retain audited downloads when files exist.
- [ ] Existing submission-ID page links redirect to the canonical student route.
- [ ] Administrator-only access, file ownership checks, ZIP checks, checksum verification, audit logs, and reason-required invalidation remain intact.
- [ ] Migration 011, focused tests, complete tests, lint, and production build all pass.
