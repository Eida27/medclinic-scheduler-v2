# Clinic Calendar Batch Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the immediate-write Clinic Calendar with a January–December draft editor that saves block and unblock changes for both clinics in one atomic transaction and safely restores appointments moved by mistaken blocks.

**Architecture:** Keep the existing admin route and scheduling rules, but add a shared batch contract, database-backed soft-unblocking/restoration history, repository-level locking helpers, and a two-phase planner that validates the complete target calendar before mutating records. Refactor the client into a draft-state editor composed of focused toolbar, grid, summary, confirmation, and navigation-protection units.

**Tech Stack:** Next.js 16.2.6 App Router, React 19.2.4, TypeScript 5, Tailwind CSS 4, PostgreSQL via `pg`, Zod 4.4.3, Vitest 4.1.8, Testing Library.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-26-clinic-calendar-batch-editor-design.md` exactly.
- The editor supports January through December for the current calendar year through year `2100`; previous years cannot be selected or edited.
- Today and past dates are not editable. All date comparisons use `Asia/Manila`.
- Saturdays and Sundays remain visible but cannot be newly blocked or unblocked.
- Persist unsaved changes across month, year, and clinic switches in the current browser session.
- One Save confirmation submits every staged change for both clinics as one all-or-nothing transaction.
- New active unavailable-date records are single-day records: `start_date = end_date`.
- Never physically delete an unavailable-date record during normal calendar editing.
- Unblocking uses all-or-nothing safe restoration. Do not override completed, no-show, cancelled, manually locked, independently rescheduled, unpublished, or result-protected appointments.
- A KABALAKA block/restoration moves or restores the Laboratory and paired Physical Examination appointments together.
- A CPU Clinic block/restoration moves or restores only the Physical Examination appointment.
- Reuse the advisory lock key `medclinic:schedule-import-queue` so calendar saves serialize with CSV publication and scheduling.
- Use TDD: add a focused failing test before each production behavior change.
- Run focused tests after every task, then run migration, the complete test suite, lint, production build, and browser acceptance before completion.

---

## File Structure

### New files

- `database/migrations/012_clinic_calendar_batch_editor.sql` — soft-unblock/restoration columns, legacy range normalization, and active-date uniqueness.
- `src/types/clinic-calendar.ts` — shared request, response, issue, category, and draft contracts.
- `src/server/repositories/clinic-calendar-restoration.repository.ts` — locked reschedule-event/original/replacement read model and restoration mutations.
- `src/server/services/clinic-calendar-planner.ts` — pure/deterministic target blocked-set, projected-load, block-plan, and restoration-plan helpers.
- `src/server/services/clinic-calendar-planner.test.ts` — pure planning tests.
- `src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts` — active-row, optimistic-lock, and soft-unblock repository tests.
- `src/components/settings/clinic-calendar-draft.ts` — pure draft reducer, displayed-state merge, and summaries.
- `src/components/settings/clinic-calendar-draft.test.ts` — draft toggle and summary tests.
- `src/components/settings/clinic-calendar/ClinicCalendarToolbar.tsx` — clinic/year/month controls.
- `src/components/settings/clinic-calendar/BlockConfigurationForm.tsx` — category/reason controls.
- `src/components/settings/clinic-calendar/ClinicCalendarDay.tsx` — one date cell and accessible state label.
- `src/components/settings/clinic-calendar/ClinicMonthGrid.tsx` — weekday headings, blank cells, and date grid.
- `src/components/settings/clinic-calendar/CalendarDraftSummary.tsx` — cross-clinic pending totals.
- `src/components/settings/clinic-calendar/CalendarSaveConfirmationDialog.tsx` — grouped review plus the single final confirmation.
- `src/components/settings/clinic-calendar/UnsavedCalendarChangesDialog.tsx` — internal-navigation discard warning.
- `src/components/settings/clinic-calendar/useUnsavedCalendarNavigation.ts` — `beforeunload` and same-origin link interception.
- `src/components/settings/clinic-calendar/presentational.test.tsx` — focused accessibility and rendering tests.

### Modified files

- `src/lib/errors.ts`
- `src/lib/api-response.ts`
- `src/server/repositories/clinic-unavailable-dates.repository.ts`
- `src/server/services/clinic-calendar.service.ts`
- `src/server/services/clinic-calendar.integration.test.ts`
- `src/server/services/priority-displacement.service.ts`
- `src/server/services/schedule-imports.service.ts`
- `src/app/api/clinic-unavailable-dates/route.ts`
- `src/app/api/clinic-unavailable-dates/route.test.ts`
- `src/components/settings/clinic-calendar.ts`
- `src/components/settings/clinic-calendar.test.ts`
- `src/components/settings/ClinicUnavailableCalendar.tsx`
- `src/components/settings/ClinicUnavailableCalendar.test.tsx`
- `src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx`
- `src/app/(dashboard)/settings/clinic-unavailable-dates/page.test.tsx`
- `src/server/db/database.integration.test.ts`
- `src/test/automated-scheduling-student-portal.e2e.integration.test.ts`
- `scripts/browser-clinic-scheduler-ux-fixture.ts`

---

### Task 1: Add soft-unblocking, restoration history, and active single-day invariants

**Files:**
- Create: `database/migrations/012_clinic_calendar_batch_editor.sql`
- Modify: `src/server/db/database.integration.test.ts`

**Interfaces:**
- Produces nullable `clinic_unavailable_dates.unblocked_at`, `unblocked_by`, and `batch_id`.
- Produces nullable `appointment_reschedule_events.restored_at`, `restored_by`, and `batch_id`.
- Produces partial unique index `clinic_unavailable_dates_one_active_day_idx`.
- Produces check constraints `clinic_unavailable_dates_unblock_complete`, `clinic_unavailable_dates_active_single_day`, and `appointment_reschedule_events_restore_complete`.

- [ ] **Step 1: Write failing database schema assertions**

Add a test that queries `information_schema.columns`, `pg_constraint`, and `pg_indexes` and asserts the exact new schema objects:

```ts
expect(columnNames).toEqual(expect.arrayContaining([
  "clinic_unavailable_dates.unblocked_at",
  "clinic_unavailable_dates.unblocked_by",
  "clinic_unavailable_dates.batch_id",
  "appointment_reschedule_events.restored_at",
  "appointment_reschedule_events.restored_by",
  "appointment_reschedule_events.batch_id",
]));
expect(constraintNames).toEqual(expect.arrayContaining([
  "clinic_unavailable_dates_unblock_complete",
  "clinic_unavailable_dates_active_single_day",
  "appointment_reschedule_events_restore_complete",
]));
expect(indexNames).toContain("clinic_unavailable_dates_one_active_day_idx");
```

Also assert the post-migration data invariants:

```ts
const activeRanges = await pool.query(
  `SELECT id::text
     FROM clinic_unavailable_dates
    WHERE unblocked_at IS NULL
      AND start_date <> end_date`,
);
expect(activeRanges.rows).toEqual([]);

