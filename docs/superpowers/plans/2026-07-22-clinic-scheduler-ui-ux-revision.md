# Clinic Scheduler UI/UX Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved clinic-scheduler UI/UX revision: standard Excel CSV compatibility, reliable import progress, clinic-context appointment profiles, audited completed-status corrections, simplified completion filters, removal of the legacy Results workspace, maximum-only capacity rules, and an interactive unavailable-date calendar.

**Architecture:** Preserve the existing Next.js App Router, PostgreSQL repository/service boundaries, and role-based authorization. Decode byte-based student CSV inputs as strict UTF-8 with a Windows-1252 fallback, introduce small shared UI and appointment-detail components, keep appointment mutations transactional and audited, retain legacy database capacity columns only for compatibility, and reuse the existing clinic-block service for single-day calendar selections.

**Tech Stack:** Next.js 16.2.6 App Router, React 19.2.4, TypeScript 5, Tailwind CSS 4, PostgreSQL via `pg`, Zod 4, Vitest 4, Testing Library.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-22-clinic-scheduler-ui-ux-revision-design.md` exactly.
- Use Manila dates (`Asia/Manila`) for all current-date and future-date decisions.
- Preserve role rules: administrators may manage either clinic; clinic staff may manage only their assigned clinic; coordinators remain read-only and limited to Dashboard plus Students & Schedules.
- Never delete finalized submissions, uploaded files, or verified medical-result data during appointment correction.
- Keep `/appointments/[appointmentId]` for users entering from Appointments.
- Keep `/results` only as a temporary server redirect to `/appointments`.
- Keep `safe_daily_capacity` in the database for compatibility, but synchronize it to `max_daily_capacity` and stop using it as an operational rule.
- Preserve the exact nine-column student CSV contract and atomic import behavior. Decode byte inputs as strict UTF-8 first, falling back to Windows-1252 only when UTF-8 decoding fails; keep UTF-16 unsupported and add no encoding dependency.
- Use TDD: every behavior change starts with a failing focused test.
- Run focused tests after each task, then run the complete test suite, lint, and production build before completion.

---

## File Structure

### New files

- `src/components/ui/Spinner.tsx` — reusable accessible loading indicator.
- `src/components/appointments/AppointmentDetail.tsx` — shared server-rendered appointment profile used by all three detail routes.
- `src/components/appointments/CompletedStatusCorrection.tsx` — client correction form and confirmation flow.
- `src/app/(dashboard)/laboratory/[appointmentId]/page.tsx` — Laboratory-context appointment profile route.
- `src/app/(dashboard)/laboratory/[appointmentId]/page.test.tsx` — Laboratory route validation tests.
- `src/app/(dashboard)/physical-exam/[appointmentId]/page.tsx` — Physical Exam-context appointment profile route.
- `src/app/(dashboard)/physical-exam/[appointmentId]/page.test.tsx` — Physical route validation tests.
- `src/components/appointments/status-labels.ts` — shared user-facing status label and badge-tone mapping.
- `src/components/settings/ClinicUnavailableCalendar.tsx` — monthly calendar controller and date-cell interactions.
- `src/components/settings/ClinicUnavailableCalendar.test.tsx` — calendar rendering, loading, success, and failure tests.
- `src/components/settings/clinic-calendar.ts` — pure month-grid and unavailable-range expansion helpers.
- `src/components/settings/clinic-calendar.test.ts` — unit tests for calendar date calculations.
- `database/migrations/010_maximum_only_capacity.sql` — normalize legacy safe capacity values and document compatibility behavior.

### Modified files

- `src/components/ui/ConfirmDialog.tsx`
- `src/components/schedules/ScheduleImportForm.tsx`
- `src/components/schedules/ScheduleImportForm.test.tsx`
- `src/server/services/student-import-csv.ts`
- `src/server/services/student-import-csv.test.ts`
- `src/components/appointments/ClinicPublishedSchedule.tsx`
- `src/components/appointments/ClinicPublishedSchedule.test.tsx`
- `src/app/(dashboard)/appointments/[appointmentId]/page.tsx`
- `src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx`
- `src/components/appointments/AppointmentActions.tsx`
- `src/components/appointments/AppointmentActions.test.tsx`
- `src/server/services/appointments.service.ts`
- `src/server/services/appointments.service.test.ts`
- `src/server/repositories/appointments.repository.ts`
- `src/server/repositories/student-result-submissions.repository.ts`
- `src/server/services/student-result-submissions.integration.test.ts`
- `src/app/(dashboard)/appointments/page.tsx`
- `src/app/(dashboard)/appointments/page.test.tsx`
- `src/server/repositories/appointment-summary.repository.ts`
- `src/server/repositories/appointment-summary.repository.test.ts`
- `src/server/repositories/appointment-summary.integration.test.ts`
- `src/components/layout/Sidebar.tsx`
- `src/components/layout/Sidebar.test.tsx`
- `src/app/(dashboard)/results/page.tsx`
- `src/app/(dashboard)/results/page.test.tsx`
- `src/components/settings/CapacityForm.tsx`
- `src/app/(dashboard)/settings/capacity/page.tsx`
- `src/app/api/settings/capacity/route.test.ts`
- `src/server/rule-engine/types.ts`
- `src/server/rule-engine/capacity-rules.ts`
- `src/server/rule-engine/generate-schedule.test.ts`
- `src/server/rule-engine/generate-paired-schedule.ts`
- `src/server/rule-engine/generate-paired-schedule.test.ts`
- `src/server/services/priority-displacement.service.ts`
- `src/server/services/priority-displacement.integration.test.ts`
- `src/server/services/clinic-calendar.service.ts`
- `src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx`
- `src/app/api/clinic-unavailable-dates/route.test.ts`
- `src/server/services/clinic-calendar.service.test.ts` or the repository’s existing clinic-calendar integration test file if present
- `README.md`

### Deleted files

- `src/components/tracking/ResultsWorkspace.tsx`
- `src/app/api/results/route.ts`
- `src/app/api/results/route.test.ts`
- Delete any Results-workspace-only component test if present.

---

### Task 0: Amend the plan and add standard Windows CSV compatibility

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-clinic-scheduler-ui-ux-revision-design.md`
- Modify: `docs/superpowers/plans/2026-07-22-clinic-scheduler-ui-ux-revision.md`
- Modify: `src/server/services/student-import-csv.test.ts`
- Modify: `src/server/services/student-import-csv.ts`
- Modify: `src/components/schedules/ScheduleImportForm.test.tsx`
- Modify: `src/components/schedules/ScheduleImportForm.tsx`
- Modify: `README.md`

