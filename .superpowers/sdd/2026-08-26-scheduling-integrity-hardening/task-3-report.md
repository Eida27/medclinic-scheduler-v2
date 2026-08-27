# Task 3 Report: Generalized Manual Resolution and Bounded Standard Displacement

## Status

Complete.

Base commit: `df76e3d42e3b77538cd647d844c941732816f25f`.

Task commits:

- `2e9550d` — `feat: generalize manual resolution schema`
- `fa553a0` — `feat: share automatic replacement bounds`
- `fa38bfc` — `feat: generalize manual resolution contracts`
- `dea10c0` — `feat: bound standard priority displacement`

## Outcome

Migration 025 reuses `clinic_closure_manual_cases` as the shared Manual Resolution queue for clinic closures and automatic displacement. Existing closure rows are preserved and backfilled as `CLINIC_CLOSURE`; automatic displacement cases may omit closure context and use the new `NO_VALID_REPLACEMENT_WITHIN_CYCLE` reason.

Standard priority displacement now reads persisted FCFS, category, source-row, pair, cycle, and scheduling-window lineage, using deterministic legacy fallbacks only for older rows that lack persisted values. It plans all replacements before changing the displaced appointment state, searches from the shared Manila-aware lower bound through each candidate's academic-year closing date, and continues beyond March when the same cycle remains open.

Candidates with valid dates receive published lineage-preserving replacements and `RESCHEDULED` history. Exhausted candidates move to `AWAITING_RESCHEDULE` with an OPEN `AUTOMATIC_DISPLACEMENT` Manual Resolution case, an `AWAITING_RESCHEDULE` reschedule event, the stable reason `NO_VALID_REPLACEMENT_WITHIN_CYCLE`, lineage/origin metadata, audit evidence, and an awaiting-resolution student notification that contains no replacement date. Incoming priority publication, replacements, fallback state, queue cases, events, audits, and notifications remain in one transaction.

## Changed files and interfaces

### Database

- `database/migrations/025_scheduling_integrity_hardening.sql`
  - Adds `clinic_closure_manual_cases.case_source` with values `CLINIC_CLOSURE` and `AUTOMATIC_DISPLACEMENT`.
  - Backfills all existing rows to `CLINIC_CLOSURE`, then applies a compatible default and `NOT NULL` constraint.
  - Makes `closure_group_id` nullable only when `case_source='AUTOMATIC_DISPLACEMENT'`.
  - Extends the manual-case and appointment-reschedule-event reason constraints with `NO_VALID_REPLACEMENT_WITHIN_CYCLE`.
- `src/server/db/scheduling-integrity-hardening-migration.integration.test.ts`
  - Proves the migration, legacy backfill/default behavior, source/closure integrity, new reason support, and reapplication behavior.

### Shared policy

- `src/server/scheduling/automatic-replacement-bounds.ts`
  - Adds `resolveAutomaticReplacementBounds`.
  - Pair/Laboratory lower bound is `max(originalWindowStart, Manila today + 1 day)`.
  - Physical-Examination-only lower bound also includes `laboratoryDate + 1 day`.
  - Upper bound is the persisted cycle's configured academic-year closing date.
- `src/server/scheduling/automatic-replacement-bounds.test.ts`
  - Covers original-window, Manila-next-day, Physical Examination ordering, and closing-date output.

### Manual Resolution contracts and service

- `src/types/clinic-calendar.ts`
  - Adds `ClinicManualCaseSource` and `ClinicManualCaseDto.caseSource`.
  - Makes closure-only queue context nullable.
  - Adds `NO_VALID_REPLACEMENT_WITHIN_CYCLE` to the shared reason contract.
- `src/server/services/clinic-calendar.service.ts`
  - Lists automatic-displacement cases through the shared queue even without a closure group.
  - Resolves automatic cases through the existing Manual Resolution operation.
  - Copies persisted scheduling lineage into manually assigned replacements.
  - Uses `AUTOMATIC_DISPLACEMENT_MANUAL_CASE_RESOLVED` for automatic-case resolution audit while preserving the closure audit action for closure cases.
- `src/server/services/clinic-calendar.integration.test.ts`
  - Covers listing and resolving a no-closure automatic-displacement case, lineage preservation, and source-specific resolution audit.

### Standard priority displacement