await expect(pool.query(
  `INSERT INTO clinic_unavailable_dates (
     clinic_id, start_date, end_date, category, reason, created_by
   ) VALUES ($1,'2047-07-15','2047-07-16','CLOSURE','TEST invalid active range',$2)`,
  [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
)).rejects.toMatchObject({ code: "23514" });
```

- [ ] **Step 2: Run the focused database test and verify RED**

```bash
npm test -- src/server/db/database.integration.test.ts
```

Expected: FAIL because migration `012` and its columns, constraints, and index do not exist.

- [ ] **Step 3: Create migration 012 with deterministic legacy-range normalization**

Create `database/migrations/012_clinic_calendar_batch_editor.sql` with this transaction structure:

```sql
BEGIN;

ALTER TABLE clinic_unavailable_dates
  ADD COLUMN unblocked_at TIMESTAMPTZ,
  ADD COLUMN unblocked_by UUID REFERENCES users(id),
  ADD COLUMN batch_id UUID,
  ADD CONSTRAINT clinic_unavailable_dates_unblock_complete
    CHECK (
      (unblocked_at IS NULL AND unblocked_by IS NULL)
      OR
      (unblocked_at IS NOT NULL AND unblocked_by IS NOT NULL)
    );

ALTER TABLE appointment_reschedule_events
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD COLUMN restored_by UUID REFERENCES users(id),
  ADD COLUMN batch_id UUID,
  ADD CONSTRAINT appointment_reschedule_events_restore_complete
    CHECK (
      (restored_at IS NULL AND restored_by IS NULL)
      OR
      (restored_at IS NOT NULL AND restored_by IS NOT NULL)
    );

CREATE TEMP TABLE clinic_unavailable_date_split_map (
  source_id UUID NOT NULL,
  target_id UUID NOT NULL,
  blocked_date DATE NOT NULL,
  PRIMARY KEY (source_id, blocked_date),
  UNIQUE (target_id)
) ON COMMIT DROP;

INSERT INTO clinic_unavailable_date_split_map (source_id, target_id, blocked_date)
SELECT unavailable.id,
       CASE
         WHEN day::date = unavailable.start_date THEN unavailable.id
         ELSE gen_random_uuid()
       END,
       day::date
  FROM clinic_unavailable_dates unavailable
 CROSS JOIN LATERAL generate_series(
   unavailable.start_date,
   unavailable.end_date,
   INTERVAL '1 day'
 ) AS day
 WHERE unavailable.unblocked_at IS NULL
   AND unavailable.start_date <> unavailable.end_date;

INSERT INTO clinic_unavailable_dates (
  id, clinic_id, start_date, end_date, category, reason,
  created_by, created_at, updated_at, batch_id
)
SELECT split.target_id,
       source.clinic_id,
       split.blocked_date,
       split.blocked_date,
       source.category,
       source.reason,
       source.created_by,
       source.created_at,
       source.updated_at,
       source.batch_id
  FROM clinic_unavailable_date_split_map split
  JOIN clinic_unavailable_dates source ON source.id=split.source_id
 WHERE split.target_id <> split.source_id;

WITH event_block_date AS (
  SELECT event.id AS event_id,
         event.clinic_unavailable_date_id AS source_id,
         CASE clinic.code
           WHEN 'KABALAKA_CLINIC' THEN old_laboratory.appointment_date
           WHEN 'CPU_CLINIC' THEN old_physical.appointment_date
         END AS blocked_date
    FROM appointment_reschedule_events event
    JOIN clinic_unavailable_dates unavailable
      ON unavailable.id=event.clinic_unavailable_date_id
    JOIN clinics clinic ON clinic.id=unavailable.clinic_id
    LEFT JOIN appointments old_laboratory
      ON old_laboratory.id=event.old_laboratory_appointment_id
    LEFT JOIN appointments old_physical
      ON old_physical.id=event.old_physical_exam_appointment_id
   WHERE unavailable.unblocked_at IS NULL
     AND unavailable.start_date <> unavailable.end_date
)
UPDATE appointment_reschedule_events event
   SET clinic_unavailable_date_id=split.target_id
  FROM event_block_date cause
  JOIN clinic_unavailable_date_split_map split
    ON split.source_id=cause.source_id
   AND split.blocked_date=cause.blocked_date
 WHERE event.id=cause.event_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM appointment_reschedule_events event
      JOIN clinic_unavailable_dates unavailable
        ON unavailable.id=event.clinic_unavailable_date_id
      JOIN clinics clinic ON clinic.id=unavailable.clinic_id
      LEFT JOIN appointments old_laboratory
        ON old_laboratory.id=event.old_laboratory_appointment_id
      LEFT JOIN appointments old_physical
        ON old_physical.id=event.old_physical_exam_appointment_id
     WHERE unavailable.unblocked_at IS NULL
       AND unavailable.start_date <> unavailable.end_date
       AND NOT EXISTS (
         SELECT 1
           FROM clinic_unavailable_date_split_map split
          WHERE split.source_id=unavailable.id
            AND split.blocked_date=CASE clinic.code
              WHEN 'KABALAKA_CLINIC' THEN old_laboratory.appointment_date
              WHEN 'CPU_CLINIC' THEN old_physical.appointment_date
            END
       )
  ) THEN
    RAISE EXCEPTION 'Unable to normalize clinic unavailable-date reschedule history';
  END IF;
END
$$;

UPDATE clinic_unavailable_dates unavailable
   SET end_date=unavailable.start_date
 WHERE unavailable.id IN (
   SELECT DISTINCT source_id FROM clinic_unavailable_date_split_map
 );

ALTER TABLE clinic_unavailable_dates
  ADD CONSTRAINT clinic_unavailable_dates_active_single_day
    CHECK (unblocked_at IS NOT NULL OR start_date=end_date);

CREATE UNIQUE INDEX clinic_unavailable_dates_one_active_day_idx
  ON clinic_unavailable_dates (clinic_id, start_date)
  WHERE unblocked_at IS NULL;

CREATE INDEX clinic_unavailable_dates_active_lookup_idx
  ON clinic_unavailable_dates (clinic_id, start_date)
  WHERE unblocked_at IS NULL;

CREATE INDEX appointment_reschedule_events_active_block_idx
  ON appointment_reschedule_events (clinic_unavailable_date_id, restored_at)
  WHERE clinic_unavailable_date_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 4: Apply the migration and verify GREEN**

```bash
npm run db:migrate
npm test -- src/server/db/database.integration.test.ts
```

Expected: migration `012` applies once; schema assertions and range-normalization postconditions pass.

- [ ] **Step 5: Commit the schema change**

```bash
git add database/migrations/012_clinic_calendar_batch_editor.sql src/server/db/database.integration.test.ts
git commit -m "feat: add reversible clinic calendar schema"
```

---

### Task 2: Add shared batch contracts, structured issues, and active-date repository operations

**Files:**
- Create: `src/types/clinic-calendar.ts`
- Create: `src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts`
- Modify: `src/lib/errors.ts`
- Modify: `src/lib/api-response.ts`
- Modify: `src/server/repositories/clinic-unavailable-dates.repository.ts`
- Modify: `src/server/services/priority-displacement.service.ts`
- Modify: `src/server/services/schedule-imports.service.ts`