**Interfaces:**
- Keep `parseStudentImportCsv(input: string | ArrayBuffer | Uint8Array): ImportedStudentRow[]` unchanged.
- Return string inputs to the CSV parser unchanged.
- For byte inputs, try `new TextDecoder("utf-8", { fatal: true })` first and use `new TextDecoder("windows-1252")` only when strict UTF-8 decoding fails.
- Keep UTF-16 unsupported and preserve all schema, limit, validation, and atomic transaction behavior.

- [ ] **Step 1: Add focused parser regressions and verify RED**

Add tests for UTF-8 bytes without a BOM, UTF-8 bytes with a BOM, Windows-1252 bytes containing `Peña` (`0xF1`), malformed CSV, and the existing exact-header rejection.

```bash
npm test -- src/server/services/student-import-csv.test.ts
```

Expected: the Windows-1252 test fails under the current strict UTF-8-only decoder; the UTF-8 and validation tests pass.

- [ ] **Step 2: Implement the minimal byte-decoding fallback and verify GREEN**

Decode the same byte array as Windows-1252 only inside the strict UTF-8 decoder's failure path. Do not add encoding sniffing, UTF-16 support, or a dependency.

```bash
npm test -- src/server/services/student-import-csv.test.ts
```

Expected: all parser tests pass.

- [ ] **Step 3: Test and update user-facing compatibility guidance**

First add copy assertions to the existing form test, verify that they fail, then update the form guidance to name CSV UTF-8 and Excel CSV (Comma delimited) / Windows-1252.

```bash
npm test -- src/components/schedules/ScheduleImportForm.test.tsx
```

Expected: the new copy assertions fail before the form update and pass afterward.

- [ ] **Step 4: Amend the approved documents and README**

Document the strict UTF-8-first fallback, unsupported UTF-16, unchanged nine-column/limit/atomic-import rules, Task 0, migration `010_maximum_only_capacity.sql`, and both accepted standard Excel CSV formats.

- [ ] **Step 5: Run focused verification**

```bash
npm test -- src/server/services/student-import-csv.test.ts src/components/schedules/ScheduleImportForm.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 6: Verify the external completed CSV without modifying it**

Read `C:\endless_refinement\microsoft_docs\Physical_Laboratory_Scheduling_Completed.csv` directly, confirm bytes `EF BB BF`, and parse exactly 280 rows. Do not copy the file into the repository.

- [ ] **Step 7: Run the complete test suite and commit**

```bash
npm test
git add docs/superpowers/specs/2026-07-22-clinic-scheduler-ui-ux-revision-design.md docs/superpowers/plans/2026-07-22-clinic-scheduler-ui-ux-revision.md src/server/services/student-import-csv.test.ts src/server/services/student-import-csv.ts src/components/schedules/ScheduleImportForm.test.tsx src/components/schedules/ScheduleImportForm.tsx README.md
git commit -m "feat: accept standard Windows CSV imports"
```

Expected: the full suite passes. If the recorded concurrent no-show baseline failure reproduces under load, rerun that exact test alone and report both results without changing no-show code.

---

### Task 1: Add a reusable accessible spinner and pending dialog state

**Files:**
- Create: `src/components/ui/Spinner.tsx`
- Modify: `src/components/ui/ConfirmDialog.tsx`
- Test: add or extend `src/components/ui/ConfirmDialog.test.tsx`

**Interfaces:**
- Produces: `Spinner({ size?: "sm" | "md"; label?: string; className?: string })`
- Produces: `ConfirmDialog` renders `aria-busy={pending}` and a spinner beside `pendingLabel`.

- [ ] **Step 1: Write the failing ConfirmDialog test**

Add a test that renders an open pending dialog and asserts:

```tsx
expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
expect(screen.getByRole("status", { name: "Working" })).toBeVisible();
expect(screen.getByRole("button", { name: /working/i })).toBeDisabled();
expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
```

Also dispatch Escape and verify `onCancel` is not called.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- src/components/ui/ConfirmDialog.test.tsx
```

Expected: FAIL because the dialog has no `aria-busy` attribute or status-role spinner.

- [ ] **Step 3: Implement `Spinner`**

Create a CSS spinner using an inline element with:

```tsx
<span
  role="status"
  aria-label={label}
  className={cn(
    "inline-block animate-spin rounded-full border-2 border-current border-r-transparent",
    size === "sm" ? "h-4 w-4" : "h-5 w-5",
    className,
  )}
/>
```

Use `cn` from `@/lib/cn`. Default `label` to `"Loading"`.

- [ ] **Step 4: Update `ConfirmDialog`**

Add `aria-busy={pending}` to the dialog container. When pending, render:

```tsx
<span className="inline-flex items-center gap-2">
  <Spinner size="sm" label={pendingLabel} />
  {pendingLabel}
</span>
```

Keep both buttons disabled and preserve the existing Escape guard.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- src/components/ui/ConfirmDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Spinner.tsx src/components/ui/ConfirmDialog.tsx src/components/ui/ConfirmDialog.test.tsx
git commit -m "feat: add accessible pending dialog feedback"
```

---

### Task 2: Keep schedule import locked through successful navigation

**Files:**
- Modify: `src/components/schedules/ScheduleImportForm.tsx`
- Test: `src/components/schedules/ScheduleImportForm.test.tsx`

**Interfaces:**
- Consumes: `ConfirmDialog.pending` and `Spinner` from Task 1.
- Produces: exactly one `/api/schedule-imports` POST while `pending` is true.

- [ ] **Step 1: Add a deferred-success regression test**

Use a deferred promise for `fetch`. Click **Agree and import** twice, then assert:

```tsx
expect(fetchMock).toHaveBeenCalledTimes(1);
expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
expect(screen.getByRole("button", { name: /importing and publishing/i })).toBeDisabled();
```

Resolve the request successfully, wait for `router.push`, and assert the pending button is still disabled because the component has not unmounted.

- [ ] **Step 2: Add a failure-reset test**

Return a 422 response and verify the dialog closes, the form error appears, and **Review import** becomes enabled again.

- [ ] **Step 3: Run the focused test and verify failure**

```bash
npm test -- src/components/schedules/ScheduleImportForm.test.tsx
```

Expected: the success-path test fails because `finally` resets `pending`.

- [ ] **Step 4: Refactor `submit()`**

Use an explicit success flag or early-return structure:

```ts
setPending(true);
try {
  const response = await fetch(...);
  const payload = await response.json();
  if (!response.ok) {
    setConfirmOpen(false);
    setError(...);
    setPending(false);
    return;
  }
  router.push(...);
  router.refresh();
} catch {
  setConfirmOpen(false);
  setError(...);
  setPending(false);
}
```

Do not use a `finally` that resets pending after success.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/components/schedules/ScheduleImportForm.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/schedules/ScheduleImportForm.tsx src/components/schedules/ScheduleImportForm.test.tsx
git commit -m "fix: keep schedule import locked during navigation"
```