- `src/server/repositories/priority-displacement.repository.ts`
  - Extends `DisplacementCandidate` with scheduling category, accepted-at, source row, window start/end, cycle start, and cycle closing date.
  - Candidate queries prefer persisted appointment lineage and use deterministic import/appointment legacy fallbacks only where values are absent.
  - Adds the `AWAITING_RESCHEDULE` state/history mutation for fallback candidates.
- `src/server/repositories/schedule-imports.repository.ts`
  - Removes the pre-planning destructive displacement update.
  - Publishes incoming priority rows and delegates replacement/fallback application within the existing transaction, global schedule queue, and effective-scope locks.
- `src/server/services/priority-displacement.service.ts`
  - Computes per-candidate shared bounds and plans sequential FCFS allocations against shared in-transaction load.
  - Applies normal weekday, closure/reservation, and capacity rules.
  - Retains the existing exclusion of external OVPSA Laboratory rows from KABALAKA capacity.
  - Preserves pair/cycle/window/category/accepted/source lineage on replacement appointments and event metadata.
  - Writes successful replacement events with `REPLACED` outcomes.
  - Writes exhausted cases/events/audits/awaiting notifications without inventing a date.
  - Removes obsolete public helpers that could mark appointments before replacement planning.
- `src/server/services/priority-displacement.integration.test.ts`
  - Covers persisted-lineage preference, post-March allocation through closing date, Physical-Examination-only lower bounds, mixed successful/fallback outcomes, queue/event/audit/notification semantics, and whole-transaction rollback.

No First Year planner/apply logic, retired route, public lookup, queue UI, or unrelated behavior was changed.

## TDD evidence

### Migration RED/GREEN

Command:

```text
npm.cmd test -- src/server/db/scheduling-integrity-hardening-migration.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

RED: the new integration test failed because migration 025 did not exist and the generalized source/reason constraints were unavailable.

GREEN: `1` file passed, `1/1` test passed.

### Shared bounds RED/GREEN

Command:

```text
npm.cmd test -- src/server/scheduling/automatic-replacement-bounds.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

RED: the policy module did not exist; the intended assertions exposed a lower bound that could remain in the past and Physical-Examination-only planning that ignored Laboratory date plus one day.

GREEN: `1` file passed, `3/3` tests passed.

### Generalized Manual Resolution RED/GREEN

Command:

```text
npm.cmd test -- src/server/services/clinic-calendar.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

RED: an `AUTOMATIC_DISPLACEMENT` case with no closure group was omitted by the closure-only inner join. Later focused RED assertions also showed manually assigned replacements lacked persisted lineage and resolution used the closure-specific audit action.

GREEN: the complete clinic-calendar integration file passed `16/16`; focused automatic-case resolution also passed after lineage and audit corrections.

### Standard displacement RED/GREEN

Command:

```text
npm.cmd test -- src/server/services/priority-displacement.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

RED observations before production changes:

- candidate reads returned current import acceptance/source fallback values rather than persisted appointment values, and omitted persisted category/window/cycle-close lineage;
- a mixed batch with one post-March valid replacement and one exhausted candidate threw `REGULAR_REPLACEMENT_CAPACITY_EXHAUSTED` instead of committing a replacement plus Manual Resolution fallback;
- successful reschedule events had null strategy/outcome and empty policy metadata;
- Manual Resolution assignment from an automatic case created replacements with null lineage;
- automatic-case resolution emitted the closure-specific audit action.

GREEN: `1` file passed, `8/8` tests passed. This includes pair and Physical-Examination-only planning, same-cycle post-March allocation, persisted lineage, mixed fallback, case/event/audit/notification assertions, and forced rollback after incoming priority publication plus fallback writes.

## Final focused verification

Primary focused batch:

```text
npm.cmd test -- src/server/db/scheduling-integrity-hardening-migration.integration.test.ts src/server/scheduling/automatic-replacement-bounds.test.ts src/server/services/clinic-calendar.integration.test.ts src/server/services/priority-displacement.integration.test.ts src/server/services/schedule-imports.integration.test.ts src/server/services/schedule-import-lifecycle.integration.test.ts src/server/repositories/effective-appointment-scope-lock.repository.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `7` files passed, `44/44` tests passed, exit code `0`.

Notification regression:

```text
npm.cmd test -- src/server/schedule/schedule-notifications.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `1` file passed, `11/11` tests passed, exit code `0`.

An earlier eight-file combined invocation completed all seven preceding files at `44/44` but Vitest timed out while starting the final worker for the unchanged notification test. The notification file immediately passed `11/11` in isolation, and the seven-file batch then passed `44/44` with exit code `0`; this was a worker-start harness timeout, not a source-test failure.