**Interfaces:**
- Produces `ClinicCalendarCategory`, `ClinicCalendarBatchChange`, `ClinicCalendarBatchRequest`, `ClinicCalendarBatchIssue`, and `ClinicCalendarBatchResult`.
- Produces `listActiveClinicUnavailableDateRecords()`.
- Produces `lockActiveClinicUnavailableDates(client, ids)`.
- Produces `insertClinicUnavailableDate(client, change, actorUserId, batchId)`.
- Produces `softUnblockClinicUnavailableDate(client, input): Promise<boolean>`.
- `AppError` gains optional `details?: unknown`; `errorResponse()` serializes it as `error.details`.

- [ ] **Step 1: Write failing repository and API-error tests**

Create repository integration cases:

```ts
const active = await listActiveClinicUnavailableDateRecords();
expect(active.some((record) => record.id === activeId)).toBe(true);
expect(active.some((record) => record.id === unblockedId)).toBe(false);
expect(active.find((record) => record.id === activeId)).toMatchObject({
  updatedAt: expect.any(String),
});

await expect(softUnblockClinicUnavailableDate(client, {
  id: activeId,
  expectedUpdatedAt: staleTimestamp,
  actorUserId: TEST_REFERENCE_IDS.adminUser,
  batchId,
})).resolves.toBe(false);
```

Add an `errorResponse()` assertion:

```ts
const response = errorResponse(new AppError(
  "CLINIC_CALENDAR_BATCH_REJECTED",
  "No calendar changes were saved.",
  409,
  undefined,
  { issues: [{ clinicId: "clinic-1", date: "2027-07-15", action: "UNBLOCK", code: "STALE_BLOCK", message: "The block changed." }] },
));
expect(await response.json()).toEqual({
  error: {
    code: "CLINIC_CALENDAR_BATCH_REJECTED",
    message: "No calendar changes were saved.",
    details: {
      issues: [expect.objectContaining({ code: "STALE_BLOCK" })],
    },
  },
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts src/lib/api-response.test.ts
```

Expected: FAIL because the shared contracts, active-only repository functions, and `details` support do not exist.

- [ ] **Step 3: Create the exact shared contract**

Create `src/types/clinic-calendar.ts`:

```ts
export type ClinicCalendarCategory =
  | "HOLIDAY"
  | "CLOSURE"
  | "MAINTENANCE"
  | "STAFF_UNAVAILABILITY";

export type ClinicCalendarBlockChange = {
  action: "BLOCK";
  clinicId: string;
  date: string;
  category: ClinicCalendarCategory;
  reason: string;
};

export type ClinicCalendarUnblockChange = {
  action: "UNBLOCK";
  clinicId: string;
  date: string;
  unavailableDateId: string;
  expectedUpdatedAt: string;
};

export type ClinicCalendarBatchChange =
  | ClinicCalendarBlockChange
  | ClinicCalendarUnblockChange;

export type ClinicCalendarBatchRequest = {
  changes: ClinicCalendarBatchChange[];
};

export type ClinicCalendarBatchIssue = {
  clinicId: string;
  date: string;
  action: ClinicCalendarBatchChange["action"];
  code:
    | "INVALID_CHANGE"
    | "ACTIVE_BLOCK_CONFLICT"
    | "STALE_BLOCK"
    | "PROTECTED_REPLACEMENT"
    | "MISSING_ORIGINAL"
    | "CAPACITY_CONFLICT"
    | "PAIR_INTEGRITY_FAILURE";
  message: string;
  studentNumbers?: string[];
  appointmentIds?: string[];
};

export type ClinicUnavailableDateDto = {
  id: string;
  clinicId: string;
  clinicCode: string;
  clinicName: string;
  startDate: string;
  endDate: string;
  category: ClinicCalendarCategory;
  reason: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type ClinicCalendarDraftChange = ClinicCalendarBatchChange;

export type ClinicCalendarBatchResult = {
  batchId: string;
  activeUnavailableDates: ClinicUnavailableDateDto[];
  blockedDateCount: number;
  unblockedDateCount: number;
  movedStudentCount: number;
  movedAppointmentCount: number;
  restoredStudentCount: number;
  restoredAppointmentCount: number;
};
```

In `clinic-unavailable-dates.repository.ts`, export `type ClinicUnavailableDateRecord = ClinicUnavailableDateDto` so repository results, server responses, and client props use the same canonical shape without a runtime import cycle.

- [ ] **Step 4: Extend `AppError` without changing existing response shapes**

Change the constructor to:

```ts
constructor(
  public readonly code: string,
  message: string,
  public readonly status = 400,
  public readonly fields?: Record<string, string[]>,
  public readonly details?: unknown,
) {
  super(message);
  this.name = "AppError";
}
```

Change `errorResponse()` to include `details: error.details`. JSON serialization must continue omitting `undefined`, so existing error snapshots remain unchanged.

- [ ] **Step 5: Implement active-only repository operations**

Update `ClinicUnavailableDateRecord` to include `updatedAt` through its DTO alias.

Make the list query active-only:

```sql
WHERE unavailable.unblocked_at IS NULL
ORDER BY unavailable.start_date DESC, unavailable.created_at DESC
```

Add these exact operations:

```ts
export async function lockActiveClinicUnavailableDates(
  client: PoolClient,
  ids: string[],
): Promise<LockedClinicUnavailableDate[]>;

export async function insertClinicUnavailableDate(
  client: PoolClient,
  input: ClinicCalendarBlockChange,
  actorUserId: string,
  batchId: string,
): Promise<string>;

export async function softUnblockClinicUnavailableDate(
  client: PoolClient,
  input: {
    id: string;
    expectedUpdatedAt: string;
    actorUserId: string;
    batchId: string;
  },
): Promise<boolean>;
```

The optimistic update must be:

```sql
UPDATE clinic_unavailable_dates
   SET unblocked_at=NOW(),
       unblocked_by=$3,
       batch_id=$4,
       updated_at=NOW()
 WHERE id=$1
   AND unblocked_at IS NULL
   AND updated_at=$2::timestamptz
RETURNING id
```

- [ ] **Step 6: Exclude soft-unblocked rows from every scheduling query**

In `priority-displacement.service.ts`, `schedule-imports.service.ts`, and every `clinic-calendar.service.ts` blocked-date query, add:

```sql
AND unavailable.unblocked_at IS NULL
```

Run:

```bash
rg -n "clinic_unavailable_dates" src scripts
```