---

### Task 3: Extract the shared appointment detail renderer

**Files:**
- Create: `src/components/appointments/AppointmentDetail.tsx`
- Modify: `src/app/(dashboard)/appointments/[appointmentId]/page.tsx`
- Test: `src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx`

**Interfaces:**
- Produces:

```ts
type AppointmentDetailProps = {
  appointmentId: string;
  expectedScheduleType?: "LABORATORY" | "PHYSICAL_EXAM";
  source: "APPOINTMENTS" | "LABORATORY" | "PHYSICAL_EXAM";
};
```

- `AppointmentDetail` loads the current user and appointment, applies clinic access rules, validates `expectedScheduleType`, and renders header, metadata, actions, and history.

- [ ] **Step 1: Write a failing shared-component route test**

Update the Appointments detail-page test to mock a new `AppointmentDetail` component and assert the page passes:

```tsx
<AppointmentDetail
  appointmentId="appointment-1"
  source="APPOINTMENTS"
/>
```

- [ ] **Step 2: Extract existing page content**

Move the current appointment loading, `canCorrectNoShow`, header, action, and history rendering into `AppointmentDetail.tsx`.

- [ ] **Step 3: Add expected-service validation**

After loading the appointment:

```ts
if (expectedScheduleType && appointment.scheduleType !== expectedScheduleType) notFound();
```

Continue using `requireUser(["ADMIN", "CLINIC_STAFF"])`. For clinic staff, explicitly call the same clinic-access check used by clinic pages or compare `user.clinicId` to `appointment.clinicId` before rendering.

- [ ] **Step 4: Reduce the Appointments page to a wrapper**

The page should await params and return `AppointmentDetail` with source `APPOINTMENTS`.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/appointments/AppointmentDetail.tsx 'src/app/(dashboard)/appointments/[appointmentId]/page.tsx' 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx'
git commit -m "refactor: share appointment detail rendering"
```

---

### Task 4: Add clinic-context detail routes and links

**Files:**
- Create: `src/app/(dashboard)/laboratory/[appointmentId]/page.tsx`
- Create: `src/app/(dashboard)/laboratory/[appointmentId]/page.test.tsx`
- Create: `src/app/(dashboard)/physical-exam/[appointmentId]/page.tsx`
- Create: `src/app/(dashboard)/physical-exam/[appointmentId]/page.test.tsx`
- Modify: `src/components/appointments/ClinicPublishedSchedule.tsx`
- Test: `src/components/appointments/ClinicPublishedSchedule.test.tsx`

**Interfaces:**
- `ClinicPublishedSchedule.basePath` becomes the detail-route prefix as well as the pagination prefix.
- Laboratory detail consumes `expectedScheduleType="LABORATORY"`.
- Physical detail consumes `expectedScheduleType="PHYSICAL_EXAM"`.

- [ ] **Step 1: Change the ClinicPublishedSchedule test expectations**

For `basePath="/laboratory"`, expect:

```tsx
expect(openLink).toHaveAttribute("href", "/laboratory/appointment-1");
```

For physical exam, expect `/physical-exam/appointment-1`.

- [ ] **Step 2: Implement context-preserving links**

Change:

```tsx
href={`/appointments/${appointment.id}`}
```

To:

```tsx
href={`${basePath}/${appointment.id}`}
```

- [ ] **Step 3: Add Laboratory route test**

Mock `AppointmentDetail` and assert:

```tsx
expect(AppointmentDetail).toHaveBeenCalledWith(expect.objectContaining({
  appointmentId: "appointment-1",
  expectedScheduleType: "LABORATORY",
  source: "LABORATORY",
}), undefined);
```

- [ ] **Step 4: Add Physical Exam route test**

Use the equivalent `PHYSICAL_EXAM` values.

- [ ] **Step 5: Implement both route wrappers**

Each page awaits `params` and returns the shared detail component with the correct source and expected type.

- [ ] **Step 6: Add wrong-service behavior to AppointmentDetail tests**

Mock a physical appointment on the Laboratory route and assert `notFound()` is called. Repeat in the opposite direction.

- [ ] **Step 7: Run tests**

```bash
npm test -- src/components/appointments/ClinicPublishedSchedule.test.tsx 'src/app/(dashboard)/laboratory/[appointmentId]/page.test.tsx' 'src/app/(dashboard)/physical-exam/[appointmentId]/page.test.tsx' 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/appointments/ClinicPublishedSchedule.tsx src/components/appointments/ClinicPublishedSchedule.test.tsx 'src/app/(dashboard)/laboratory/[appointmentId]' 'src/app/(dashboard)/physical-exam/[appointmentId]'
git commit -m "feat: preserve clinic context on appointment profiles"
```

---

### Task 5: Define protected-result checks and placeholder cleanup

**Files:**
- Modify: `src/server/repositories/student-result-submissions.repository.ts`
- Test: `src/server/services/student-result-submissions.integration.test.ts`

**Interfaces:**
- Produces:

```ts
type AppointmentResultCorrectionState =
  | { type: "CLEAR" }
  | { type: "PENDING_PLACEHOLDER"; resultId: string; table: "laboratory_results" | "exam_results" }
  | { type: "PROTECTED"; reason: "FINALIZED_SUBMISSION" | "UPLOADED_FILES" | "VERIFIED_RESULT" };

export async function getAppointmentResultCorrectionState(
  client: PoolClient,
  appointment: { id: string; scheduleType: string },
): Promise<AppointmentResultCorrectionState>;

