# Automatic Appointment No-Shows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically mark overdue published Laboratory and Physical Examination appointments as `NO_SHOW`, synchronize linked completed results, and allow audited corrections of system-generated no-shows.

**Architecture:** Add a set-based, concurrency-safe PostgreSQL sweep behind a five-minute application worker started by Next.js instrumentation. Centralize completion authorization and automatic-no-show recognition in the appointment service so both appointment PATCH requests and linked result writes share the same transaction-safe rules.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL with `pg`, Vitest, Testing Library, in-app Browser

## Global Constraints

- Apply the sweep only to published `PENDING` `LABORATORY` and `PHYSICAL_EXAM` appointments.
- Calculate deadlines in `APP_TIMEZONE` (`Asia/Manila` by default).
- Timed deadline: scheduled local timestamp plus 24 hours.
- Date-only deadline: midnight at the start of the second local day after the appointment date.
- Run once at Node server startup and every 300,000 ms thereafter; failed sweeps roll back, log to the server console, and do not stop future sweeps.
- Use the canonical note `Automatically marked no-show after the 24-hour appointment completion window.` for automatic status-history entries.
- Permit `NO_SHOW` to `COMPLETED` only when the latest history row is the canonical system transition, the actor is an administrator or same-clinic staff member, and a correction reason is present.
- Treat linked-result remarks as the correction reason when a completed result corrects an automatic no-show.
- Add no dependency, public route, schema migration, or standalone scheduler.

---

### Task 1: Implement the atomic overdue-appointment sweep

**Files:**
- Create: `src/server/appointments/automatic-no-show.ts`
- Create: `src/server/repositories/appointment-no-show.repository.ts`
- Create: `src/server/repositories/appointment-no-show.integration.test.ts`

**Interfaces:**
- Produces: `AUTOMATIC_NO_SHOW_NOTE`, `isAutomaticNoShowLog(log)`, and `markOverdueAppointmentsNoShow(now, timeZone): Promise<{ count: number; appointmentIds: string[] }>`.
- Consumes: the existing `appointments`, `appointment_status_logs`, and transaction helper.

- [ ] **Step 1: Write the pure policy and failing database-backed tests**

Create the shared policy contract:

```ts
export const AUTOMATIC_NO_SHOW_NOTE =
  "Automatically marked no-show after the 24-hour appointment completion window.";

export type AutomaticNoShowLog = {
  oldStatus: string | null;
  newStatus: string;
  notes: string | null;
  changedById: string | null;
};

export function isAutomaticNoShowLog(log: AutomaticNoShowLog | null | undefined) {
  return Boolean(
    log
      && log.oldStatus === "PENDING"
      && log.newStatus === "NO_SHOW"
      && log.notes === AUTOMATIC_NO_SHOW_NOTE
      && log.changedById === null,
  );
}
```

In the new integration test, create disposable `TEST-AUTO-NS-%` students and published appointments covering:

```ts
const dateOnlyBoundary = new Date("2045-01-11T16:00:00.000Z"); // Jan 12 00:00 Manila
const timedBoundary = new Date("2045-01-11T01:00:00.000Z"); // Jan 11 09:00 Manila
```

Assert both schedule types transition at the exact inclusive boundary, one millisecond before each boundary remains pending, and draft/completed/cancelled/rescheduled/no-show rows remain unchanged. Assert each changed row has exactly one canonical log with `changed_by IS NULL`. Run two sweeps concurrently for one eligible appointment and assert the summed count and log count are both one.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npm test -- "src/server/repositories/appointment-no-show.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `markOverdueAppointmentsNoShow` does not exist.

- [ ] **Step 3: Implement the set-based transactional sweep**

Use one transaction and this query shape in `appointment-no-show.repository.ts`:

```ts
const result = await client.query<{ appointmentId: string }>(
  `WITH overdue AS (
     SELECT appointment.id
       FROM appointments appointment
      WHERE appointment.is_published=TRUE
        AND appointment.status='PENDING'
        AND appointment.schedule_type IN ('LABORATORY','PHYSICAL_EXAM')
        AND CASE
              WHEN appointment.appointment_time IS NULL THEN
                ((appointment.appointment_date + 2)::timestamp AT TIME ZONE $2)
              ELSE
                ((appointment.appointment_date + appointment.appointment_time)
                  AT TIME ZONE $2) + INTERVAL '24 hours'
            END <= $1::timestamptz
      FOR UPDATE SKIP LOCKED
   ), changed AS (
     UPDATE appointments appointment
        SET status='NO_SHOW', updated_by=NULL
       FROM overdue
      WHERE appointment.id=overdue.id
        AND appointment.is_published=TRUE
        AND appointment.status='PENDING'
      RETURNING appointment.id
   )
   INSERT INTO appointment_status_logs (
     appointment_id, old_status, new_status, notes, changed_by
   )
   SELECT changed.id, 'PENDING', 'NO_SHOW', $3, NULL
     FROM changed
   RETURNING appointment_id AS "appointmentId"`,
  [now, timeZone, AUTOMATIC_NO_SHOW_NOTE],
);
```

Return `{ count: result.rowCount ?? 0, appointmentIds: result.rows.map((row) => row.appointmentId) }`. Do not overwrite the appointment's free-form `notes`; status history is the source of the automation reason.

- [ ] **Step 4: Run focused and adjacent repository tests and verify GREEN**

```powershell
npm test -- "src/server/repositories/appointment-no-show.integration.test.ts" "src/server/repositories/appointments.repository.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: PASS with no duplicate logs and no leaked fixtures.

- [ ] **Step 5: Commit the sweep**

```powershell
git add -- "src/server/appointments/automatic-no-show.ts" "src/server/repositories/appointment-no-show.repository.ts" "src/server/repositories/appointment-no-show.integration.test.ts"
git commit -m "feat: reconcile overdue appointments"
```

---

### Task 2: Start the five-minute worker with the application

**Files:**
- Create: `src/server/services/appointment-no-show.service.ts`
- Create: `src/server/workers/appointment-no-show.worker.ts`
- Create: `src/server/workers/appointment-no-show.worker.test.ts`
- Create: `src/instrumentation.ts`
- Create: `src/instrumentation.test.ts`

**Interfaces:**
- Consumes: `markOverdueAppointmentsNoShow(now, serverEnv().APP_TIMEZONE)`.
- Produces: `sweepOverdueAppointments(now?)` and `startAppointmentNoShowWorker(dependencies?)`.

- [ ] **Step 1: Write failing worker lifecycle tests**

Use injected dependencies rather than real timers or PostgreSQL:

```ts
type WorkerDependencies = {
  sweep?: () => Promise<unknown>;
  schedule?: (callback: () => void, intervalMs: number) => { unref?: () => void };
  reportError?: (message: string, error: unknown) => void;
};
```

Test that the first start calls `sweep` immediately, schedules exactly `300_000`, calls `unref`, and a second start in the same process does nothing. Invoke the captured interval callback and assert it performs another sweep. Reject one sweep and assert the canonical error message is reported while the callback remains usable.

For instrumentation, mock `startAppointmentNoShowWorker`, set `NEXT_RUNTIME=nodejs`, call `register()`, and expect one start. Set a non-Node runtime and expect none.

- [ ] **Step 2: Run the worker tests and verify RED**

```powershell
npm test -- "src/server/workers/appointment-no-show.worker.test.ts" "src/instrumentation.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because the worker and instrumentation hook do not exist.

- [ ] **Step 3: Implement the service, guarded worker, and startup hook**

Service:

```ts
export function sweepOverdueAppointments(now = new Date()) {
  return markOverdueAppointmentsNoShow(now, serverEnv().APP_TIMEZONE);
}
```

Worker behavior:

```ts
export const APPOINTMENT_NO_SHOW_INTERVAL_MS = 5 * 60 * 1000;

declare global {
  var __medclinicAppointmentNoShowWorkerStarted: boolean | undefined;
}

export function startAppointmentNoShowWorker(dependencies: WorkerDependencies = {}) {
  if (globalThis.__medclinicAppointmentNoShowWorkerStarted) return false;
  globalThis.__medclinicAppointmentNoShowWorkerStarted = true;

  const sweep = dependencies.sweep ?? sweepOverdueAppointments;
  const reportError = dependencies.reportError ?? console.error;
  const run = () => void sweep().catch((error) => {
    reportError("Automatic appointment no-show sweep failed.", error);
  });

  run();
  const timer = (dependencies.schedule ?? setInterval)(run, APPOINTMENT_NO_SHOW_INTERVAL_MS);
  timer.unref?.();
  return true;
}
```