Inspect every result. Every availability/scheduling read must explicitly choose active-only rows; historical/audit reads may intentionally include all rows and must include a comment stating that choice.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
npm test -- src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts src/lib/api-response.test.ts src/server/services/priority-displacement.integration.test.ts
```

Expected: all pass; unblocked dates are ignored by scheduling.

- [ ] **Step 8: Commit the repository contract**

```bash
git add src/types/clinic-calendar.ts src/lib/errors.ts src/lib/api-response.ts src/lib/api-response.test.ts src/server/repositories/clinic-unavailable-dates.repository.ts src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts src/server/services/priority-displacement.service.ts src/server/services/schedule-imports.service.ts
git commit -m "feat: add active clinic calendar repository contract"
```

---

### Task 3: Replace neighboring-month numbers with blank calendar cells and add pure draft logic

**Files:**
- Modify: `src/components/settings/clinic-calendar.ts`
- Modify: `src/components/settings/clinic-calendar.test.ts`
- Create: `src/components/settings/clinic-calendar-draft.ts`
- Create: `src/components/settings/clinic-calendar-draft.test.ts`

**Interfaces:**
- `buildMonthGrid(month)` returns `CalendarCell[]`, where blanks have `kind: "blank"` and dates have `kind: "date"`.
- Produces `calendarDraftKey(clinicId, date)`.
- Produces `toggleCalendarDraft(...)`.
- Produces `summarizeCalendarDraft(...)`.
- Produces `resolveCalendarDateState(...)`.

- [ ] **Step 1: Replace the old six-week assertions with failing blank-cell assertions**

Use these exact expectations:

```ts
const august = buildMonthGrid("2026-08");
expect(august).toHaveLength(42);
expect(august.slice(0, 6)).toEqual([
  { kind: "blank", key: "2026-08-leading-0" },
  { kind: "blank", key: "2026-08-leading-1" },
  { kind: "blank", key: "2026-08-leading-2" },
  { kind: "blank", key: "2026-08-leading-3" },
  { kind: "blank", key: "2026-08-leading-4" },
  { kind: "blank", key: "2026-08-leading-5" },
]);
expect(august.filter((cell) => cell.kind === "date").map((cell) => cell.dayOfMonth))
  .toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
expect(august.some((cell) => cell.kind === "date" && !cell.inCurrentMonth)).toBe(false);
```

Keep leap-year and weekend assertions against `kind === "date"` cells. Add January–December table cases and verify `shiftMonth("2026-01", -1)` can be identified as below the current-year lower bound.

- [ ] **Step 2: Add failing draft reducer tests**

```ts
let draft = new Map<string, CalendarDraftChange>();
draft = toggleCalendarDraft(draft, {
  persisted: undefined,
  clinicId: "clinic-a",
  date: "2027-07-15",
  blockTemplate: { category: "MAINTENANCE", reason: "Equipment service" },
});
expect(draft.get(calendarDraftKey("clinic-a", "2027-07-15"))).toMatchObject({
  action: "BLOCK",
  category: "MAINTENANCE",
  reason: "Equipment service",
});

draft = toggleCalendarDraft(draft, {
  persisted: undefined,
  clinicId: "clinic-a",
  date: "2027-07-15",
  blockTemplate: { category: "HOLIDAY", reason: "Changed later" },
});
expect(draft.size).toBe(0);
```

Add a persisted-block case that toggles `UNBLOCK` and then cancels it, a cross-clinic summary case, and a case proving that changing the form after selection does not mutate an existing staged block.

- [ ] **Step 3: Implement the calendar cell union**

Use:

```ts
export type CalendarBlankCell = {
  kind: "blank";
  key: string;
};

export type CalendarDateCell = {
  kind: "date";
  key: string;
  date: string;
  dayOfMonth: number;
  inCurrentMonth: true;
  isWeekend: boolean;
};

export type CalendarCell = CalendarBlankCell | CalendarDateCell;
```

`buildMonthGrid()` must return the smallest complete-week grid containing the month: leading blanks, all actual month dates, and trailing blanks until the total length is divisible by seven. The result is exactly 28, 35, or 42 cells; August 2026 is exactly 42. Never render a neighboring date number.

- [ ] **Step 4: Implement the pure draft model**

Use a discriminated union imported from `src/types/clinic-calendar.ts` and this displayed state:

```ts
export type CalendarDateState =
  | { state: "AVAILABLE" }
  | { state: "SAVED_BLOCKED"; record: ClinicUnavailableDateRecord }
  | { state: "STAGED_BLOCK"; change: ClinicCalendarBlockChange }
  | { state: "STAGED_UNBLOCK"; record: ClinicUnavailableDateRecord; change: ClinicCalendarUnblockChange }
  | { state: "CONFLICT"; messages: string[] };