export async function deletePendingResultPlaceholder(
  client: PoolClient,
  state: Extract<AppointmentResultCorrectionState, { type: "PENDING_PLACEHOLDER" }>,
): Promise<void>;
```

- [ ] **Step 1: Write integration fixtures for four states**

Cover:

1. Completed appointment with no result row → `CLEAR`.
2. Result row with `PENDING_UPLOAD`, no draft/finalized submission and no files → `PENDING_PLACEHOLDER`.
3. Any non-`PENDING_UPLOAD` result → `PROTECTED/VERIFIED_RESULT`.
4. Finalized submission or any non-deleted file → protected with the matching reason.

- [ ] **Step 2: Run the integration test and verify failure**

```bash
npm test -- src/server/services/student-result-submissions.integration.test.ts
```

Expected: FAIL because the repository helpers do not exist.

- [ ] **Step 3: Implement a locked inspection query**

Within the provided transaction client:

- Select the service-specific result row `FOR UPDATE`.
- Select any submission for the appointment `FOR UPDATE`.
- Count active files joined through the submission.
- Return protected before returning a deletable placeholder.

Do not interpolate any user-controlled table value. Derive the table exclusively from the trusted appointment schedule type.

- [ ] **Step 4: Implement exact placeholder deletion**

Delete by both result ID and `result_status='PENDING_UPLOAD'`. Assert one row was deleted; otherwise throw `APPOINTMENT_RESULT_CONFLICT` with HTTP 409.

- [ ] **Step 5: Run integration tests**

```bash
npm test -- src/server/services/student-result-submissions.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/repositories/student-result-submissions.repository.ts src/server/services/student-result-submissions.integration.test.ts
git commit -m "feat: protect result data during status corrections"
```

---

### Task 6: Add audited `COMPLETED → PENDING/NO_SHOW` corrections

**Files:**
- Modify: `src/server/services/appointments.service.ts`
- Modify: `src/server/repositories/appointments.repository.ts`
- Test: `src/server/services/appointments.service.test.ts`

**Interfaces:**
- Extends `appointmentUpdateSchema` with:

```ts
correctionReason: z.string().trim().min(3).max(1000).optional(),
source: z.enum(["APPOINTMENTS", "LABORATORY", "PHYSICAL_EXAM"]).optional(),
```

- Produces `correctCompletedAppointmentWithClient(...)` or an equivalent focused private service function.

- [ ] **Step 1: Replace the old rejection test**

Change the test that expects `COMPLETED → PENDING` to fail. New transition tests must assert:

- Ordinary `assertStatusTransition("COMPLETED", "PENDING")` remains rejected so corrections cannot accidentally use the ordinary path.
- `updateAppointment` accepts a completed correction only when `correctionReason` is present.

- [ ] **Step 2: Add service tests for successful corrections**

For both target statuses, assert the transaction performs in this order:

1. Lock appointment.
2. Authorize actor.
3. Validate target and reason.
4. Inspect result correction state.
5. Delete only a safe pending placeholder.
6. Change appointment status.
7. Write audit action `APPOINTMENT_STATUS_CORRECTED`.

Expected audit metadata:

```ts
{
  oldStatus: "COMPLETED",
  newStatus: target,
  reason: "Incorrect student selected",
  source: "LABORATORY",
}
```

- [ ] **Step 3: Add rejection tests**

Cover:

- Missing or whitespace-only reason → `CORRECTION_REASON_REQUIRED`, 422.
- Target other than `PENDING` or `NO_SHOW` → 422.
- `NO_SHOW` correction when appointment date is today or future in Manila → `NO_SHOW_REQUIRES_PAST_DATE`, 422.
- Protected result state → `APPOINTMENT_RESULT_PROTECTED`, 409.
- Clinic staff from another clinic → 403.

- [ ] **Step 4: Implement the correction branch before ordinary transition handling**

After schema parsing and authorization, detect:

```ts
if (current.status === "COMPLETED" && input.status && ["PENDING", "NO_SHOW"].includes(input.status)) {
  // transactional correction path
}
```

Re-read and lock the appointment inside the transaction; do not rely only on the preflight value.

- [ ] **Step 5: Use Manila date validation for corrected no-show**

Reuse or extract the existing Manila-date helper. Require `appointment.appointmentDate < manilaToday()`.

- [ ] **Step 6: Keep concurrency protection**

Call `changeAppointmentStatusWithClient(client, id, "COMPLETED", target, reason, actor.userId)` so a stale correction fails with 409.

- [ ] **Step 7: Run tests**

```bash
npm test -- src/server/services/appointments.service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/services/appointments.service.ts src/server/services/appointments.service.test.ts src/server/repositories/appointments.repository.ts
git commit -m "feat: add audited completed appointment corrections"
```

---

### Task 7: Add the completed-status correction UI

**Files:**
- Create: `src/components/appointments/CompletedStatusCorrection.tsx`
- Modify: `src/components/appointments/AppointmentActions.tsx`
- Modify: `src/components/appointments/AppointmentDetail.tsx`
- Test: `src/components/appointments/AppointmentActions.test.tsx`
- Test: add `src/components/appointments/CompletedStatusCorrection.test.tsx`

**Interfaces:**
- Produces:

```ts
type CompletedStatusCorrectionProps = {
  appointmentId: string;
  appointmentDate: string;
  source: "APPOINTMENTS" | "LABORATORY" | "PHYSICAL_EXAM";
};
```

- Sends PATCH body:

```ts
{
  status: "PENDING" | "NO_SHOW",
  correctionReason: string,
  source,
}
```

- [ ] **Step 1: Write component tests**

Assert the completed correction card:

- Offers **Pending** and **No-show**.
- Requires a correction reason.
- Opens a confirmation dialog before PATCH.
- Disables controls and shows a spinner during PATCH.
- Refreshes after success.
- Displays server error after failure.

- [ ] **Step 2: Add date-sensitive No-show behavior**

For today/future appointment dates, disable the No-show option and render helper text: `No-show corrections are available only after the appointment date.`

Backend remains authoritative.

- [ ] **Step 3: Implement the component**

Use a warning-styled bordered section and `ConfirmDialog`. Keep state local and prevent duplicate submit with `pending`.

- [ ] **Step 4: Integrate into AppointmentDetail**

Pass `appointmentDate` and `source`. Render the correction component only when `appointment.status === "COMPLETED"`.

- [ ] **Step 5: Keep ordinary AppointmentActions focused**

Do not add completed corrections to the ordinary status dropdown. Preserve pending completion/cancellation, automatic no-show correction, and rescheduling behavior.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/components/appointments/AppointmentActions.test.tsx src/components/appointments/CompletedStatusCorrection.test.tsx 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/appointments/CompletedStatusCorrection.tsx src/components/appointments/CompletedStatusCorrection.test.tsx src/components/appointments/AppointmentActions.tsx src/components/appointments/AppointmentActions.test.tsx src/components/appointments/AppointmentDetail.tsx
git commit -m "feat: add safe completed status correction UI"
```

