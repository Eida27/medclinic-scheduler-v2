# Task 2 Report: Manual Rescheduling, Concurrency, Capacity, Pair Order, and Lineage

## Status

Complete.

Implementation commit: `a2b613b` (`feat: harden manual appointment rescheduling`)

Base commit verified before implementation: `263007ea24a48de42f15f7ddc3f75508f5438ab7`.

## Outcome

Manual rescheduling remains a one-appointment replacement operation, but it now validates every mutable scheduling invariant inside the mutation transaction after acquiring the global schedule queue and both deterministic pair scopes. The server rejects destinations that are not strictly future Manila dates, weekdays, available for the selected service, within the appointment's current academic cycle, within daily capacity, and strictly ordered against the effective counterpart. The replacement retains history, audit/notification behavior, pair/cycle identity, manual-lock inheritance, and all five existing scheduling-lineage fields.

Standard Schedule Import publication now persists the same scheduling-lineage fields so later replacement and displacement flows can use authoritative stored lineage.

## Changed files

- `src/server/appointments/manual-appointment-destination.ts`
  - Adds the pure manual-destination policy and stable domain errors.
- `src/server/appointments/manual-appointment-destination.test.ts`
  - Covers past/today, weekday, blocking, both cycle edges, both pair directions, capacity, and a valid destination.
- `src/server/services/appointments.service.ts`
  - Acquires the global queue before both pair scopes, performs authoritative re-reads, enforces stale-write protection and destination policy, and preserves the existing replacement/audit/event/notification flow.
- `src/server/services/appointments.service.test.ts`
  - Updates repository mocks and proves the global → Laboratory → Physical Examination advisory-lock order.
- `src/server/services/appointments-manual-rescheduling.integration.test.ts`
  - Adds end-to-end database coverage for all required invalid destinations, optional stale versioning, valid history/lineage preservation, one-appointment-only behavior, and simultaneous last-slot contention.
- `src/server/repositories/appointments.repository.ts`
  - Extends the locked mutation context with lineage, adds locked destination academic-year/capacity reads and active-slot counting, and copies lineage into the replacement appointment.
- `src/server/repositories/appointments.repository.test.ts`
  - Verifies all lineage values are passed to the replacement insert.
- `src/server/repositories/schedule-imports.repository.ts`
  - Populates category, accepted-at, source-row order, window start, and window end on Standard Schedule Import appointments.
- `src/server/services/schedule-imports.integration.test.ts`
  - Verifies both published service appointments contain the expected Standard Import lineage.
- `src/components/appointments/AppointmentActions.tsx`
  - Sends `expectedUpdatedAt` on manual reschedule when an authoritative value is available while preserving backward compatibility when omitted.
- `src/components/appointments/AppointmentActions.test.tsx`
  - Verifies the reschedule request body includes the optional appointment version.
- `src/components/appointments/AppointmentDetail.tsx`
  - Supplies the authoritative appointment `updatedAt` value to the action component.
- `src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx`
  - Verifies the detail surface passes the version token.
- `src/server/services/appointments.integration.test.ts`
  - Moves pre-existing reschedule fixtures to a durable future cycle and adds ownership-aware academic-year fixture cleanup.
- `src/server/services/appointments-locking.integration.test.ts`
  - Configures the appointment's academic cycle for the now-authoritative reschedule validation and cleans it up when owned by the suite.

## Interface and behavior decisions

### Pair resolution and lock order

- Reused Task 1's `lockEffectiveAppointmentScopes` and `resolveEffectiveAppointmentPair`; no duplicate pair-selection logic was introduced.
- The reschedule transaction obtains locks in this order:
  1. `medclinic:schedule-import-queue` global advisory lock;
  2. deterministic Laboratory pair scope;
  3. deterministic Physical Examination pair scope;
  4. authoritative appointment row;
  5. effective pair rows;
  6. academic-year and active capacity-setting rows.
- A small mutation-scope read is used only to obtain the immutable student/service authorization scope needed to choose advisory keys. The appointment and every mutable rule input are re-read after the global and pair locks.
- The existing global queue serializes scheduling writers using the same key as import/recovery flows. Locking the active service capacity row additionally protects configuration while the destination count is validated.

### Destination policy and stable errors

