# Task 4 Report: First Year Bounded Displacement and Manual Resolution Fallback

## Status

Complete.

Base commit: `edfbc2e638128e3bfde5879598e0133012081d98`.

Implementation commit:

- `2c23f23` — `feat: bound First Year displacement recovery`

## Outcome

First Year priority publication now uses the shared `resolveAutomaticReplacementBounds` policy per displaced candidate. Persisted scheduling windows that began before Manila today cannot produce historical replacements; pair recovery may continue beyond March through the authoritative academic-year `closing_date`; and Physical Examination-only recovery also starts after the current Laboratory date.

The authoritative batch and virtual Schedule Import preparation paths now carry the configured cycle closing date. Publication re-reads and locks that academic-year row during authoritative preparation, and the Schedule Import fingerprint includes the closing date plus complete replacement/fallback classification and lineage.

Every eligible candidate is classified before any status mutation as either a valid automatic replacement or an explicit Manual Resolution fallback. Same-cycle exhaustion no longer emits `OVPSA_REPLACEMENT_CAPACITY_EXHAUSTED`, no longer marks a First Year service date as replacement-blocked, and no longer makes an otherwise valid First Year publication unpublishable. Protected, completed, manually locked, result-bearing, inconsistent-pair, and active-OVPSA conflicts remain blockers.

Successful candidates retain pair, cycle, category, accepted-at, source-row, window, preferred-month/import, and history lineage. Exhausted pair candidates move both current appointments to `AWAITING_RESCHEDULE`; exhausted Physical Examination-only candidates preserve Laboratory and move only Physical Examination. Each fallback creates an OPEN `AUTOMATIC_DISPLACEMENT` case, an `AWAITING_RESCHEDULE` event with `NO_VALID_REPLACEMENT_WITHIN_CYCLE`, source-aware audit metadata, and an awaiting-resolution student notification with no fabricated replacement date. All First Year reservations, incoming appointments, replacements, fallback cases/events/audits/notifications, and status history remain inside the existing publication transaction.

## Changed files and interfaces

- `src/server/ovpsa/ovpsa-first-year.repository.ts`
  - Adds required `StoredOvpsaBatch.closingDate`.
  - Loads `academic_years.closing_date`, returns stable `OVPSA_SCHEDULING_CYCLE_NOT_CONFIGURED` if unavailable, and locks the authoritative cycle row during publication preparation.
- `src/server/ovpsa/ovpsa-first-year-displacement.ts`
  - Prefers persisted appointment lineage and uses deterministic import/appointment fallbacks for legacy nulls.
  - Resolves shared future/same-cycle bounds per pair or Physical Examination-only candidate.
  - Preserves FCFS/category/accepted-at/source-row ordering, closures, reservations, capacity, service exclusivity, external Laboratory capacity exclusion, and strict pair order.
  - Returns `plannedFallbacks` instead of capacity blockers/replacement-blocked service dates.
  - Applies replacements and Manual Resolution fallbacks atomically with correct status, case, event, audit, and notification semantics.
- `src/server/ovpsa/ovpsa-first-year.service.ts`
  - Uses the authoritative closing date as the First Year cycle boundary.
  - Passes authoritative replacement and fallback plans into initial and replacement-revision publication.
- `src/server/services/first-year-schedule-import.service.ts`
  - Carries configured closing dates into virtual batches and locks them during authoritative preparation.
  - Includes closing date, complete replacement lineage, and fallback lineage in the stale-plan fingerprint.
  - Applies both planned replacements and planned fallbacks inside the existing import publication transaction.
- `src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts`
  - Adds future lower-bound, post-March, cycle-close fallback, pair/Physical Examination-only order, persisted/legacy lineage, category ordering, atomic case/event/audit/notification, and configuration regressions while retaining existing protected/service-exclusivity behavior.

No migration was required because Task 3 already generalized the Manual Resolution schema and event reason contracts.

## TDD evidence

Focused command:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

The first run had two test-only defects in addition to intended product failures: a string matcher used the numeric-only `toBeGreaterThan`, and a fixture attempted to delete an academic year protected by the batch foreign key. After correcting only those test defects, the intended RED result was `3` failed and `12` passed:

- a historical persisted window produced a Laboratory replacement on or before Manila today;
- post-March pair recovery returned `canPublish=false` with no replacement;
- cycle-close exhaustion returned `canPublish=false` rather than a Manual Resolution fallback.

GREEN result after the smallest coherent implementation: `1` file passed, `15/15` tests passed.

The same file also proves:

- pair replacements preserve strict Laboratory-before-Physical Examination order;
- Physical Examination-only replacement starts after Laboratory plus one day and preserves completed Laboratory;
- persisted category/accepted-at/source-row/window/pair lineage overrides legacy import values and survives replacement;
- legacy null appointment lineage falls back deterministically to import lineage;
- OJT/Tour category ordering precedes Regular while FCFS/source ordering remains delegated to the unchanged paired generator;
- exhausted pair rows both become `AWAITING_RESCHEDULE`, with no replacement rows and with incoming First Year ownership committed atomically;
- the automatic case/event/audit/student notification use the stable no-valid-replacement reason and contain no fabricated date;
- manually locked/protected conflicts remain blockers and missing academic-year creation retains a stable configuration error.

## Focused regression verification

Primary focused batch:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/ovpsa/ovpsa-first-year-planner.test.ts src/server/ovpsa/external-laboratory-verification.integration.test.ts src/server/services/first-year-schedule-import.integration.test.ts src/server/scheduling/automatic-replacement-bounds.test.ts src/server/services/priority-displacement.integration.test.ts src/server/db/scheduling-integrity-hardening-migration.integration.test.ts src/server/services/clinic-calendar.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `8` files passed, `59/59` tests passed, exit code `0`.

Notification regression:

```text
npm.cmd test -- src/server/schedule/schedule-notifications.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `1` file passed, `12/12` tests passed, exit code `0`.

Post-lock authoritative preparation rerun:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/services/first-year-schedule-import.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
```

Result: `2` files passed, `18/18` tests passed, exit code `0`.

Static verification:

```text
npx.cmd tsc --noEmit
npx.cmd eslint src/server/ovpsa/ovpsa-first-year-displacement.ts src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/ovpsa/ovpsa-first-year.repository.ts src/server/ovpsa/ovpsa-first-year.service.ts src/server/services/first-year-schedule-import.service.ts
git diff --check
```

Results: TypeScript exit `0`; five-file scoped ESLint exit `0`; diff-check exit `0` with only working-copy LF-to-CRLF notices.

Per the task ledger ruling, the complete serialized suite remains reserved for the final integrated branch gate.

## Self-review

- Confirmed `resolveAutomaticReplacementBounds` is the sole First Year absolute-bound calculation and candidate `schedulingWindowEnd` is preserved as lineage/preference rather than used as the hard stop.
- Confirmed the configured closing date is loaded for persisted and virtual batches, re-read under an academic-year row lock, and cannot be replaced by March 31 or a later-cycle search.
- Confirmed every candidate is planned before either `RESCHEDULED` or `AWAITING_RESCHEDULE` writes begin.
- Confirmed shared in-memory load prevents later FCFS candidates from reusing successful replacement capacity.
- Confirmed fallback candidates do not populate blockers or `replacementBlockedServiceDates`, so valid First Year ownership remains publishable.
- Confirmed fallback rows receive no replacement appointment/date and no successful displacement notification.
- Confirmed pair fallbacks affect both rows while Physical Examination-only behavior preserves Laboratory.
- Confirmed current appointment lineage has precedence, legacy fallbacks are deterministic, and successful replacements retain the source batch/import link that owns preferred-month semantics.
- Confirmed protected/completed/manual/result-bearing conflicts, verified external Laboratory ownership, First Year service exclusivity, closures, reservations, capacity, and Standard displacement behavior remain covered by focused regressions.
- Confirmed no Task 5 retired-route, lookup, or UI behavior was changed.

## Residual risks

- The full serialized suite and production build are intentionally deferred to Task 6/final integrated verification by the approved ledger ruling.
- The schema foreign key makes a missing academic-year row for an already stored batch structurally unreachable in a healthy database; the stable runtime guard remains defensive for damaged or partially migrated environments.