Startup hook:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAppointmentNoShowWorker } = await import(
      "@/server/workers/appointment-no-show.worker"
    );
    startAppointmentNoShowWorker();
  }
}
```

- [ ] **Step 4: Run focused tests and a production build**

```powershell
npm test -- "src/server/workers/appointment-no-show.worker.test.ts" "src/instrumentation.test.ts" --maxWorkers=1 --no-file-parallelism
npm run build
```

Expected: tests pass and Next.js recognizes the instrumentation hook without bundling the PostgreSQL worker into the Edge runtime.

- [ ] **Step 5: Commit the worker**

```powershell
git add -- "src/server/services/appointment-no-show.service.ts" "src/server/workers/appointment-no-show.worker.ts" "src/server/workers/appointment-no-show.worker.test.ts" "src/instrumentation.ts" "src/instrumentation.test.ts"
git commit -m "feat: run automatic no-show worker"
```

---

### Task 3: Add protected correction of automatic no-shows

**Files:**
- Modify: `src/server/repositories/appointments.repository.ts`
- Modify: `src/server/services/appointments.service.ts`
- Modify: `src/server/services/appointments.service.test.ts`
- Modify: `src/server/services/appointments.integration.test.ts`
- Modify: `src/app/api/appointments/[appointmentId]/route.ts`
- Modify: `src/app/api/appointments/[appointmentId]/route.test.ts`
- Modify: `src/components/appointments/AppointmentActions.tsx`
- Create: `src/components/appointments/AppointmentActions.test.tsx`
- Modify: `src/app/(dashboard)/appointments/[appointmentId]/page.tsx`
- Modify: `src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx`

**Interfaces:**
- Changes: `updateAppointment(id, raw, actor: SessionUser)` replaces the user-ID-only signature.
- Produces: `completeAppointmentWithClient(id, actor, reason, client)` for reuse by linked result completion.
- Changes: `AppointmentActions` accepts `canCorrectNoShow?: boolean`.

- [ ] **Step 1: Write failing authorization, correction, route, and UI tests**

Cover these exact outcomes:

```ts
// allowed
PENDING -> COMPLETED                 // existing behavior
automatic NO_SHOW -> COMPLETED       // admin with reason
automatic NO_SHOW -> COMPLETED       // same-clinic staff with reason

// rejected with 403 or 422
automatic NO_SHOW -> COMPLETED       // missing/blank reason
manual NO_SHOW -> COMPLETED          // canonical history test fails
automatic NO_SHOW -> COMPLETED       // cross-clinic staff
any appointment mutation             // coordinator
```

In the route test, assert `requireUser(["ADMIN", "CLINIC_STAFF"])` and the full session object are passed to `updateAppointment`. In the component test, assert the correction form appears only when `status="NO_SHOW"` and `canCorrectNoShow`, contains hidden `status=COMPLETED`, requires a reason, and sends that reason. In the page test, mock `requireUser` and assert automatic history plus matching clinic scope enables the form.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- "src/server/services/appointments.service.test.ts" "src/server/services/appointments.integration.test.ts" "src/app/api/appointments/[appointmentId]/route.test.ts" "src/components/appointments/AppointmentActions.test.tsx" "src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because automatic no-show correction and scoped authorization do not exist.

- [ ] **Step 3: Add locked completion primitives to the repository**

Add a transaction-aware loader that locks the published appointment and returns clinic/status plus the latest history fields:

```ts
export type AppointmentMutationContext = {
  id: string;
  status: AppointmentStatus;
  clinicId: string;
  clinicCode: ClinicCode;
  latestLog: AutomaticNoShowLog | null;
};