---

### Task 8: Centralize user-facing status labels

**Files:**
- Create: `src/components/appointments/status-labels.ts`
- Test: add `src/components/appointments/status-labels.test.ts`
- Modify later consumers in Tasks 9 and 10.

**Interfaces:**
- Produces:

```ts
export function appointmentResultStatusLabel(value: string): string;
export function overallStatusLabel(value: string): string;
export function operationalStatusLabel(value: string): string;
export function statusTone(value: string): "success" | "danger" | "warning" | "neutral";
```

- [ ] **Step 1: Write table-driven unit tests**

Cover every mapping from the approved design, plus operational values such as `NO_SHOW → No-show`.

- [ ] **Step 2: Implement exhaustive mappings with readable fallback**

Fallback:

```ts
return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/components/appointments/status-labels.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/appointments/status-labels.ts src/components/appointments/status-labels.test.ts
git commit -m "refactor: centralize appointment status labels"
```

---

### Task 9: Simplify the Appointments filters

**Files:**
- Modify: `src/app/(dashboard)/appointments/page.tsx`
- Test: `src/app/(dashboard)/appointments/page.test.tsx`

**Interfaces:**
- Retained URL parameters: `studentNumber`, `overallStatus`, `laboratoryStatus`, `physicalExamStatus`, `sort`, `page`.
- Removed from generated links/forms: `appointmentDate`, `appointmentStatus`, `status`, `collegeId`, `programId`, `priorityGroupId`.

- [ ] **Step 1: Rewrite the page test around the approved filter row**

Assert these controls exist:

- Student name or number
- Overall completion
- Laboratory status
- Physical exam status
- Sort
- Apply filters
- Clear filters

Assert **More filters**, Appointment date, Appointment status, College, Program, and Priority are absent.

- [ ] **Step 2: Assert readable option labels**

Verify the result-status selects display `Pending`, `Completed`, `Needs follow-up`, and `Not applicable`, while values remain the internal enums.

- [ ] **Step 3: Remove unused reference-data queries**

Delete `listColleges`, `listPrograms`, and `listPriorityGroups` imports and `Promise.all` entries.

- [ ] **Step 4: Simplify the repository call**

Pass only the retained filters. Remove `hasAdvancedFilters` and the `<details>` block.

- [ ] **Step 5: Use shared labels for table badges**

Render mapped labels instead of raw values for Laboratory, Physical exam, and Overall.

- [ ] **Step 6: Update the empty state exactly**

Use:

```text
No students match the selected filters. Clear one or more filters and try again.
```

- [ ] **Step 7: Ensure pagination preserves only retained parameters**

Update the expected next-page URL in tests.

- [ ] **Step 8: Run tests**

```bash
npm test -- 'src/app/(dashboard)/appointments/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add 'src/app/(dashboard)/appointments/page.tsx' 'src/app/(dashboard)/appointments/page.test.tsx'
git commit -m "feat: simplify appointment completion filters"
```

---

### Task 10: Add completion-filter repository regressions

**Files:**
- Modify: `src/server/repositories/appointment-summary.repository.ts`
- Test: `src/server/repositories/appointment-summary.repository.test.ts`
- Test: `src/server/repositories/appointment-summary.integration.test.ts`

**Interfaces:**
- `AppointmentSummaryFilters` retains only fields used by the simplified page plus optional `clinicCode` if other callers need it.
- Page items and metrics must use the exact same `WHERE` clause and values.

- [ ] **Step 1: Add an integration fixture with distinct combinations**

Create students representing:

1. Both results completed.
2. Laboratory pending, physical completed.
3. Laboratory follow-up, physical completed.
4. Both pending.

- [ ] **Step 2: Add exact filter assertions**

Verify:

```ts
laboratoryStatus: "COMPLETED", physicalExamStatus: "COMPLETED"
```

returns only the both-completed student and metrics total `1`.

Also verify each combination listed in the approved design.

- [ ] **Step 3: Inspect and fix placeholder semantics**

Ensure absent result rows continue to coalesce to `PENDING_UPLOAD`, so filtering by `PENDING_UPLOAD` includes both explicit placeholders and students with no result row.

- [ ] **Step 4: Remove unused filter branches if no callers remain**

After repository-wide search, remove appointment-date, appointment-status, college, program, and priority fields only when no other caller uses `appointmentSummaryReport`. Do not remove `clinicCode` if compliance or dashboards still depend on it.

- [ ] **Step 5: Keep one shared `where` and `values` source**

The row query and summary query must use the same built clauses. Add a unit assertion that both query calls receive equivalent filter values before pagination values are appended.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts 'src/app/(dashboard)/appointments/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/repositories/appointment-summary.repository.ts src/server/repositories/appointment-summary.repository.test.ts src/server/repositories/appointment-summary.integration.test.ts
git commit -m "fix: make completion filters and metrics consistent"
```

---

### Task 11: Remove the Results workspace and preserve old bookmarks

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`
- Test: `src/components/layout/Sidebar.test.tsx`
- Modify: `src/app/(dashboard)/results/page.tsx`
- Test: `src/app/(dashboard)/results/page.test.tsx`
- Delete: `src/components/tracking/ResultsWorkspace.tsx`
- Delete: `src/app/api/results/route.ts`
- Delete: `src/app/api/results/route.test.ts`

**Interfaces:**
- `/results` performs `redirect("/appointments")`.
- No primary navigation role sees Results.

- [ ] **Step 1: Update Sidebar tests**

Assert clinic staff and administrators do not see Results. Keep coordinator assertions unchanged.

- [ ] **Step 2: Remove Results from `primaryLinks`**

Delete the `Results` tuple.

- [ ] **Step 3: Replace Results page with redirect**

Use:

```ts
import { redirect } from "next/navigation";

export default function ResultsPage() {
  redirect("/appointments");
}
```

- [ ] **Step 4: Rewrite the Results page test**

Mock `redirect` and assert it is called with `/appointments`.

- [ ] **Step 5: Delete workspace and API files**

Before deletion, search for `ResultsWorkspace`, `/api/results`, `recordResult`, and `resultsForStudent`. Remove only functions that become truly unused. Keep shared tracking/result functions still used by compliance, uploads, or history.

- [ ] **Step 6: Run targeted tests and type-check through build later**