Additional final checks:

```text
npx.cmd tsc --noEmit
npx.cmd eslint src/server/db/scheduling-integrity-hardening-migration.integration.test.ts src/server/scheduling/automatic-replacement-bounds.ts src/server/scheduling/automatic-replacement-bounds.test.ts src/types/clinic-calendar.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.integration.test.ts src/server/repositories/priority-displacement.repository.ts src/server/repositories/schedule-imports.repository.ts src/server/services/priority-displacement.service.ts src/server/services/priority-displacement.integration.test.ts
git diff --check
```

Results: TypeScript exit `0` with no diagnostics; scoped ESLint exit `0` with no findings; diff-check exit `0` with only working-copy LF-to-CRLF notices and no whitespace errors.

The full suite was intentionally not run, per the task ledger ruling reserving it for final integrated verification.

## Migration and rollback compatibility

- Existing rows are updated before `case_source` becomes `NOT NULL`, so current closure cases and their resolution history remain valid.
- The `CLINIC_CLOSURE` default preserves compatibility for existing closure-case inserts that do not yet name the new column.
- The closure/source check retains the old invariant for closure cases while narrowly permitting a null `closure_group_id` for automatic displacement.
- Both reason constraints retain all prior values and only add `NO_VALID_REPLACEMENT_WITHIN_CYCLE`.
- Constraint drops are name-scoped and the migration uses `IF NOT EXISTS` for the new column, supporting the repository's forward-repair/reapply model.
- There is no destructive down migration pattern in this repository. Dropping `case_source` or restoring unconditional closure-group non-nullability would be unsafe after automatic cases exist; operational rollback should roll application code forward/repair schema rather than discard committed queue history. Older application closure inserts remain compatible through the default.

## Atomicity, locking, audit, and notifications

- The existing `medclinic:schedule-import-queue` transaction lock and deterministic effective appointment-scope locks are retained.
- Candidate rows are locked, capacity/blocked-date state is loaded, and every candidate is planned before old appointment statuses are changed.
- Replacement-load accounting excludes the locked displaced rows and retains the existing external OVPSA Laboratory exclusion.
- Incoming priority appointments, displaced status history, replacement appointments, fallback cases, reschedule events, audit rows, and notification outbox rows share the caller's transaction.
- The rollback test inserts incoming priority appointments, runs a forced fallback, throws before commit, and verifies zero incoming appointments, cases, events, and notifications while the original pair remains `PENDING`.
- Per the task ruling, the committed OPEN Manual Resolution queue case plus audit row is the staff operational notification. No separate staff-notification table or fabricated appointment date was introduced.
- The optional student fallback message uses only `buildAwaitingResolutionNotification`, is built from committed state by the existing notification hook, and contains no replacement date. `buildPriorityDisplacementNotification` is used only for real replacements.

## Self-review

- Re-read the final diff against the scheduling-lineage, automatic-bound, Manual Resolution, atomicity, errors, notifications, audit, and test requirements.
- Confirmed persisted appointment lineage has precedence and fallback values are deterministic for legacy nulls.
- Confirmed candidate-specific upper bounds are academic-year closing dates, not March 31, and lower bounds use Manila tomorrow plus the original window and Laboratory ordering where applicable.
- Confirmed planning updates shared in-memory load so FCFS candidates cannot consume the same slot.
- Confirmed destructive status changes occur only after the entire candidate set has been classified as replacement or fallback.
- Confirmed all successful replacements retain pair/cycle and the five persisted scheduling-lineage values.
- Confirmed fallback events have no new appointment IDs and use `MANUAL_RESOLUTION_REQUIRED`, `AWAITING_RESCHEDULE`, and `NO_VALID_REPLACEMENT_WITHIN_CYCLE`.
- Confirmed fallback Manual Resolution cases are OPEN, source-tagged, closure-independent, and carry origin/lineage metadata.
- Confirmed closure cases retain their existing default source, queue behavior, resolution behavior, and audit action.
- Confirmed no alternate public helper remains that can apply displacement before replacement planning.
- Confirmed First Year planning/application and unrelated UI/routes were untouched.

## Concerns

- No known Task 3 source defect remains.
- The one observed Vitest worker-start timeout is documented above; both constituent groups passed cleanly when rerun in bounded batches.
- Queue UI rendering of the new nullable closure context is intentionally deferred to Task 5.
- Full integrated-suite verification remains intentionally deferred to the final ledger step.