export async function getAppointmentMutationContext(id: string, client: PoolClient) {
  const result = await client.query<{
    id: string;
    status: AppointmentStatus;
    clinicId: string;
    clinicCode: ClinicCode;
    latestOldStatus: string | null;
    latestNewStatus: string | null;
    latestNotes: string | null;
    latestChangedById: string | null;
  }>(
    `SELECT appointment.id, appointment.status,
            appointment.clinic_id AS "clinicId", clinic.code AS "clinicCode",
            latest.old_status AS "latestOldStatus",
            latest.new_status AS "latestNewStatus",
            latest.notes AS "latestNotes",
            latest.changed_by AS "latestChangedById"
       FROM appointments appointment
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
       LEFT JOIN LATERAL (
         SELECT old_status, new_status, notes, changed_by
           FROM appointment_status_logs
          WHERE appointment_id=appointment.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE appointment.id=$1 AND appointment.is_published=TRUE
      FOR UPDATE OF appointment`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    clinicId: row.clinicId,
    clinicCode: row.clinicCode,
    latestLog: row.latestNewStatus ? {
      oldStatus: row.latestOldStatus,
      newStatus: row.latestNewStatus,
      notes: row.latestNotes,
      changedById: row.latestChangedById,
    } : null,
  };
}
```

Add this exact primitive and keep the existing wrapper for non-completion paths by delegating it through `transaction`:

```ts
export async function changeAppointmentStatusWithClient(
  client: PoolClient,
  id: string,
  expectedOldStatus: AppointmentStatus,
  newStatus: AppointmentStatus,
  notes: string | null,
  actorUserId: string,
) {
  const changed = await client.query(
    `UPDATE appointments
        SET status=$3, notes=COALESCE($4, notes), updated_by=$5
      WHERE id=$1 AND status=$2 AND is_published=TRUE
      RETURNING id`,
    [id, expectedOldStatus, newStatus, notes, actorUserId],
  );
  if (!changed.rowCount) {
    throw new AppError("APPOINTMENT_STATUS_CONFLICT", "The appointment status changed. Refresh and try again.", 409);
  }
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     ) VALUES ($1,$2,$3,$4,$5)`,
    [id, expectedOldStatus, newStatus, notes, actorUserId],
  );
}
```

- [ ] **Step 4: Centralize completion and authorization in the service**

Implement these rules in `completeAppointmentWithClient`:

```ts
if (!(["ADMIN", "CLINIC_STAFF"] as const).includes(actor.role)) {
  throw new AppError("FORBIDDEN", "You do not have permission to update appointments.", 403);
}
if (actor.role === "CLINIC_STAFF" && actor.clinicId !== appointment.clinicId) {
  throw new AppError("CLINIC_ACCESS_DENIED", "You can only manage your assigned clinic.", 403);
}
if (appointment.status === "NO_SHOW") {
  if (!isAutomaticNoShowLog(appointment.latestLog)) {
    throw new AppError("NO_SHOW_CORRECTION_NOT_ALLOWED", "Only an automatic no-show can be corrected to completed.", 422);
  }
  if (!reason?.trim()) {
    throw new AppError("CORRECTION_REASON_REQUIRED", "Enter a reason for correcting this automatic no-show.", 422);
  }
} else if (appointment.status !== "PENDING") {
  assertStatusTransition(appointment.status, "COMPLETED");
}
```

`updateAppointment` must authorize the full actor for every mutation. For completion, wrap `completeAppointmentWithClient` and `writeAudit` in one transaction; use audit action `APPOINTMENT_STATUS_CORRECTED` when the old status is `NO_SHOW`, otherwise `APPOINTMENT_STATUS_CHANGED`. Include `oldStatus`, `newStatus`, `reason`, and `source: "APPOINTMENT_DETAIL"` in metadata.

- [ ] **Step 5: Expose the correction only to eligible users**

