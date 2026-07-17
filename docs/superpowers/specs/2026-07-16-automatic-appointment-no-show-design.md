# Automatic Appointment No-Show Design

## Goal

Reduce repetitive clinic work by automatically changing overdue published appointments from `PENDING` to `NO_SHOW` for both Laboratory and Physical Examination scheduling, without misclassifying completed work or losing an auditable correction path.

## Deadline Semantics

- Only published `PENDING` appointments are eligible. Draft, completed, cancelled, rescheduled, and already no-show appointments never change during a sweep.
- All deadline calculations use `APP_TIMEZONE`, whose deployment default is `Asia/Manila`.
- Appointments with and without a time share one deadline: midnight at the start of the local day after `appointment_date`. In boundary terms, every July 10 appointment becomes eligible at July 11, 12:00 AM local time.
- `appointment_time` remains available for scheduling and display but never extends the automatic no-show deadline.
- The comparison is inclusive: an appointment is eligible when the current instant is equal to or later than its deadline.
- The policy applies to existing appointments as well as newly published appointments. On first deployment, the current dataset has no appointment already beyond the deadline.

## Automation Architecture

- A Node-runtime startup hook starts one application-local worker when the Next.js server boots.
- The worker runs one sweep immediately, then schedules a one-shot timer for the next local midnight. After each successful sweep it calculates and schedules the following midnight, providing exact-midnight execution and restart catch-up without a separate Windows Task Scheduler deployment step.
- Each sweep performs one set-based PostgreSQL transaction. It locks and updates only rows that are still published and `PENDING`, then inserts one matching `appointment_status_logs` row per changed appointment.
- Automatic history entries have no user actor, so the existing appointment history displays `System`. New entries state that the appointment day ended; the former completion-window note remains recognized only so historical automatic no-shows stay correctable.
- The update is idempotent and concurrency-safe. Multiple server processes may attempt a sweep, but row locking and rechecking status allow each appointment to transition and log only once.
- The worker logs sweep or midnight-calculation failures to the server console and retries after five minutes. A failed transaction changes no appointment or history row.
- The interval is unreferenced so it does not prevent normal process shutdown. Development hot reload must not register duplicate timers within one process.

## Completion and Correction Behavior

### Linked result completion

- Saving a linked Physical Examination or Laboratory result as `COMPLETED` must atomically change its published appointment from `PENDING` to `COMPLETED` and insert the standard status-history entry.
- The result write, appointment transition, status-history insert, and result audit entry succeed or roll back together.
- A linked result cannot be used to complete an appointment that is draft, cancelled, rescheduled, or manually marked no-show.
- A linked `COMPLETED` result may correct a system-generated `NO_SHOW` under the correction rules below.
- Historical results without an appointment remain unchanged.

### Correcting an automatic no-show

- Administrators and clinic staff assigned to the appointment's clinic may correct a system-generated `NO_SHOW` to `COMPLETED`.
- The user must supply a non-empty correction reason. The reason is stored in appointment status history and included in the audit metadata.
- A no-show is system-generated only when its latest status-history entry is the automatic `PENDING` to `NO_SHOW` transition with a null actor and the canonical automation note. Manually selected no-shows are not eligible for this correction.
- Coordinators cannot update appointment statuses. Clinic staff cannot update appointments outside their assigned clinic. Administrators retain cross-clinic access.
- Other status-transition rules stay unchanged: completed appointments remain final, and any no-show can still be rescheduled using the existing replacement flow.

## Interfaces and Data Flow

- No new public page or standalone admin control is added.
- The existing appointment `PATCH` route accepts `NO_SHOW` to `COMPLETED` only for an eligible automatic no-show and requires `notes` as the correction reason.
- Appointment status updates receive the full authenticated session user so the service can enforce role and clinic scope instead of trusting the client.
- The results service and repository use a single database transaction for linked completion synchronization.
- The Laboratory and Physical Examination schedule pages, combined Appointments & Completion page, dashboard metrics, student history, public schedule lookup, and appointment detail history consume the updated stored status through their existing queries.

## Verification

- Unit tests cover transition validation, mandatory correction reasons, exact-midnight scheduling, late callbacks, failure retries, and worker lifecycle behavior.
- Database-backed tests cover both schedule types; timed and date-only boundary instants; exclusion of unpublished and non-pending rows; one log per transition; repeat and concurrent sweeps; and immediate restart catch-up behavior through an explicit sweep invocation.
- Integration tests cover atomic linked-result completion, rollback behavior, automatic no-show correction, manual no-show rejection, administrator access, same-clinic staff access, cross-clinic staff rejection, and coordinator rejection.
- Existing full tests, lint, and production build must pass.
- Browser acceptance verifies an overdue Laboratory appointment and an overdue Physical Examination appointment display as `NO_SHOW`, show a System history entry, and allow an authorized correction to `COMPLETED` with its reason visible in history.
- Browser test fixtures must be removed and database cleanup verified after acceptance.

## Deployment and Operations

- Add no external scheduler or dependency.
- Document that automatic reconciliation runs only while the application server is running and catches up immediately on the next startup.
- Document the shared next-day-midnight rule, exact-midnight timer, and five-minute failure retry.
- Keep `APP_TIMEZONE=Asia/Manila` as the deployment default; the worker must use the configured value rather than a second hard-coded timezone.