```bash
npm test -- src/components/layout/Sidebar.test.tsx 'src/app/(dashboard)/results/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/Sidebar.tsx src/components/layout/Sidebar.test.tsx 'src/app/(dashboard)/results/page.tsx' 'src/app/(dashboard)/results/page.test.tsx'
git rm src/components/tracking/ResultsWorkspace.tsx src/app/api/results/route.ts src/app/api/results/route.test.ts
git commit -m "refactor: remove legacy results workspace"
```

---

### Task 12: Normalize the database to maximum-only capacity

**Files:**
- Create: `database/migrations/010_maximum_only_capacity.sql`
- Modify: `src/server/repositories/appointments.repository.ts`
- Modify: `src/server/services/appointments.service.ts`
- Test: `src/server/services/appointments.service.test.ts`
- Test: `src/app/api/settings/capacity/route.test.ts`

**Interfaces:**
- `changeCapacity` input becomes:

```ts
{
  clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY";
  maxDailyCapacity: number;
}
```

- `updateCapacitySetting(clinicCode, scheduleType, max)` writes both legacy columns to `max`.

- [ ] **Step 1: Write migration**

Use:

```sql
BEGIN;

UPDATE clinic_capacity_settings
SET safe_daily_capacity = max_daily_capacity
WHERE safe_daily_capacity <> max_daily_capacity;

COMMENT ON COLUMN clinic_capacity_settings.safe_daily_capacity IS
  'Deprecated compatibility column. Must equal max_daily_capacity.';

COMMIT;
```

Do not drop the column.

- [ ] **Step 2: Update service schema tests**

Assert a payload with only `maxDailyCapacity` succeeds, while missing/non-positive maximum fails.

- [ ] **Step 3: Simplify `capacitySchema`**

Remove `safeDailyCapacity` and the cross-field refinement.

- [ ] **Step 4: Update repository write**

Set:

```sql
safe_daily_capacity=$3,
max_daily_capacity=$3
```

Return only `maxDailyCapacity` to service/UI callers unless a low-level scheduling query still temporarily selects both.

- [ ] **Step 5: Update audit metadata**

Audit only clinic code, schedule type, and maximum capacity. Do not use “safe” or “recommended” labels.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/server/services/appointments.service.test.ts src/app/api/settings/capacity/route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add database/migrations/010_maximum_only_capacity.sql src/server/repositories/appointments.repository.ts src/server/services/appointments.service.ts src/server/services/appointments.service.test.ts src/app/api/settings/capacity/route.test.ts
git commit -m "refactor: make maximum the only capacity setting"
```

---

### Task 13: Simplify the Capacity administration UI

**Files:**
- Modify: `src/components/settings/CapacityForm.tsx`
- Add or modify: `src/components/settings/CapacityForm.test.tsx`
- Modify: `src/app/(dashboard)/settings/capacity/page.tsx`

**Interfaces:**
- Capacity settings passed to the form contain `clinicCode`, `clinicName`, `scheduleType`, and `maxDailyCapacity` only.

- [ ] **Step 1: Write the form test**

Assert:

- The page shows `Maximum students per day`.
- `Recommended`, `Warning`, and `Safe` are absent.
- PATCH body contains no `safeDailyCapacity`.
- Save button shows spinner and disables during the request.

- [ ] **Step 2: Refactor `CapacityForm` into readable multiline JSX**

The current one-line component should be reformatted while changing it. Add local pending state keyed by `${clinicCode}:${scheduleType}` so only the submitted card is disabled.

- [ ] **Step 3: Send maximum-only payload**

```ts
body: JSON.stringify({
  clinicCode: form.get("clinicCode"),
  scheduleType: form.get("scheduleType"),
  maxDailyCapacity: Number(form.get("maxDailyCapacity")),
})
```

- [ ] **Step 4: Update page copy**

Use description: `Configure the maximum number of students each clinic service can handle per day.`

- [ ] **Step 5: Run tests**

```bash
npm test -- src/components/settings/CapacityForm.test.tsx src/app/api/settings/capacity/route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/CapacityForm.tsx src/components/settings/CapacityForm.test.tsx 'src/app/(dashboard)/settings/capacity/page.tsx'
git commit -m "feat: simplify capacity administration"
```

---

### Task 14: Remove warning capacity from rule-engine types and checks

**Files:**
- Modify: `src/server/rule-engine/types.ts`
- Modify: `src/server/rule-engine/capacity-rules.ts`
- Test: add or update `src/server/rule-engine/capacity-rules.test.ts`
- Modify tests: `src/server/rule-engine/generate-schedule.test.ts`

**Interfaces:**
- `CapacityStatus` becomes `"VALID" | "CONFLICT"`.
- `CapacitySetting` and `PairedScheduleCapacity` contain `maxDailyCapacity` only.
- `CapacityCheckResult` removes `safeCapacity`.

- [ ] **Step 1: Write failing capacity-rule tests**

Assert:

- Count equal to maximum → VALID.
- Count below maximum → VALID.
- Count above maximum → CONFLICT.
- No WARNING result or recommended-capacity message exists.

- [ ] **Step 2: Simplify `checkCapacity`**

Implement:

```ts
const status = count > setting.maxDailyCapacity ? "CONFLICT" : "VALID";
```

Messages:

- Conflict: `${count} appointments exceed the maximum capacity of ${max}.`
- Valid: `This date is within the maximum daily capacity.`

- [ ] **Step 3: Update rule-engine fixtures**

Remove every `safeDailyCapacity` field from test inputs and expected outputs.

- [ ] **Step 4: Run tests**

```bash
npm test -- src/server/rule-engine/capacity-rules.test.ts src/server/rule-engine/generate-schedule.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/rule-engine/types.ts src/server/rule-engine/capacity-rules.ts src/server/rule-engine/capacity-rules.test.ts src/server/rule-engine/generate-schedule.test.ts
git commit -m "refactor: remove capacity warning state"
```

---

### Task 15: Propagate maximum-only capacity through automatic scheduling

**Files:**
- Modify: `src/server/rule-engine/generate-paired-schedule.ts`
- Test: `src/server/rule-engine/generate-paired-schedule.test.ts`
- Modify: `src/server/services/priority-displacement.service.ts`
- Test: `src/server/services/priority-displacement.integration.test.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Test: clinic-calendar service tests
- Modify repository/service fixtures found by searching `safeDailyCapacity` and `safe_daily_capacity`

