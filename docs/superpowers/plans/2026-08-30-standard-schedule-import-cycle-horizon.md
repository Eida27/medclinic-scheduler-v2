# Standard Schedule Import Cycle Horizon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Standard schedule import use the configured `academic_years.closing_date` as its inclusive absolute scheduling horizon so neither Laboratory nor Physical Examination appointments can be published after the selected academic cycle closes.

**Architecture:** Keep the existing paired scheduling algorithm unchanged. During the existing Standard-import transaction, acquire a stable read lock on the selected academic-year row, read its configured `closing_date`, and pass that date into the existing scheduling queries and `generatePairedSchedule(...)` as `searchEndDate`. Keep `preferredWindowEnd` separate because March 31 for Regular imports and the selected preferred-month end for OJT/Tour imports remain soft priority/overflow windows, not the absolute cycle boundary.

**Tech Stack:** Next.js 16.2.6, TypeScript, PostgreSQL via `pg`, Vitest 4.1.8.

**Spec:** `docs/superpowers/specs/2026-08-26-scheduling-integrity-hardening-design.md` — this plan applies the already-approved same-cycle upper-bound invariant to initial Standard schedule-import allocation.

## Global Constraints

- Scope is **Standard schedule imports only**: `REGULAR`, `OJT`, and `TOUR` through `createScheduleImport(...)`.
- Do not change First Year/OVPSA scheduling in this task.
- Do not change `generatePairedSchedule(...)`; it already obeys the `searchEndDate` supplied by its caller.
- `academic_years.closing_date` is the authoritative and **inclusive** upper bound for both appointments in a pair.
- A Laboratory appointment is invalid if its required Physical Examination cannot also fit on or before `closing_date`.
- Regular scheduling may still overflow beyond March 31 when capacity requires it, but it may never cross the configured cycle closing date.
- OJT/Tour preferred-month behavior and displacement priority remain unchanged; the preferred-month end is not the absolute horizon.
- Preserve the existing `SCHEDULE_CAPACITY_EXHAUSTED` HTTP 409 behavior when the complete import cannot fit by the closing date.
- Preserve the existing `ACADEMIC_YEAR_NOT_CONFIGURED` HTTP 409 contract and message: `Configure the academic year before importing schedules.`
- Preserve atomic imports: a horizon failure must leave no student, snapshot, import-group, batch, schedule-item, appointment, audit-success, or notification publication from the rejected import.
- Read and lock the academic-year boundary in the same PostgreSQL transaction that publishes the import so a concurrent closing-date edit cannot invalidate the allocation while it is being committed.
- Do not change the meaning or stored value of `scheduling_window_end`; it remains the preferred scheduling window used by overflow/displacement logic.
- No database migration, UI change, API payload change, or new dependency is required.

---

## File Structure

- Modify: `src/server/repositories/academic-years.repository.ts`
  - Add one focused repository function that returns the selected cycle boundary under a PostgreSQL row lock suitable for scheduling publication.
- Modify: `src/server/repositories/schedule-imports.repository.ts`
  - Replace the five-year synthetic horizon with the locked configured closing date.
- Modify/Test: `src/server/services/schedule-imports.integration.test.ts`
  - Add regression coverage proving the closing date is inclusive and proving a complete pair cannot spill one day past it.
- Verify unchanged behavior: `src/server/rule-engine/generate-paired-schedule.test.ts`
  - Existing tests already prove the generator respects a caller-supplied horizon and allows Regular overflow beyond March.

No production file should be created for this fix.

---

### Task 1: Add regression coverage for the Standard-import cycle boundary

**Files:**
- Modify/Test: `src/server/services/schedule-imports.integration.test.ts`

**Interfaces:**
- Consumes: existing `acceptAndScheduleImport(...)`, `pool`, `cleanupTestFixtures(...)`, and the Standard import helpers already defined in this test file.
- Produces: regression tests that fail on the current five-year-horizon implementation and pass only when the configured `closing_date` bounds the complete Lab/PE pair.

Use a dedicated test-only academic year, `2098`, instead of mutating the suite's shared 2026/2027 academic-year rows. This prevents the regression tests from altering developer-configured dates used by other tests.

- [ ] **Step 1: Extend cleanup so the dedicated horizon fixture is always removed**

After the existing fixture/closure cleanup in `cleanup()`, delete the test-only academic year after its students/snapshots have already been removed:

```ts
async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-AY%')`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-AY%'");
  await pool.query("DELETE FROM academic_years WHERE start_year=2098");
}
```

Do not delete or rewrite the shared 2026/2027 academic-year fixtures.

- [ ] **Step 2: Add focused helpers for the test-only academic year and blocked start date**

Add these helpers near the existing `input(...)` / `cleanup(...)` helpers:

```ts
async function insertHorizonTestAcademicYear(closingDate: string) {
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2098,$1,$2,$2)`,
    [closingDate, TEST_REFERENCE_IDS.adminUser],
  );
}

async function blockHorizonTestStartDate() {
  await pool.query(
    `WITH closure AS (
       INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES (
         '2098-08-01','2098-08-01','CLOSURE',
         'TEST-AY Standard horizon boundary',$1,gen_random_uuid()
       )
       RETURNING id
     )
     INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
     SELECT id,'2098-08-01' FROM closure`,
    [TEST_REFERENCE_IDS.adminUser],
  );
}
```

August 1, 2098 is a Friday. Once that date is blocked, the next valid Laboratory service date is Monday, August 4, and the next valid Physical Examination service date is Tuesday, August 5. That deterministic pair makes the boundary tests explicit.

- [ ] **Step 3: Add an inclusive-boundary success regression**

Add this test inside `describe("student scheduling imports", ...)`:

```ts
it("allows a Standard pair whose Physical Examination lands exactly on the cycle closing date", async () => {
  const studentNumber = "99-9192-92";
  await insertHorizonTestAcademicYear("2098-08-05");
  await blockHorizonTestStartDate();

  const created = await acceptAndScheduleImport(input(csv(
    `${studentNumber},Boundary,Inclusive,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
  ), { academicYearStart: 2098 }), admin);

  expect(created).toMatchObject({
    outcome: "PUBLISHED",
    generatedRange: { startDate: "2098-08-04", endDate: "2098-08-05" },
  });

  const appointments = await pool.query<{
    schedule_type: string;
    appointment_date: string;
  }>(
    `SELECT schedule_type,appointment_date::text
       FROM appointments
      WHERE student_number=$1 AND status='PENDING'
      ORDER BY appointment_date,schedule_type`,
    [studentNumber],
  );

  expect(appointments.rows).toEqual([
    { schedule_type: "LABORATORY", appointment_date: "2098-08-04" },
    { schedule_type: "PHYSICAL_EXAM", appointment_date: "2098-08-05" },
  ]);
});
```

This establishes that `closing_date` is inclusive rather than an exclusive cutoff.

- [ ] **Step 4: Add the failing regression that exposes the five-year bug**

Add this test:

```ts
it("rejects a Standard import when the complete pair cannot fit by the cycle closing date", async () => {
  const studentNumber = "99-9193-93";
  await insertHorizonTestAcademicYear("2098-08-04");
  await blockHorizonTestStartDate();

  await expect(acceptAndScheduleImport(input(csv(
    `${studentNumber},Boundary,Exhausted,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
  ), { academicYearStart: 2098 }), admin)).rejects.toMatchObject({
    code: "SCHEDULE_CAPACITY_EXHAUSTED",
    status: 409,
  });

  const writes = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number=$1) AS snapshots,
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE academic_year_start=2098) AS imports,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS appointments`,
    [studentNumber],
  );

  expect(writes.rows[0]).toEqual({
    students: 0,
    snapshots: 0,
    imports: 0,
    appointments: 0,
  });
});
```

Why this test is red before the fix: with the current `${input.academicYearStart + 5}-07-31` horizon, the scheduler can assign Laboratory on `2098-08-04` and Physical Examination on `2098-08-05`, even though the configured academic year closes on `2098-08-04`. The corrected implementation must reject the import atomically instead.

- [ ] **Step 5: Run only the Standard schedule-import integration suite and confirm the regression is red**

Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/services/schedule-imports.integration.test.ts
```

Expected before production changes:

- the inclusive-boundary test may pass;
- `rejects a Standard import when the complete pair cannot fit by the cycle closing date` must fail because the current code publishes the pair past `closing_date` instead of rejecting it.

Do not weaken the failing expectation to accommodate current behavior.

---

### Task 2: Lock and use the configured academic-year closing date

**Files:**
- Modify: `src/server/repositories/academic-years.repository.ts`
- Modify: `src/server/repositories/schedule-imports.repository.ts`
- Test: `src/server/services/schedule-imports.integration.test.ts`

**Interfaces:**
- Produces in `academic-years.repository.ts`:

```ts
export type AcademicYearSchedulingBoundary = {
  startYear: number;
  closingDate: string;
};

export async function lockAcademicYearSchedulingBoundary(
  client: PoolClient,
  startYear: number,
): Promise<AcademicYearSchedulingBoundary | undefined>;
```

- Consumes in `schedule-imports.repository.ts`: the function above, inside the existing `createScheduleImport(...)` transaction.
- Existing downstream interface remains unchanged: `generatePairedSchedule(...)` still receives `searchEndDate: string`.

- [ ] **Step 1: Add a focused academic-year scheduling-boundary repository function**

In `src/server/repositories/academic-years.repository.ts`, add:

```ts
export type AcademicYearSchedulingBoundary = {
  startYear: number;
  closingDate: string;
};

export async function lockAcademicYearSchedulingBoundary(
  client: PoolClient,
  startYear: number,
): Promise<AcademicYearSchedulingBoundary | undefined> {
  const result = await client.query<AcademicYearSchedulingBoundary>(
    `SELECT start_year AS "startYear", closing_date::text AS "closingDate"
       FROM academic_years
      WHERE start_year=$1
      FOR SHARE`,
    [startYear],
  );
  return result.rows[0];
}
```

`FOR SHARE` is intentional. The import needs a stable closing date through publication; an administrator changing or deleting that academic-year row must wait until the scheduling transaction commits or rolls back. Do not replace this with an unlocked `getAcademicYearRecord(...)` read.

Do not reuse `lockAcademicYearWithSnapshotCount(...)`: that helper obtains a stronger `FOR UPDATE` lock and performs an unrelated snapshot-count query.

- [ ] **Step 2: Import and lock the academic-year boundary before any Standard-import writes**

In `src/server/repositories/schedule-imports.repository.ts`, import `lockAcademicYearSchedulingBoundary` from `@/server/repositories/academic-years.repository`.

Inside the existing `transaction(async (client) => { ... })`, immediately after:

```ts
await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
```

load the boundary:

```ts
const academicYear = await lockAcademicYearSchedulingBoundary(
  client,
  input.academicYearStart,
);
if (!academicYear) {
  throw new AppError(
    "ACADEMIC_YEAR_NOT_CONFIGURED",
    "Configure the academic year before importing schedules.",
    409,
    undefined,
    { academicYearStart: [input.academicYearStart] },
  );
}
```

Keep the later academic-year guard in `ensureStudentAcademicSnapshotsWithClient(...)`; it remains a defensive invariant for snapshot creation and does not need to be refactored in this task.

- [ ] **Step 3: Replace the synthetic five-year horizon**

Find the current code:

```ts
const searchEndDate = `${input.academicYearStart + 5}-07-31`;
```

Replace it with:

```ts
const searchEndDate = academicYear.closingDate;
```

Do not introduce another calculated fallback such as July 31 of the next year. The configured database value is authoritative even when an administrator deliberately chooses an earlier closing date.

Because the existing orchestration already uses `searchEndDate` for the appointment-load query, blocked-date query, and `generatePairedSchedule(...)`, this single authoritative value must bound all three operations.

- [ ] **Step 4: Keep preferred-window semantics unchanged**

Do **not** modify this concept:

```ts
const preferredWindowEnd = input.studentCategory === "REGULAR"
  ? `${input.academicYearStart + 1}-03-31`
  : /* selected preferred-month end */;
```

Do not replace `scheduling_window_end` with `academicYear.closingDate` when appointments are inserted.

The intended distinction is:

```text
windowStart ---------------- preferredWindowEnd ---------------- closingDate
      normal/priority window       overflow allowed                  hard stop
```

For Regular imports, March 31 remains the point used to report overflow. For OJT/Tour, the preferred-month end remains the priority window used by displacement logic. `closingDate` only caps how far the scheduler may search and publish.

- [ ] **Step 5: Run the focused regression suite**

Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/services/schedule-imports.integration.test.ts
```

Expected: all tests in the file pass, including:

- exact-closing-date publication succeeds;
- pair spillover beyond closing date returns `SCHEDULE_CAPACITY_EXHAUSTED`;
- missing academic-year configuration still returns `ACADEMIC_YEAR_NOT_CONFIGURED`;
- existing Standard Regular/OJT/Tour behavior remains green.

- [ ] **Step 6: Run the paired-generator tests to prove its behavior did not need modification**

Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/rule-engine/generate-paired-schedule.test.ts
```

Expected: PASS, including the existing tests that:

- do not reserve a Laboratory slot unless the complete pair fits inside `searchEndDate`;
- allow Regular allocation beyond March when the caller's horizon permits it.

- [ ] **Step 7: Confirm the five-year expression is gone from the Standard import path**

Run:

```bash
rg 'academicYearStart \+ 5|searchEndDate' src/server/repositories/schedule-imports.repository.ts
```

Expected:

- no remaining `academicYearStart + 5` horizon construction;
- `searchEndDate` resolves from `academicYear.closingDate` and is passed through the existing load, blocked-date, and scheduler paths.

- [ ] **Step 8: Commit the tested implementation**

```bash
git add \
  src/server/repositories/academic-years.repository.ts \
  src/server/repositories/schedule-imports.repository.ts \
  src/server/services/schedule-imports.integration.test.ts

git commit -m "fix: bound standard scheduling to academic cycle"
```

---

### Task 3: Run repository-level verification before considering the fix complete

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes the completed implementation from Tasks 1–2.
- Produces verification evidence for the deployment audit.

- [ ] **Step 1: Run the complete automated test suite**

```bash
npm test
```

Expected: exit code `0` and zero failing tests.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: exit code `0`.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: exit code `0`.

- [ ] **Step 4: Review the final diff for scope creep**

```bash
git diff HEAD^ -- \
  src/server/repositories/academic-years.repository.ts \
  src/server/repositories/schedule-imports.repository.ts \
  src/server/services/schedule-imports.integration.test.ts
```

Confirm all of the following before marking the work complete:

- no First Year/OVPSA files changed;
- no migration was added;
- no UI/API contract changed;
- no scheduling algorithm was rewritten;
- the five-year horizon is removed;
- `preferredWindowEnd` and `scheduling_window_end` semantics are unchanged;
- the configured `closing_date` is inclusive;
- both Laboratory and Physical Examination must fit by that date;
- an exhausted horizon rolls back the entire import.

If verification requires a corrective edit, rerun the focused tests plus `npm test`, `npm run lint`, and `npm run build` after the correction before claiming completion.

---

## Acceptance Criteria

The implementation is complete only when all of these statements are true:

1. A Standard import for academic year `Y` never creates an appointment with `appointment_date > academic_years.closing_date` for `Y`.
2. A pair whose Laboratory is on or before the closing date but whose Physical Examination would fall after it is rejected rather than partially or cross-cycle scheduled.
3. A pair whose Physical Examination falls exactly on the closing date is valid when all other scheduling rules permit it.
4. If the complete Standard import cannot fit by the configured closing date, the API returns the existing `SCHEDULE_CAPACITY_EXHAUSTED` 409 error and the import transaction leaves no partial writes.
5. If the academic year is missing, the existing `ACADEMIC_YEAR_NOT_CONFIGURED` 409 contract remains intact.
6. The closing date used for allocation remains stable for the duration of the publishing transaction; a concurrent academic-year closing-date update cannot race the import into committing appointments outside the newly configured boundary.
7. Regular imports may still overflow beyond March 31, but only up to the same cycle's configured closing date.
8. OJT/Tour preferred-month and displacement behavior remain unchanged except that final allocation cannot cross the configured closing date.
9. `scheduling_window_end` keeps its existing preferred-window meaning and is not repurposed as the cycle closing date.
10. First Year/OVPSA scheduling behavior is unchanged by this implementation.
11. Focused schedule-import and paired-generator tests pass.
12. Full `npm test`, `npm run lint`, and `npm run build` pass before deployment readiness is claimed.

## Codex Scope Guard

When implementing this plan, Codex should **not** opportunistically fix the other deployment-audit findings. In particular, do not change First-Year Lab→PE timing, staff-login throttling, migration transaction ownership, upload streaming/locking, HTTPS validation, background workers, or architecture hotspots as part of this commit. Those are separate reviewed tasks with separate regression risk.