```

`toggleCalendarDraft()` must copy the `Map`, never mutate its input, and key entries with:

```ts
export function calendarDraftKey(clinicId: string, date: string) {
  return `${clinicId}:${date}`;
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- src/components/settings/clinic-calendar.test.ts src/components/settings/clinic-calendar-draft.test.ts
```

Expected: only current-month numbers exist; draft toggles and summaries pass.

- [ ] **Step 6: Commit the pure calendar model**

```bash
git add src/components/settings/clinic-calendar.ts src/components/settings/clinic-calendar.test.ts src/components/settings/clinic-calendar-draft.ts src/components/settings/clinic-calendar-draft.test.ts
git commit -m "feat: add calendar draft and blank month cells"
```

---

### Task 4: Build a two-phase planner for block-only calendar batches

**Files:**
- Create: `src/server/services/clinic-calendar-planner.ts`
- Create: `src/server/services/clinic-calendar-planner.test.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Modify: `src/server/services/clinic-calendar.integration.test.ts`

**Interfaces:**
- Produces `ClinicCalendarPlanningContext`.
- Produces `buildFinalBlockedSets(activeRecords, changes)`.
- Produces `createPlanningContext(client, activeRecords, changes)`.
- Produces `planClinicBlock(client, change, context): Promise<ClinicBlockPlan>`.
- Produces `applyClinicBlockPlan(client, plan, actor, batchId): Promise<BlockImpact>`.
- Produces `saveClinicCalendarChanges(raw, actor): Promise<ClinicCalendarBatchResult>` for block-only batches before Task 5 adds unblocking.

- [ ] **Step 1: Write failing pure planner tests**

Cover final-state semantics:

```ts
const sets = buildFinalBlockedSets(activeRecords, [
  { action: "UNBLOCK", clinicId: cpuId, date: "2027-07-15", unavailableDateId: "block-1", expectedUpdatedAt },
  { action: "BLOCK", clinicId: cpuId, date: "2027-07-18", category: "CLOSURE", reason: "Maintenance" },
]);
expect(sets.get(cpuId)).not.toContain("2027-07-15");
expect(sets.get(cpuId)).toContain("2027-07-18");
```

Test deterministic ordering by `date`, then `clinicId`, and projected load reservation so two moves in one batch cannot claim the same final capacity slot beyond `max_daily_capacity`.

- [ ] **Step 2: Write failing block-only integration tests**

Add these exact scenarios to `clinic-calendar.integration.test.ts`:

1. A two-date batch created before any CSV import returns zero moved students and both dates are later skipped by `acceptAndScheduleImport()`.
2. A mixed-clinic block batch moves a KABALAKA pair and a separate CPU Physical Examination in one transaction.
3. Two blocks in one batch allocate replacements against the combined final blocked set.
4. One protected appointment rejects the full two-block batch and leaves blocks, appointments, status logs, events, notifications, and audits unchanged.

Call:

```ts
const result = await saveClinicCalendarChanges({
  changes: [
    { action: "BLOCK", clinicId: laboratoryClinicId, date: labDate, category: "CLOSURE", reason: "TEST-CALENDAR batch lab" },
    { action: "BLOCK", clinicId: physicalClinicId, date: otherPeDate, category: "MAINTENANCE", reason: "TEST-CALENDAR batch PE" },
  ],
}, admin);
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- src/server/services/clinic-calendar-planner.test.ts src/server/services/clinic-calendar.integration.test.ts
```

Expected: FAIL because batch planning and `saveClinicCalendarChanges()` do not exist.

- [ ] **Step 4: Define the planning context and plan types**

Use:

```ts
export type ClinicCalendarPlanningContext = {
  finalBlockedByClinicCode: Map<"KABALAKA_CLINIC" | "CPU_CLINIC", Set<string>>;
  projectedLoadByClinicCode: Map<"KABALAKA_CLINIC" | "CPU_CLINIC", Map<string, number>>;
  maxCapacityByClinicCode: Map<"KABALAKA_CLINIC" | "CPU_CLINIC", number>;
  retiringReplacementIds: Set<string>;
  restoringOriginalIds: Set<string>;
  searchEndDate: string;
};

export type ClinicBlockPlan = {
  change: ClinicCalendarBlockChange;
  clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
  affectedAppointmentIds: string[];
  replacements: Array<{
    oldAppointmentId: string;
    studentNumber: string;
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
    appointmentDate: string;
    schedulePairId: string;
    scheduleCycleStart: number;
  }>;
};
```

- [ ] **Step 5: Refactor existing single-block behavior into plan/apply functions**

Move the current lock, protected-result, capacity, paired-appointment, replacement-date, status-log, event, notification, and audit behavior behind `planClinicBlock()` and `applyClinicBlockPlan()`.

Planning must not insert, update, notify, or audit. It may lock rows and update only in-memory projected-load maps.

`firstAvailable()` must consult `context.finalBlockedByClinicCode`, not a block set assembled per individual change.

- [ ] **Step 6: Implement block-only batch validation and transaction**

Create a Zod discriminated union with:

```ts
const blockChangeSchema = z.object({
  action: z.literal("BLOCK"),
  clinicId: z.string().uuid(),
  date: z.iso.date(),
  category: z.enum(["HOLIDAY", "CLOSURE", "MAINTENANCE", "STAFF_UNAVAILABILITY"]),
  reason: z.string().trim().min(3).max(500),
});
```

Reject empty batches, more than `366` changes, duplicate `clinicId + date`, today/past dates, weekends, and existing active blocks.

Inside one `transaction()`:

1. acquire `pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))`;
2. load active blocks and create the final blocked sets;
3. create one planning context;
4. plan every block in deterministic order;
5. apply plans only after every plan succeeds;
6. write one `CLINIC_CALENDAR_BATCH_UPDATED` audit with `batchId`;
7. return refreshed active records and aggregate counts.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
npm test -- src/server/services/clinic-calendar-planner.test.ts src/server/services/clinic-calendar.integration.test.ts
```

Expected: all block-only batch scenarios pass and existing clinic-specific movement rules remain unchanged.

- [ ] **Step 8: Commit the block planner**

```bash
git add src/server/services/clinic-calendar-planner.ts src/server/services/clinic-calendar-planner.test.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.integration.test.ts
git commit -m "feat: plan atomic clinic calendar blocks"
```

---

### Task 5: Add all-or-nothing safe restoration for unblocking

**Files:**
- Create: `src/server/repositories/clinic-calendar-restoration.repository.ts`
- Modify: `src/server/services/clinic-calendar-planner.ts`
- Modify: `src/server/services/clinic-calendar-planner.test.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Modify: `src/server/services/clinic-calendar.integration.test.ts`

**Interfaces:**
- Produces `lockRestorationBundles(client, blockIds): Promise<ClinicRestorationBundle[]>`.
- Produces `planClinicRestoration(bundle, context): ClinicRestorationPlan`.
- Produces `applyClinicRestorationPlan(client, plan, actor, batchId): Promise<RestorationImpact>`.

- [ ] **Step 1: Write failing immediate-restoration integration tests**

Add:

```ts
const block = await saveClinicCalendarChanges({ changes: [blockChange] }, admin);
const record = block.activeUnavailableDates.find((item) => item.startDate === blockedDate)!;

const restored = await saveClinicCalendarChanges({
  changes: [{
    action: "UNBLOCK",
    clinicId: record.clinicId,
    date: record.startDate,
    unavailableDateId: record.id,
    expectedUpdatedAt: record.updatedAt,
  }],
}, admin);

expect(restored).toMatchObject({
  unblockedDateCount: 1,
  restoredStudentCount: 1,
});
```

Verify:

- CPU restoration reactivates only the original Physical Examination and marks its generated replacement `RESCHEDULED`.
- KABALAKA restoration reactivates both originals and retires both replacements together.
- Original status logs contain `RESCHEDULED -> PENDING`.
- Replacement status logs contain `PENDING -> RESCHEDULED`.
- The reschedule event has `restored_at`, `restored_by`, and matching `batch_id`.
- The unavailable-date row has `unblocked_at`, `unblocked_by`, and is absent from active list results.
- A `SCHEDULE_RESCHEDULED` notification contains `restored: true` and restored dates.
- A block created before imports with no reschedule events soft-unblocks successfully with `restoredStudentCount: 0` and no student notification.

- [ ] **Step 2: Write failing protected-restoration and stale-version tests**

Cover each unsafe condition with a table-driven test:

```ts
it.each([
  ["completed", "COMPLETED"],
  ["no-show", "NO_SHOW"],
  ["cancelled", "CANCELLED"],
])("rejects a %s replacement", async (_label, status) => {
  await pool.query("UPDATE appointments SET status=$2 WHERE id=$1", [replacementId, status]);
  await expect(saveClinicCalendarChanges(unblockRequest, admin)).rejects.toMatchObject({
    code: "CLINIC_CALENDAR_BATCH_REJECTED",
    details: { issues: [expect.objectContaining({ code: "PROTECTED_REPLACEMENT" })] },
  });
});
```

Add separate cases for manual lock, finalized submission, protected laboratory/exam result, a replacement with a published child, missing original appointment, capacity conflict, and stale `expectedUpdatedAt`.

After each failure, compare a full before/after snapshot and require equality.

- [ ] **Step 3: Run focused integration tests and verify RED**

```bash
npm test -- src/server/services/clinic-calendar.integration.test.ts
```

Expected: FAIL because unblocking and restoration do not exist.

- [ ] **Step 4: Implement the locked restoration repository**

`lockRestorationBundles()` must lock:

- active unavailable-date rows;
- unrestored `appointment_reschedule_events`;
- old Laboratory and Physical Examination appointments;
- new Laboratory and Physical Examination appointments;
- any published child whose `rescheduled_from` references a replacement.

Return:

```ts
export type ClinicRestorationBundle = {
  block: LockedClinicUnavailableDate;
  clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
  events: Array<{
    id: string;
    studentNumber: string;
    restoredAt: Date | null;
    oldLaboratory: LockedAppointment | null;
    newLaboratory: LockedAppointment | null;
    oldPhysicalExam: LockedAppointment | null;
    newPhysicalExam: LockedAppointment | null;
  }>;
};
```

Each `LockedAppointment` must include status, publication, manual-lock fields, result-protection, schedule pair/cycle, date, and `hasPublishedReplacement`.

- [ ] **Step 5: Implement restoration planning before any mutation**

`planClinicRestoration()` must:

1. verify block identity, clinic, date, active state, and `expectedUpdatedAt`;
2. reject already-restored events;
3. require replacement status `PENDING`, `is_published=TRUE`, no lock, no protected result, and no published child;
4. require original status `RESCHEDULED`;
5. require exact event IDs and pair membership;
6. reject an original date that remains in the final blocked set;
7. verify active-appointment uniqueness and projected capacity;
8. add original load and remove replacement load in the planning context;
9. add replacement IDs to `retiringReplacementIds` and originals to `restoringOriginalIds`.

For KABALAKA, any missing or unsafe pair member creates one `PAIR_INTEGRITY_FAILURE`; never return a partial plan.

- [ ] **Step 6: Apply restoration plans atomically**

For each original:

```sql
UPDATE appointments
   SET status='PENDING',
       updated_by=$2,
       updated_at=NOW()
 WHERE id=$1 AND status='RESCHEDULED'
```

For each generated replacement:

```sql
UPDATE appointments
   SET status='RESCHEDULED',
       updated_by=$2,
       updated_at=NOW()
 WHERE id=$1 AND status='PENDING'
```

Insert status logs with notes containing the batch ID and `Clinic unavailable date reversed.`

Mark each event restored:

```sql
UPDATE appointment_reschedule_events
   SET restored_at=NOW(), restored_by=$2, batch_id=$3
 WHERE id=$1 AND restored_at IS NULL
```

Soft-unblock the calendar record only after every appointment and event update returns the expected row count.

- [ ] **Step 7: Add restoration notifications and audits**

Create one student notification per restored student. Metadata must include:

```ts
{
  batchId,
  restored: true,
  clinicUnavailableDateId,
  replacementDates,
  restoredDates,
}
```

Write `CLINIC_UNAVAILABLE_DATE_UNBLOCKED` and `CLINIC_BLOCK_APPOINTMENTS_RESTORED` audit records with the same `batchId`.

- [ ] **Step 8: Run focused tests and verify GREEN**

```bash
npm test -- src/server/services/clinic-calendar-planner.test.ts src/server/services/clinic-calendar.integration.test.ts
```

Expected: immediate reversals succeed; every protected case rejects without partial changes.

- [ ] **Step 9: Commit safe restoration**

```bash
git add src/server/repositories/clinic-calendar-restoration.repository.ts src/server/services/clinic-calendar-planner.ts src/server/services/clinic-calendar-planner.test.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.integration.test.ts
git commit -m "feat: restore appointments when clinic dates reopen"
```

---

### Task 6: Expose the mixed batch API and preserve atomic concurrency behavior

**Files:**
- Modify: `src/app/api/clinic-unavailable-dates/route.ts`
- Modify: `src/app/api/clinic-unavailable-dates/route.test.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Modify: `src/server/services/clinic-calendar.integration.test.ts`

**Interfaces:**
- `GET()` continues returning active unavailable-date records.
- `POST(request)` accepts `ClinicCalendarBatchRequest`.
- `POST` returns status `200` with `ClinicCalendarBatchResult`.
- Rejected batches return `CLINIC_CALENDAR_BATCH_REJECTED` with `error.details.issues`.

- [ ] **Step 1: Replace legacy route tests with failing batch-contract tests**

Use:

```ts
const body = {
  changes: [
    {
      action: "BLOCK",
      clinicId: laboratoryClinicId,
      date: "2027-07-15",
      category: "CLOSURE",
      reason: "Planned maintenance",
    },
    {
      action: "UNBLOCK",
      clinicId: physicalClinicId,
      date: "2027-08-04",
      unavailableDateId: blockId,
      expectedUpdatedAt: "2027-07-01T00:00:00.000Z",
    },
  ],
};

expect(saveClinicCalendarChanges).toHaveBeenCalledWith(body, admin);
expect(response.status).toBe(200);
```

Also test unauthenticated/admin-only behavior, malformed JSON, empty changes, duplicate clinic/date changes, weekend/past dates, and structured issue passthrough.

- [ ] **Step 2: Add failing mixed-operation integration cases**

Add:

1. Unblock one date and block another across different clinics in one successful batch.
2. Unblock a replacement date while blocking a date that would receive its restored original; reject with `PAIR_INTEGRITY_FAILURE`.
3. A stale unblock rejects valid block additions in the same batch.
4. Hold the advisory lock in one connection and verify no calendar row changes before release.
5. Run two unblocks with the same `expectedUpdatedAt`; exactly one succeeds and the other receives `STALE_BLOCK`.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- src/app/api/clinic-unavailable-dates/route.test.ts src/server/services/clinic-calendar.integration.test.ts
```

Expected: FAIL until the route and mixed planner are complete.

- [ ] **Step 4: Implement the final request schema and duplicate detection**

Use `z.discriminatedUnion("action", [blockChangeSchema, unblockChangeSchema])` and:

```ts
const batchSchema = z.object({
  changes: z.array(changeSchema).min(1).max(366),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.changes.forEach((change, index) => {
    const key = `${change.clinicId}:${change.date}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["changes", index],
        message: "Only one change is allowed for each clinic date.",
      });
    }
    seen.add(key);
  });
});
```

The server remains authoritative for Manila today, weekend, active-block, clinic, and optimistic-lock checks.

Catch PostgreSQL `23505` from `clinic_unavailable_dates_one_active_day_idx` and convert it to one `ACTIVE_BLOCK_CONFLICT` issue; never leak the raw constraint error.

- [ ] **Step 5: Finalize mixed planning order**

Within the transaction:

1. load and lock unblock records;
2. compute the final blocked sets from active state plus every change;
3. lock restoration bundles;
4. plan all restorations and update projected load;
5. lock current appointments on all new block dates;
6. exclude replacement IDs scheduled for retirement;
7. reject any restored original whose date is newly blocked;
8. plan new blocks against final blocked sets and updated projected load;
9. apply all restoration plans;
10. apply all block plans;
11. soft-unblock records;
12. insert batch audit and return refreshed active records.

No mutation may occur before all plans exist.

- [ ] **Step 6: Replace the route POST handler**

```ts
export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(
      await saveClinicCalendarChanges(await request.json(), actor),
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

Remove the route’s dependency on `createClinicUnavailableDate`.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
npm test -- src/app/api/clinic-unavailable-dates/route.test.ts src/server/services/clinic-calendar.integration.test.ts
```

Expected: batch contract, full rollback, stale concurrency, and advisory-lock tests pass.

- [ ] **Step 8: Commit the API**

```bash
git add src/app/api/clinic-unavailable-dates/route.ts src/app/api/clinic-unavailable-dates/route.test.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.integration.test.ts
git commit -m "feat: expose atomic clinic calendar batch API"
```

---

### Task 7: Build focused accessible calendar presentation components

**Files:**
- Create: `src/components/settings/clinic-calendar/ClinicCalendarToolbar.tsx`
- Create: `src/components/settings/clinic-calendar/BlockConfigurationForm.tsx`
- Create: `src/components/settings/clinic-calendar/ClinicCalendarDay.tsx`
- Create: `src/components/settings/clinic-calendar/ClinicMonthGrid.tsx`
- Create: `src/components/settings/clinic-calendar/CalendarDraftSummary.tsx`
- Create: `src/components/settings/clinic-calendar/CalendarSaveConfirmationDialog.tsx`
- Create: `src/components/settings/clinic-calendar/presentational.test.tsx`

**Interfaces:**
- Components are controlled; none perform fetches or own persisted draft state.
- `ClinicMonthGrid` consumes `CalendarCell[]` and a date-state resolver.
- Confirmation dialog calls `onConfirm()` once and `onCancel()` without modifying drafts.

- [ ] **Step 1: Write failing presentation tests**

Assert:

```ts
expect(screen.queryByText("31", { selector: '[data-outside-month="true"]' })).not.toBeInTheDocument();
expect(screen.getAllByTestId("calendar-blank-cell")).toHaveLength(leadingAndTrailingBlankCount);
```

Render all four editable states and assert labels:

```ts
expect(screen.getByRole("button", { name: "July 15, 2027 — available" })).toBeEnabled();
expect(screen.getByRole("button", { name: "July 16, 2027 — blocked: Closure, Maintenance" })).toBeEnabled();
expect(screen.getByRole("button", { name: "July 17, 2027 — will be blocked: Holiday" })).toBeEnabled();
expect(screen.getByRole("button", { name: "July 18, 2027 — will be reopened" })).toBeEnabled();
```

Assert weekends are disabled, visible state text exists in addition to color, Enter/Space activate the callback, toolbar options span current year through 2100, and the dialog groups changes by clinic.

- [ ] **Step 2: Run the presentation test and verify RED**

```bash
npm test -- src/components/settings/clinic-calendar/presentational.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement controlled toolbar and block form**

`ClinicCalendarToolbar` props:

```ts
type ClinicCalendarToolbarProps = {
  clinics: Array<{ id: string; name: string }>;
  selectedClinicId: string;
  month: string;
  currentYear: number;
  maxYear: number;
  disabled: boolean;
  onClinicChange(clinicId: string): void;
  onMonthChange(month: string): void;
};
```

Use a year `<Select>` with values `currentYear..2100`. Previous is disabled when `month === `${currentYear}-01``. Next crosses December to January.

`BlockConfigurationForm` emits `{ category, reason, valid }`; it does not rewrite existing drafts.

- [ ] **Step 4: Implement blank cells and unambiguous date states**

`ClinicMonthGrid` renders blank cells as non-interactive `<div aria-hidden="true" data-testid="calendar-blank-cell" />`.

`ClinicCalendarDay` receives:

```ts
type ClinicCalendarDayProps = {
  cell: CalendarDateCell;
  state: CalendarDateState;
  disabled: boolean;
  onToggle(date: string): void;
};
```

Use a real `<button type="button">` for editable dates. Include state text such as `Blocked`, `Will be blocked`, or `Will be reopened`; do not use color alone.

- [ ] **Step 5: Implement summary and one confirmation dialog**

`CalendarDraftSummary` groups counts by clinic and action.

`CalendarSaveConfirmationDialog` renders only when `open`. It must:

- use `role="dialog"` and `aria-modal="true"`;
- focus the heading or Cancel button on open;
- trap Tab/Shift+Tab within the dialog;
- close on Escape as Cancel;
- return focus to the Save button;
- expose only `Cancel` and `Confirm and save`.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- src/components/settings/clinic-calendar/presentational.test.tsx
```

Expected: presentation, keyboard, blank-cell, and dialog tests pass.

- [ ] **Step 7: Commit presentational components**

```bash
git add src/components/settings/clinic-calendar
git commit -m "feat: add accessible clinic calendar editor components"
```

---

### Task 8: Refactor the page editor to stage changes, save once, and protect unsaved work

**Files:**
- Create: `src/components/settings/clinic-calendar/UnsavedCalendarChangesDialog.tsx`
- Create: `src/components/settings/clinic-calendar/useUnsavedCalendarNavigation.ts`
- Modify: `src/components/settings/ClinicUnavailableCalendar.tsx`
- Modify: `src/components/settings/ClinicUnavailableCalendar.test.tsx`

**Interfaces:**
- `ClinicUnavailableCalendar` remains the page-level client component.
- It owns `Map<string, ClinicCalendarBatchChange>` draft state.
- It makes no network request until `Confirm and save`.
- Successful save replaces persisted records with `activeUnavailableDates`.
- Failed save preserves drafts and maps `ClinicCalendarBatchIssue[]` to conflict cells.

- [ ] **Step 1: Replace immediate-write tests with failing draft-session tests**

Add exact workflows:

1. Fill category/reason, click an available date, assert `fetch` was not called and the cell says `will be blocked`.
2. Click it again and assert the draft count returns to zero.
3. Click a saved blocked weekday, assert `UNBLOCK`, then click again to cancel.
4. Stage July KABALAKA, switch to August CPU, stage another date, switch back, and assert both remain.
5. Stage one block with Maintenance, change the form to Holiday, stage another block, and verify each retained its selection-time category/reason.
6. Discard changes clears all clinics/months.
7. Save opens exactly one dialog; Cancel preserves drafts.
8. Confirm sends one POST with all changes and disables the editor while pending.
9. Success clears drafts, preserves current clinic/month, and reports all six counts.
10. A 409 with issues preserves drafts and labels the matching date as conflict.

Expected fetch body:

```ts
expect(fetchMock).toHaveBeenCalledWith("/api/clinic-unavailable-dates", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ changes: expectedChanges }),
});
```

Sort `expectedChanges` by date then clinic ID before sending so tests and audit ordering are deterministic.

- [ ] **Step 2: Add failing unsaved-navigation tests**

Test:

- `beforeunload` calls `preventDefault()` only when drafts exist;
- clicking a same-origin sidebar link opens the discard dialog instead of navigating;
- `Continue editing` closes the dialog;
- `Discard and leave` calls `window.location.assign(href)`;
- month, year, and clinic control changes do not open the navigation dialog.

- [ ] **Step 3: Run the component test and verify RED**

```bash
npm test -- src/components/settings/ClinicUnavailableCalendar.test.tsx
```

Expected: FAIL because the current component still writes immediately.

- [ ] **Step 4: Refactor the editor state**

Use:

```ts
const [records, setRecords] = useState(unavailableDates);
const [draft, setDraft] = useState<Map<string, ClinicCalendarBatchChange>>(new Map());
const [conflicts, setConflicts] = useState<Map<string, string[]>>(new Map());
const [confirmationOpen, setConfirmationOpen] = useState(false);
const [saving, setSaving] = useState(false);
```

Derive the visible date state from `records + draft + conflicts`. Do not duplicate that state in separate booleans.

When staging a block, require a valid current category/reason and copy them into the draft entry.

- [ ] **Step 5: Implement one batch save**

On Confirm:

1. set `saving=true`;
2. POST sorted changes once;
3. on success, set `records=payload.data.activeUnavailableDates`, clear draft/conflicts, close dialog, show aggregate success;
4. on structured failure, keep draft, convert issues to `calendarDraftKey(clinicId, date) -> messages`, close or switch the dialog to an error summary;
5. always set `saving=false`.

The editor must not optimistically mutate persisted records before success.

- [ ] **Step 6: Implement unsaved-navigation protection**

`useUnsavedCalendarNavigation(hasChanges)` must install:

```ts
window.addEventListener("beforeunload", handleBeforeUnload);
document.addEventListener("click", handleDocumentClick, true);
```

Intercept only unmodified primary-button clicks on same-origin anchors whose target is `_self` or absent. Ignore downloads, hash-only links, external origins, and calendar controls.

Return `{ pendingHref, continueEditing, discardAndLeave }` for `UnsavedCalendarChangesDialog`.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
npm test -- src/components/settings/ClinicUnavailableCalendar.test.tsx src/components/settings/clinic-calendar/presentational.test.tsx
```