**Interfaces:**
- Every scheduler uses `maxDailyCapacity` as its sole ceiling.

- [ ] **Step 1: Search all operational uses**

Run:

```bash
rg "safeDailyCapacity|safe_daily_capacity|recommended capacity|CapacityStatus.*WARNING|\bWARNING\b" src scripts database/seeds README.md
```

Classify each match as compatibility storage, operational logic, UI copy, test fixture, or documentation.

- [ ] **Step 2: Update paired scheduling tests**

Create a case where the old safe limit is lower than maximum conceptually and assert assignments fill the date up to maximum before moving to the next date.

- [ ] **Step 3: Update paired schedule implementation**

Replace every `Math.min(safe, max)` or safe-based comparison with maximum only.

- [ ] **Step 4: Update priority displacement**

All candidate-date capacity checks must compare load against maximum only. Update integration expectations to prove a date remains eligible until maximum is reached.

- [ ] **Step 5: Update clinic-closure rescheduling**

Change `firstAvailable` to accept only `maxCapacity`. Query may still select the legacy safe column temporarily, but it must not influence decisions. Prefer removing it from the selected row type.

- [ ] **Step 6: Update schedule import repositories and fixtures**

Any capacity object passed into `generatePairedSchedule` must provide maximum only.

- [ ] **Step 7: Run all scheduling tests**

```bash
npm test -- src/server/rule-engine/generate-paired-schedule.test.ts src/server/services/priority-displacement.integration.test.ts src/server/services/schedule-import-lifecycle.integration.test.ts src/test/automated-scheduling-student-portal.e2e.integration.test.ts
```

Expected: PASS with no warning-state assertions.

- [ ] **Step 8: Re-run the search**

Only intentional database compatibility matches should remain. UI, service interfaces, and operational logic must contain no recommended/safe capacity behavior.

- [ ] **Step 9: Commit**

```bash
git add src/server/rule-engine src/server/services src/server/repositories scripts database/seeds README.md
git commit -m "fix: use maximum capacity across scheduling"
```

---

### Task 16: Add pure clinic-calendar date helpers

**Files:**
- Create: `src/components/settings/clinic-calendar.ts`
- Create: `src/components/settings/clinic-calendar.test.ts`

**Interfaces:**
- Produces:

```ts
export type CalendarDay = {
  date: string;
  dayOfMonth: number;
  inCurrentMonth: boolean;
  isWeekend: boolean;
};

export function buildMonthGrid(month: string): CalendarDay[];
export function expandUnavailableRanges(records: ClinicUnavailableDateRecord[]): Map<string, ClinicUnavailableDateRecord>;
export function shiftMonth(month: string, offset: number): string;
export function manilaToday(): string;
```

`month` format is `YYYY-MM`.

- [ ] **Step 1: Write month-grid tests**

Cover:

- Always returns 42 cells.
- Correct leading/trailing dates.
- Leap-year February.
- Weekend flags.
- Previous/next month rollover across December and January.

- [ ] **Step 2: Write unavailable-range expansion tests**

A range `2026-08-03` through `2026-08-05` maps all three dates to the original record.

- [ ] **Step 3: Implement helpers using UTC-safe date arithmetic**

Avoid browser-local timezone drift. Parse date-only strings into UTC components and format back to `YYYY-MM-DD`.

- [ ] **Step 4: Run tests**

```bash
npm test -- src/components/settings/clinic-calendar.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/clinic-calendar.ts src/components/settings/clinic-calendar.test.ts
git commit -m "feat: add clinic calendar date helpers"
```

---

### Task 17: Build the interactive unavailable-date calendar

**Files:**
- Create: `src/components/settings/ClinicUnavailableCalendar.tsx`
- Create: `src/components/settings/ClinicUnavailableCalendar.test.tsx`
- Modify: `src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx`
- Remove usage of: `src/components/settings/ClinicUnavailableDateForm.tsx`
- Delete `ClinicUnavailableDateForm.tsx` and its test only after repository search confirms no other caller.

**Interfaces:**
- Props:

```ts
type ClinicUnavailableCalendarProps = {
  clinics: Array<{ id: string; name: string }>;
  unavailableDates: ClinicUnavailableDateRecord[];
  initialMonth: string;
  today: string;
};
```

- POST payload for a clicked date:

```ts
{
  clinicId,
  startDate: date,
  endDate: date,
  category,
  reason,
}
```

- [ ] **Step 1: Write rendering tests**

Assert:

- Month title and weekday headers are visible.
- Future weekday cells are enabled after selecting clinic and entering a valid reason.
- Today, past dates, and weekends are disabled.
- Existing unavailable dates are disabled and expose category/reason details.

- [ ] **Step 2: Write click-success test**

After selecting clinic/category/reason and clicking one date, assert exactly one POST with identical start and end dates. While deferred, the cell is disabled and contains a spinner. After success, it displays unavailable state and a success message with moved counts.

- [ ] **Step 3: Write click-failure test**

Return a 409 error. Assert the cell returns to available state, remains clickable, and error text is visible.

- [ ] **Step 4: Implement controls**

Use buttons for previous/next month and a heading for the current month. Keep selected clinic, category, reason, month, pending date, records, success, and error in client state.

- [ ] **Step 5: Implement accessible day buttons**

Each date button needs an `aria-label` such as:

```text
August 18, 2026 — available
August 19, 2026 — unavailable: Maintenance, Generator testing
```

Use `aria-pressed` only if treating unavailable as a toggle; otherwise prefer disabled plus descriptive label.

- [ ] **Step 6: Update page data flow**

Server page continues to call `listClinicOptions()` and `listClinicUnavailableDateRecords()`. Compute Manila today and initial current month server-side, then render the calendar. Remove the old history table because unavailable information is available from cells and the details panel.

- [ ] **Step 7: Delete old form after search**

```bash
rg "ClinicUnavailableDateForm" src
```

If the page was the only consumer, delete the component and its test.

- [ ] **Step 8: Run tests**

```bash
npm test -- src/components/settings/clinic-calendar.test.ts src/components/settings/ClinicUnavailableCalendar.test.tsx 'src/app/(dashboard)/settings/clinic-unavailable-dates/page.test.tsx'
```

If no page test exists, create one that verifies the server page passes clinics and records to the calendar.

- [ ] **Step 9: Commit**