- Dates less than or equal to the current `Asia/Manila` calendar date fail with `APPOINTMENT_DATE_IN_PAST` (`422`).
- Invalid clinic weekdays fail with `APPOINTMENT_DATE_BLOCKED` (`422`).
- Global closures, relevant service restrictions, and conflicting OVPSA reservations fail with `APPOINTMENT_DATE_BLOCKED` (`409`). Service-specific reservations remain scoped to their service.
- Dates before `<schedule_cycle_start>-08-01` or after the configured `academic_years.closing_date` fail with `OUTSIDE_SCHEDULING_CYCLE` (`422`). A missing academic-year row also uses `OUTSIDE_SCHEDULING_CYCLE` (`409`) because the current cycle cannot be authoritatively validated.
- Laboratory on/after effective Physical Examination and Physical Examination on/before effective Laboratory fail with `PAIR_ORDER_VIOLATION` (`409`). The counterpart is never moved automatically.
- A used destination count at or above `max_daily_capacity` fails with `DAILY_CAPACITY_EXCEEDED` (`409`). Capacity uses the existing scheduler semantics: `DRAFT`, `PENDING`, `COMPLETED`, and `NO_SHOW` consume capacity; the source appointment is excluded.
- A missing active capacity setting retains the existing `SCHEDULE_CAPACITY_NOT_CONFIGURED` meaning (`409`).

### Concurrency and stale writes

- The optional existing `expectedUpdatedAt` contract remains optional for backward compatibility.
- When supplied, it is compared with the locked authoritative row. A mismatch fails with `APPOINTMENT_STALE` (`409`) before any replacement, audit event, or notification is written.
- A two-request integration test proves that only one simultaneous move can consume the final destination slot; the other request observes the committed occupancy and fails with `DAILY_CAPACITY_EXCEEDED`.

### Lineage and preserved contracts

- Manual replacements copy `schedule_pair_id`, `schedule_cycle_start`, `scheduling_category`, `scheduling_accepted_at`, `scheduling_source_row_order`, `scheduling_window_start`, and `scheduling_window_end`.
- Standard Schedule Import publication supplies the five scheduling-lineage values from the accepted import and coordinator item/window data.
- Existing authorization, permitted source statuses, OVPSA batch protection, result protection, historical `RESCHEDULED` row behavior, manual-lock inheritance, audit logging, schedule-event creation, committed-state notification, and response retrieval are unchanged.
- No schema change was needed because every required lineage column already exists.
- Automatic displacement/recovery and First Year logic remain untouched for their later tasks.

## TDD evidence

### Baseline

Command:

```text
npm.cmd test -- --run src/server/services/appointments.service.test.ts src/server/repositories/appointments.repository.test.ts src/app/api/appointments/[appointmentId]/route.test.ts src/components/appointments/AppointmentActions.test.tsx src/server/appointments/appointment-pair-integrity.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `5` files passed, `105` tests passed.

### RED 1: destination policy, replacement lineage, and UI version token

Command:

```text
npm.cmd test -- --run src/server/appointments/manual-appointment-destination.test.ts src/server/repositories/appointments.repository.test.ts src/components/appointments/AppointmentActions.test.tsx --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose
```

Observed failures before production edits:

- the manual destination policy module did not exist;
- the reschedule UI omitted `expectedUpdatedAt`;
- the manual replacement insert omitted the five scheduling-lineage fields.

### RED 2: Standard Schedule Import lineage

Command:

```text
npm.cmd test -- --run src/server/services/schedule-imports.integration.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=30000 --hookTimeout=30000 --reporter=verbose
```

Observed result before the repository edit: `1` failed and `10` passed. Both published appointments had null scheduling category, accepted-at, source-row, window-start, and window-end lineage.

### RED 3: authoritative manual rescheduling integration

Command:

```text
npm.cmd test -- --run src/server/services/appointments-manual-rescheduling.integration.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=30000 --hookTimeout=30000 --reporter=dot
```

Observed result after fixture corrections but before production edits: `11` intended failures and `2` passes. Missing behaviors included strict past/today/weekday rejection, stable blocked-date errors, capacity, pair order, cycle bounds, stale-write protection, and last-slot serialization. The two passes confirmed the pre-existing service-specific reservation scoping and history behavior that had to be preserved.

## GREEN verification

### Final consolidated focused verification

Command:

```text
npm.cmd test -- --run 'src/server/appointments/manual-appointment-destination.test.ts' 'src/server/repositories/appointments.repository.test.ts' 'src/server/repositories/effective-appointment-pair.integration.test.ts' 'src/server/services/appointments.service.test.ts' 'src/components/appointments/AppointmentActions.test.tsx' 'src/server/services/appointments-manual-rescheduling.integration.test.ts' 'src/server/services/appointments.integration.test.ts' 'src/server/services/appointments-locking.integration.test.ts' 'src/server/services/appointments-pair-integrity.integration.test.ts' 'src/server/services/appointments-published.integration.test.ts' 'src/server/services/schedule-imports.integration.test.ts' 'src/server/services/schedule-import-lifecycle.integration.test.ts' 'src/app/api/appointments/[appointmentId]/route.test.ts' 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx' --maxWorkers=1 --no-file-parallelism --testTimeout=30000 --hookTimeout=30000 --reporter=dot
```

Final result on the exact implementation commit candidate: `14` files passed, `194` tests passed, `0` failures.

Additional focused evidence gathered during implementation:

- Manual rescheduling integration: `13/13` passed.
- Appointment service unit tests: `70/70` passed.
- Existing appointment integration set: `41/41` passed.
- Post-review fixture-hardening rerun: `3` files and `39/39` tests passed.

### TypeScript

Command:

```text
npx.cmd tsc --noEmit
```

Result: exit code `0`, no diagnostics.

### Scoped ESLint

Command:

```text
npx.cmd eslint 'src/app/(dashboard)/appointments/[appointmentId]/page.test.tsx' 'src/components/appointments/AppointmentActions.test.tsx' 'src/components/appointments/AppointmentActions.tsx' 'src/components/appointments/AppointmentDetail.tsx' 'src/server/appointments/manual-appointment-destination.test.ts' 'src/server/appointments/manual-appointment-destination.ts' 'src/server/repositories/appointments.repository.test.ts' 'src/server/repositories/appointments.repository.ts' 'src/server/repositories/schedule-imports.repository.ts' 'src/server/services/appointments-locking.integration.test.ts' 'src/server/services/appointments-manual-rescheduling.integration.test.ts' 'src/server/services/appointments.integration.test.ts' 'src/server/services/appointments.service.test.ts' 'src/server/services/appointments.service.ts' 'src/server/services/schedule-imports.integration.test.ts'
```

Result: exit code `0`, no findings.

### Diff hygiene

Command:

```text
git diff --check
```

Result: exit code `0`. Git emitted only the repository's existing LF-to-CRLF working-copy notices; no whitespace errors were reported.

## Self-review

- Re-read the Task 2 brief and the authoritative manual-rescheduling, lineage, locking, error, and testing sections against the final diff.
- Confirmed every mutable validation input is obtained after the global queue and deterministic pair locks in the mutation transaction.
- Confirmed pair resolution comes from the Task 1 effective-pair interface and excludes historical rows through that shared implementation.
- Confirmed the replacement insert retains pair/cycle, all five requested lineage fields, and the existing manual-lock inheritance columns.
- Confirmed the Standard Import insert uses accepted import metadata and coordinator source-row data rather than reconstructing lineage later.
- Confirmed manual rescheduling does not invoke any paired-appointment mutation.
- Confirmed authorization and source-status checks run again against the locked authoritative appointment.
- Confirmed failed stale/capacity/pair/date validations precede replacement, audit-event, and notification writes.
- Confirmed the UI change is optional and preserves callers that do not yet provide `updatedAt`.
- Confirmed no migration, First Year behavior, automatic displacement/recovery logic, retired route, public lookup, or unrelated UI was changed.
- Reviewed the two edited React components against the project React checklist: the change only passes/serializes an existing scalar version value and introduces no new state, effect, rendering, accessibility, or performance concern.
- Corrected test-only durability findings during review: Manila past/today dates are calculated dynamically; long generated student numbers were shortened; future-cycle lifecycle fixtures retain the intended snapshot year; and newly owned academic-year rows are cleaned up.

## Concerns and deferred verification

- No known Task 2 source defect remains.
- The hour-long full serialized suite was intentionally not run, per the ledger ruling; it remains reserved for final integrated verification.
- Automatic replacement/displacement and First Year recovery lineage are intentionally deferred to their later tasks and were not modified here.
- Browser acceptance was not requested for this server-integrity task; component/page request-shape coverage is included in the focused verification.