Expected: no fetch occurs before confirmation; drafts persist across navigation controls; save/error/navigation flows pass.

- [ ] **Step 8: Commit the editor refactor**

```bash
git add src/components/settings/ClinicUnavailableCalendar.tsx src/components/settings/ClinicUnavailableCalendar.test.tsx src/components/settings/clinic-calendar/UnsavedCalendarChangesDialog.tsx src/components/settings/clinic-calendar/useUnsavedCalendarNavigation.ts
git commit -m "feat: stage and batch-save clinic calendar changes"
```

---

### Task 9: Integrate the page, browser fixture, and end-to-end scheduling workflow

**Files:**
- Modify: `src/app/(dashboard)/settings/clinic-unavailable-dates/page.tsx`
- Modify: `src/app/(dashboard)/settings/clinic-unavailable-dates/page.test.tsx`
- Modify: `src/test/automated-scheduling-student-portal.e2e.integration.test.ts`
- Modify: `scripts/browser-clinic-scheduler-ux-fixture.ts`

**Interfaces:**
- Page passes active records with `updatedAt`, current Manila date, and `maxYear={2100}`.
- Browser fixture covers multi-month, multi-clinic staging and one-save confirmation.
- Acceptance script remains `npm run acceptance:clinic-ux`.

- [ ] **Step 1: Update the page test first**