```bash
git add src/components/settings/ClinicUnavailableCalendar.tsx src/components/settings/ClinicUnavailableCalendar.test.tsx src/components/settings/clinic-calendar.ts src/components/settings/clinic-calendar.test.ts 'src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx' 'src/app/(dashboard)/settings/clinic-unavailable-dates/page.test.tsx'
git rm src/components/settings/ClinicUnavailableDateForm.tsx src/components/settings/ClinicUnavailableDateForm.test.tsx
git commit -m "feat: add clickable clinic unavailable calendar"
```

---

### Task 18: Verify the clinic-calendar API contract and rollback behavior

**Files:**
- Modify: `src/app/api/clinic-unavailable-dates/route.test.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Test: existing clinic-calendar service/integration test file

**Interfaces:**
- Existing `createClinicUnavailableDate` remains the single backend mutation for calendar clicks.
- A one-day block uses the same value for `startDate` and `endDate`.

- [ ] **Step 1: Add API test for one-day block**

Assert POST passes identical dates to the service and returns status 201 with moved counts.

- [ ] **Step 2: Add service test for overlap**

A one-day click on an already blocked date returns `CLINIC_BLOCK_OVERLAP`, 409, with no appointment updates.

- [ ] **Step 3: Add service test for protected appointments**

Verify transaction rollback leaves no unavailable-date record and no appointment mutation.

- [ ] **Step 4: Add service test for replacement failure**

Verify `CLINIC_BLOCK_REPLACEMENT_UNAVAILABLE` rolls back the entire operation.

- [ ] **Step 5: Refactor only where needed**

Do not duplicate scheduling logic in the UI or API. Keep all affected-appointment locks, pair handling, rescheduling, notifications, and audits in `clinic-calendar.service.ts`.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/app/api/clinic-unavailable-dates/route.test.ts src/server/services/clinic-calendar.service.test.ts
```

Use the actual existing integration-test filename if different.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/clinic-unavailable-dates/route.test.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.service.test.ts
git commit -m "test: verify calendar clinic block safety"
```

---

### Task 19: Update labels and copy across affected clinic views

**Files:**
- Modify: `src/components/appointments/ClinicPublishedSchedule.tsx`
- Modify: `src/components/appointments/AppointmentDetail.tsx`
- Modify: any affected dashboard/student status badges discovered by search
- Modify tests for those files

**Interfaces:**
- All visible enums use functions from `status-labels.ts`.

- [ ] **Step 1: Search raw enum rendering**

```bash
rg "PENDING_UPLOAD|REQUIRES_FOLLOW_UP|NOT_APPLICABLE|replaceAll\(\"_\"" src/app src/components
```

- [ ] **Step 2: Replace raw labels in scope**

At minimum update:

- Clinic schedule status select/options and badges.
- Appointment detail header badge and history rows.
- Appointments completion table and filters.

Do not broaden into unrelated admin enums unless the same medical-result statuses are visible there.

- [ ] **Step 3: Update tests to assert readable labels**

Keep internal option values unchanged.

- [ ] **Step 4: Run affected tests**

```bash
npm test -- src/components/appointments/ClinicPublishedSchedule.test.tsx src/components/appointments/status-labels.test.ts 'src/app/(dashboard)/appointments/page.test.tsx' 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/appointments src/app
git commit -m "refactor: show readable appointment status labels"
```

---

### Task 20: Run database migration and full verification

**Files:**
- No new source files unless verification exposes a defect.
- Modify: `README.md` if setup or feature descriptions are stale.

**Interfaces:**
- Entire application builds and all tests pass after migration 010.

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

Expected: successful install with no missing lockfile changes unless dependency metadata legitimately changes.

- [ ] **Step 2: Run migration against the configured development/test database**

```bash
npm run db:migrate
```

Expected: migration `010_maximum_only_capacity.sql` applies successfully and existing capacity rows have equal safe/max values.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: zero errors.

- [ ] **Step 5: Run production build**

```bash
npm run build
```

Expected: Next.js production build succeeds with no TypeScript or route errors.

- [ ] **Step 6: Run final repository searches**

```bash
rg "ResultsWorkspace|/api/results|Recommended|warning limit|safeDailyCapacity|CapacityStatus.*WARNING" src README.md
```

Expected:

- No Results workspace/API references.
- No user-facing recommended-capacity wording.
- `safeDailyCapacity` absent from application interfaces and operational logic.
- Any remaining `safe_daily_capacity` reference is documented compatibility persistence only.

- [ ] **Step 7: Manually verify critical flows**

Using `npm run dev`, verify:

1. Import dialog shows progress and cannot double-submit.
2. Laboratory Open keeps Laboratory active.
3. Physical Exam Open keeps Physical exam active.
4. Completed correction requires confirmation and reason.
5. Both-completed filter returns records.
6. No Results navigation exists; `/results` redirects.
7. Capacity page has only Maximum.
8. Clicking a future weekday calendar cell creates one unavailable date and updates the cell.
9. Failed calendar block does not leave a false unavailable state.

- [ ] **Step 8: Update README if necessary**

Remove references to the Results tab and recommended capacity. Document maximum-only capacity and calendar date blocking only if README currently describes these workflows.

- [ ] **Step 9: Commit verification fixes/documentation**

```bash
git add .
git commit -m "chore: verify clinic scheduler UX revision"
```

Skip this commit when verification produces no additional changes.

---

## Final Acceptance Checklist

- [ ] UTF-8 student CSV bytes parse with and without a BOM, and standard Excel CSV (Comma delimited) / Windows-1252 bytes parse without changing the nine-column schema or atomic import behavior.
- [ ] UTF-16 CSV remains unsupported; malformed CSV and incorrect headers remain rejected.
- [ ] Import confirmation remains visibly busy and locked until successful navigation or request failure.
- [ ] Laboratory and Physical Exam links preserve their sidebar context.
- [ ] Wrong-service clinic detail URLs return not found.
- [ ] Completed appointments can be corrected only to Pending or No-show with a reason.
- [ ] No-show correction is restricted to past appointment dates.
- [ ] Pending placeholders can be removed safely; protected result data cannot be destroyed.
- [ ] Appointments has one simple visible filter row with readable labels.
- [ ] Both-completed and mixed-result filters return correct rows, metrics, and pagination.
- [ ] Results is absent from navigation and `/results` redirects to `/appointments`.
- [ ] Capacity administration and scheduling use maximum only.
- [ ] No WARNING capacity state remains in operational code.
- [ ] Clinic calendar cells create atomic one-day unavailable blocks with correct rollback behavior.
- [ ] Full test suite, lint, and production build pass.