Restrict PATCH through `requireUser(["ADMIN", "CLINIC_STAFF"])`. On the appointment page, compute `canCorrectNoShow` from the current user, appointment clinic, and `isAutomaticNoShowLog(statusLogs[0])`. Render a dedicated correction form with required reason and a `Correct to completed` button; keep the existing reschedule form available.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
npm test -- "src/server/services/appointments.service.test.ts" "src/server/services/appointments.integration.test.ts" "src/app/api/appointments/[appointmentId]/route.test.ts" "src/components/appointments/AppointmentActions.test.tsx" "src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx" --maxWorkers=1 --no-file-parallelism
```

Expected: all correction, permission, history, and UI tests pass.

- [ ] **Step 7: Commit correction support**

```powershell
git add -- "src/server/repositories/appointments.repository.ts" "src/server/services/appointments.service.ts" "src/server/services/appointments.service.test.ts" "src/server/services/appointments.integration.test.ts" "src/app/api/appointments/[appointmentId]/route.ts" "src/app/api/appointments/[appointmentId]/route.test.ts" "src/components/appointments/AppointmentActions.tsx" "src/components/appointments/AppointmentActions.test.tsx" "src/app/(dashboard)/appointments/[appointmentId]/page.tsx" "src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx"
git commit -m "feat: correct automatic appointment no-shows"
```

---

### Task 4: Atomically synchronize linked completed results

**Files:**
- Modify: `src/server/repositories/tracking.repository.ts`
- Modify: `src/server/services/tracking.service.ts`
- Modify: `src/server/services/tracking.integration.test.ts`
- Modify: `src/app/api/results/route.ts`
- Create: `src/app/api/results/route.test.ts`

**Interfaces:**
- Changes: `recordResult(raw, actor: SessionUser)` replaces the user-ID-only signature.
- Consumes: `completeAppointmentWithClient` and transaction-aware repository calls.
- Preserves: historical result writes where `appointmentId` is null.

- [ ] **Step 1: Write failing linked-completion tests**

Database-backed cases:

```ts
linked PENDING physical appointment + COMPLETED result -> both COMPLETED, one appointment log
linked PENDING laboratory appointment + COMPLETED result -> both COMPLETED, one appointment log
linked automatic NO_SHOW + COMPLETED result + remarks -> corrected and audited
linked automatic NO_SHOW + COMPLETED result + blank remarks -> full rollback
linked manual NO_SHOW + COMPLETED result -> full rollback
linked cross-clinic appointment + staff actor -> full rollback
historical COMPLETED result without appointment -> result only, unchanged behavior
```

Also force an appointment-transition failure after result validation and assert no result or audit row remains. Route tests must assert the full authenticated session user is passed to `recordResult`.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- "src/server/services/tracking.integration.test.ts" "src/app/api/results/route.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because result writes do not synchronize appointments or share a transaction.

- [ ] **Step 3: Make tracking repository calls transaction-aware**

Add these exact repository contracts:

```ts
export async function getResultAppointmentForUpdate(
  appointmentId: string,
  client: PoolClient,
): Promise<{ studentNumber: string; scheduleType: ResultType } | null> {
  const result = await client.query<{
    studentNumber: string;
    scheduleType: ResultType;
  }>(
    `SELECT student_number AS "studentNumber", schedule_type AS "scheduleType"
       FROM appointments
      WHERE id=$1 AND is_published=TRUE
      FOR UPDATE`,
    [appointmentId],
  );
  return result.rows[0] ?? null;
}

export async function upsertResult(
  input: {
    studentNumber: string;
    appointmentId: string | null;
    resultType: ResultType;
    resultStatus: string;
    completedAt: string | null;
    remarks: string | null;
    actorUserId: string;
  },
  client: PoolClient,
): Promise<{ id: string }>;
```

`getResultAppointmentForUpdate` is the sole appointment match check. `upsertResult` must execute the existing `INSERT ... ON CONFLICT` through `client.query` and must not open another transaction or query through the pool.

- [ ] **Step 4: Wrap the full linked-result flow in one service transaction**

The service sequence must be:

```ts
return transaction(async (client) => {
  const appointment = input.appointmentId
    ? await getResultAppointmentForUpdate(input.appointmentId, client)
    : null;
  validateResultAppointmentMatch(appointment, input);

  if (input.appointmentId && input.resultStatus === "COMPLETED") {
    await completeAppointmentWithClient(
      input.appointmentId,
      actor,
      input.remarks,
      client,
    );
  }

  const result = await upsertResult({ ...input, actorUserId: actor.userId }, client);
  await writeAudit(
    actor.userId,
    "RESULT_RECORDED",
    input.resultType.toLowerCase(),
    result.id,
    { studentNumber: input.studentNumber, status: input.resultStatus },
    client,
  );
  return result;
});
```

When completion changes the appointment, add the appointment audit in the same transaction with `source: "LINKED_RESULT"`. If the appointment is already `COMPLETED`, allow the result upsert without adding another status log.

- [ ] **Step 5: Run focused and adjacent tests and verify GREEN**

```powershell
npm test -- "src/server/services/tracking.integration.test.ts" "src/app/api/results/route.test.ts" "src/server/repositories/appointment-summary.integration.test.ts" --maxWorkers=1 --no-file-parallelism
```

Expected: all linked completion, rollback, compliance-summary, and route tests pass.

- [ ] **Step 6: Commit result synchronization**

```powershell
git add -- "src/server/repositories/tracking.repository.ts" "src/server/services/tracking.service.ts" "src/server/services/tracking.integration.test.ts" "src/app/api/results/route.ts" "src/app/api/results/route.test.ts"
git commit -m "feat: sync completed results with appointments"
```

---

### Task 5: Document and verify the complete workflow

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: startup catch-up, five-minute sweep cadence, `APP_TIMEZONE`, date-only rule, linked completion, and correction permissions.

- [ ] **Step 1: Update operational documentation**

Add an `Automatic no-show reconciliation` subsection to the local deployment guidance stating:

```markdown
- The application checks overdue published appointments when the server starts and every five minutes while it remains running.
- Timed appointments become no-show 24 hours after their scheduled time in `APP_TIMEZONE`.
- Date-only appointments receive the full scheduled day plus the following 24 hours; a July 10 appointment becomes eligible at July 12, 12:00 AM.
- Completing a linked result also completes its appointment.
- Administrators and assigned clinic staff can correct a system-generated no-show with a required reason; manual no-shows cannot be corrected to completed.
- Downtime does not lose transitions: the startup sweep catches up when the server returns.
```

- [ ] **Step 2: Run the full automated verification bar**

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism
npm run lint
npm run build
```