Assert:

```ts
expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
expect(screen.getByLabelText("Year")).toHaveValue("2026");
expect(screen.getByRole("option", { name: "2100" })).toBeInTheDocument();
expect(screen.queryByRole("button", { name: /September 1, 2026/ })).not.toBeInTheDocument();
expect(screen.getByRole("button", {
  name: "August 19, 2026 — blocked: Maintenance, Generator testing",
})).toBeEnabled();
```

Update fixture records with `updatedAt`.

- [ ] **Step 2: Add end-to-end integration assertions**

Extend the automated scheduling test to:

1. save a block before import;
2. import and publish students;
3. prove no appointment lands on the active blocked date;
4. block a populated date and capture replacements;
5. unblock with the returned ID/version;
6. prove originals are pending again, replacements are historical, notifications exist, and active blocked-date list no longer includes the date.

- [ ] **Step 3: Run page and end-to-end tests and verify RED**

```bash
npm test -- src/app/\(dashboard\)/settings/clinic-unavailable-dates/page.test.tsx src/test/automated-scheduling-student-portal.e2e.integration.test.ts
```

Expected: FAIL until page fixtures and end-to-end batch flow are updated.

- [ ] **Step 4: Update page copy and props**

Use copy that matches the new workflow:

```tsx
<PageHeader
  title="Clinic unavailable dates"
  description="Configure clinic availability before imports, review all changes, and save once."
/>
```

Pass `maxYear={2100}` if the editor does not hard-code the schema maximum.

- [ ] **Step 5: Extend the browser acceptance fixture**

Automate:

1. stage a KABALAKA date in one month;
2. switch to CPU Clinic and another month;
3. stage a second date;
4. return to the first clinic/month and verify its staged state;
5. open Save changes;
6. verify both clinics appear in one dialog;
7. confirm once;
8. reload and verify both persisted states;
9. stage an eligible unblock and save;
10. create or select a protected replacement and verify the entire attempted save is rejected without losing the draft.

Add assertions that no neighboring-month date numbers are rendered.

- [ ] **Step 6: Run focused tests and acceptance**

```bash
npm test -- src/app/\(dashboard\)/settings/clinic-unavailable-dates/page.test.tsx src/test/automated-scheduling-student-portal.e2e.integration.test.ts
npm run acceptance:clinic-ux
```

Expected: page, scheduling lifecycle, and browser workflow pass.

- [ ] **Step 7: Commit page and acceptance integration**

```bash
git add src/app/\(dashboard\)/settings/clinic-unavailable-dates/page.tsx src/app/\(dashboard\)/settings/clinic-unavailable-dates/page.test.tsx src/test/automated-scheduling-student-portal.e2e.integration.test.ts scripts/browser-clinic-scheduler-ux-fixture.ts
git commit -m "test: verify clinic calendar batch workflow"
```

---

### Task 10: Run complete verification and review the final diff

**Files:**
- Review all files changed by Tasks 1–9.
- Modify only files required to fix verification failures.

**Interfaces:**
- No new interface; this task proves the implementation satisfies the approved specification.

- [ ] **Step 1: Apply migrations from a clean compatible database state**

```bash
npm run db:migrate
```

Expected: migrations through `012_clinic_calendar_batch_editor.sql` apply successfully and a second run reports no pending migration.

- [ ] **Step 2: Run all clinic-calendar-focused tests**

```bash
npm test -- \
  src/server/repositories/clinic-unavailable-dates.repository.integration.test.ts \
  src/server/services/clinic-calendar-planner.test.ts \
  src/server/services/clinic-calendar.integration.test.ts \
  src/app/api/clinic-unavailable-dates/route.test.ts \
  src/components/settings/clinic-calendar.test.ts \
  src/components/settings/clinic-calendar-draft.test.ts \
  src/components/settings/clinic-calendar/presentational.test.tsx \
  src/components/settings/ClinicUnavailableCalendar.test.tsx \
  src/app/\(dashboard\)/settings/clinic-unavailable-dates/page.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run the complete automated suite**

```bash
npm test
```

Expected: PASS with no unexpected skipped or hanging integration tests.

- [ ] **Step 4: Run static and production checks**

```bash
npm run lint
npm run build
```

Expected: both commands exit `0`; no TypeScript, ESLint, server-only import, or App Router boundary errors.

- [ ] **Step 5: Run browser acceptance**

```bash
npm run acceptance:clinic-ux
```

Expected: the fixture confirms current-month-only numbers, cross-month/cross-clinic draft persistence, one confirmation, successful atomic save, safe restoration, and protected-restoration rollback.

- [ ] **Step 6: Inspect the final diff for scope and migration safety**

```bash
git status --short
git diff --check
git diff --stat main...HEAD
git log --oneline --decorate main..HEAD
```

Confirm:

- no immediate per-date POST remains;
- every operational unavailable-date query filters `unblocked_at IS NULL`;
- no normal unblock path deletes rows;
- every mutation is under the shared advisory lock and transaction;
- block and restoration planners finish before mutations begin;
- no neighboring-month number is rendered;
- drafts survive month/year/clinic switches and failed saves;
- only one confirmation is presented.

- [ ] **Step 7: Commit any verification-only fixes**

```bash
git add -A
git commit -m "fix: complete clinic calendar batch verification"
```

Skip this commit when the working tree is already clean.

- [ ] **Step 8: Prepare the branch for review**

```bash
git status --short
git log --oneline --decorate main..HEAD
```

Expected: clean working tree and a reviewable sequence of focused commits.