Expected: all commands exit 0 with no fixture leakage.

- [ ] **Step 3: Perform Browser acceptance for both clinics**

Insert two disposable students and overdue published appointments, one `LABORATORY` and one `PHYSICAL_EXAM`, using the `TEST-BROWSER-NS-%` prefix. Start the production app so the startup sweep processes both. In the in-app Browser:

1. Sign in as the seeded administrator.
2. Open `/laboratory`, filter for the Laboratory fixture, and confirm `NO_SHOW`.
3. Open `/physical-exam`, filter for the Physical Examination fixture, and confirm `NO_SHOW`.
4. Open each appointment detail and confirm `PENDING -> NO_SHOW`, `System`, and the canonical automation note.
5. Correct one fixture to `COMPLETED` with reason `Browser verification correction`; confirm the status and history update.
6. Confirm the other no-show appears in `/appointments` and increments dashboard no-show data consistently.

- [ ] **Step 4: Remove browser fixtures and prove cleanup**

Remove the fixtures in one database transaction using a temporary appointment-ID table, in this order: audit rows whose entity ID or `metadata.studentNumber` matches the fixtures; exam and laboratory results; appointment history; appointments; students. Query all five affected record groups afterward and require zero matches. Use this SQL shape so audit rows remain addressable before appointments are deleted:

```sql
BEGIN;
CREATE TEMP TABLE browser_no_show_appointments ON COMMIT DROP AS
SELECT id FROM appointments WHERE student_number LIKE 'TEST-BROWSER-NS-%';
DELETE FROM audit_logs
 WHERE entity_id IN (SELECT id::text FROM browser_no_show_appointments)
    OR metadata->>'studentNumber' LIKE 'TEST-BROWSER-NS-%';
DELETE FROM exam_results WHERE student_number LIKE 'TEST-BROWSER-NS-%';
DELETE FROM laboratory_results WHERE student_number LIKE 'TEST-BROWSER-NS-%';
DELETE FROM appointment_status_logs
 WHERE appointment_id IN (SELECT id FROM browser_no_show_appointments);
DELETE FROM appointments WHERE id IN (SELECT id FROM browser_no_show_appointments);
DELETE FROM students WHERE student_number LIKE 'TEST-BROWSER-NS-%';
COMMIT;
```

- [ ] **Step 5: Re-run focused post-cleanup verification**

```powershell
npm test -- "src/server/repositories/appointment-no-show.integration.test.ts" "src/server/services/appointments.integration.test.ts" "src/server/services/tracking.integration.test.ts" --maxWorkers=1 --no-file-parallelism
git diff --check
git status --short
```

Expected: tests pass, the diff is clean, and only intended documentation/code changes remain.

- [ ] **Step 6: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: explain automatic appointment no-shows"
```
