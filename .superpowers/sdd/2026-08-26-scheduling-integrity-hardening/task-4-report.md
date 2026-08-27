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

## Review fix round 1

Implementation commit: `82c9094 fix: harden First Year fallback recovery`

Addressed all three Important findings:

- First Year replacement planning now applies the established category, accepted-at, source-row, student-number, and pair-id ordering once across both pair and Physical Examination-only candidates. Each candidate consumes the same in-memory Laboratory/Physical Examination loads, while pair candidates still use the shared strict Laboratory-before-Physical generator.
- Automatic-displacement Manual Resolution queue and assignment protection checks now consider only the affected/requested moving rows. A completed/result-protected preserved Laboratory no longer blocks a Physical Examination-only assignment, while attempts to move protected rows and closure-origin cases retain their existing blockers and pair-order validation.
- Reservation release now recognizes zero-new-ID Manual Resolution fallback events. If the affected originals remain published `AWAITING_RESCHEDULE`, unprotected, unblocked, and within available capacity, it restores only those rows to `PENDING`, resolves the linked case with explicit `restorationAction: RESTORE_ORIGINAL` and restored appointment IDs, records event/audit/status-log state, and sends the existing restoration notification. Changed/protected rows remain awaiting with the case open and receive the appropriate skip decision. No replacement IDs or dates are invented.

Changed files:

- `src/server/ovpsa/ovpsa-first-year-displacement.ts`
- `src/server/ovpsa/ovpsa-first-year-lifecycle.ts`
- `src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts`
- `src/server/services/clinic-calendar.service.ts`
- `src/server/services/clinic-calendar.integration.test.ts`

### Review-fix TDD evidence

The first direct `npx.cmd vitest` attempt did not reach test execution because it bypassed the repository's environment-loading test script. All behavior evidence below uses `npm.cmd test -- ...`.

After correcting two test-only fixture defects (capacity safe/max consistency and required result/student fixture fields), the intended RED runs were:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot -t "allocates the last Physical Examination slot by global priority across pair and PE-only candidates"
```

Result: `1` failed, `16` skipped. The later Regular pair received the sole `2097-03-21` Physical Examination slot instead of the earlier OJT Physical Examination-only candidate.

```text
npm.cmd test -- src/server/services/clinic-calendar.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot -t "assigns only the awaiting PE when its preserved completed Laboratory has protected results"
```

Result: `1` failed, `23` skipped. The queue returned `PROTECTED_RESULTS_EXIST` from the preserved completed Laboratory.

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot -t "restores a pair fallback and resolves its Manual Resolution case when cancellation releases the reservation"
```

Result: `1` failed, `16` skipped. The event was `SKIPPED_APPOINTMENT_CHANGED`, neither original was restored, the case stayed open, and no restoration notification was emitted.

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot -t "restores only the awaiting PE fallback|restores only the PE fallback when a Laboratory revision|keeps a fallback case open"
```

Result: `3` failed, `17` skipped. Cancellation and revision both stranded the awaiting PE with `SKIPPED_APPOINTMENT_CHANGED`, and a newly protected PE also received the generic changed decision instead of `SKIPPED_PROTECTED`.

Focused GREEN commands:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot -t "allocates the last Physical Examination slot by global priority across pair and PE-only candidates|restores a pair fallback|restores only the awaiting PE fallback|restores only the PE fallback when a Laboratory revision|keeps a fallback case open"
```

Result: `5/5` passed, `15` skipped.

```text
npm.cmd test -- src/server/services/clinic-calendar.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot -t "assigns only the awaiting PE when its preserved completed Laboratory has protected results"
```

Result: `1/1` passed, `23` skipped.

The complete two-file behavior run passed `44/44` tests. A final focused rerun of the strengthened pair-restoration audit/status-log assertion passed `1/1`.

### Review-fix regression verification

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/services/clinic-calendar.integration.test.ts src/server/services/appointments-manual-rescheduling.integration.test.ts src/server/services/first-year-schedule-import.integration.test.ts src/server/services/priority-displacement.integration.test.ts src/server/ovpsa/external-laboratory-verification.integration.test.ts src/server/scheduling/automatic-replacement-bounds.test.ts src/server/ovpsa/ovpsa-first-year-planner.test.ts src/server/schedule/schedule-notifications.test.ts src/server/db/scheduling-integrity-hardening-migration.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot
```

Result: `10` files passed, `92/92` tests passed, exit code `0`.

```text
npx.cmd tsc --noEmit
npx.cmd eslint src/server/ovpsa/ovpsa-first-year-displacement.ts src/server/ovpsa/ovpsa-first-year-lifecycle.ts src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/services/clinic-calendar.service.ts src/server/services/clinic-calendar.integration.test.ts
git diff --check
```

Results: TypeScript exit `0`; five-file scoped ESLint exit `0`; diff-check exit `0` with only working-copy LF-to-CRLF notices.

### Review-fix self-review and residual risks

- Confirmed a successful earlier Physical Examination-only candidate consumes shared Physical capacity before a later pair is attempted; the later pair either receives a complete feasible Lab-before-PE assignment or one Manual Resolution fallback, never a partial allocation.
- Confirmed protected preserved Laboratory data still participates in pair-order comparison but is neither protection-checked nor rewritten when only Physical Examination moves.
- Confirmed closure-origin cases still include all related rows in their queue blocker and attempts to replace a protected row still fail.
- Confirmed fallback restoration locks only affected effective appointment scopes, requires the case to remain open and every affected original to remain published `AWAITING_RESCHEDULE`, checks active replacements, result/manual protection, current blocked dates/reservations, and live capacity before any state write.
- Confirmed pair restoration changes both affected originals, Physical Examination-only restoration changes only Physical Examination, and skipped restoration leaves appointments and the linked case untouched.
- Confirmed cancellation and replacement-revision reservation releases both use the same transaction-scoped restoration path; successful case/event/appointment/log/audit/notification writes are atomic with the release.
- The complete repository-wide serialized suite remains reserved for the Task 6 final integrated branch gate under the approved ledger ruling.

## Review fix round 2

Implementation commit: `9a3824d fix: record truthful fallback restoration action`

The successful fallback restoration path now persists the system-owned canonical action `RESTORE_ORIGINAL` instead of the contradictory administrator action `KEEP_CURRENT_REPLACEMENT`.

- Migration 025 replaces the named `clinic_closure_manual_cases_resolution_action_check` with a stable three-value response-state contract: `ASSIGN_REPLACEMENT`, `KEEP_CURRENT_REPLACEMENT`, and `RESTORE_ORIGINAL`.
- Existing OPEN/RESOLVED coherence remains enforced: `RESTORE_ORIGINAL` is valid only as part of a complete resolved-case state.
- The shared Manual Resolution response DTO includes `RESTORE_ORIGINAL`; the administrator request union and resolution request schema remain limited to `ASSIGN_REPLACEMENT` and `KEEP_CURRENT_REPLACEMENT`.
- Pair and Physical Examination-only reservation-release restoration persist `resolution_action='RESTORE_ORIGINAL'` while continuing to record truthful restoration details without replacement IDs or dates.
- The queue safely renders “Restore original” in resolved history while existing “Assign replacement” and “Keep current replacement” history labels remain unchanged. No restore action control is exposed.

Changed files:

- `database/migrations/025_scheduling_integrity_hardening.sql`
- `src/server/db/scheduling-integrity-hardening-migration.integration.test.ts`
- `src/server/ovpsa/ovpsa-first-year-lifecycle.ts`
- `src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts`
- `src/types/clinic-calendar.ts`
- `src/components/settings/ManualResolutionQueue.test.tsx`

### Review-fix round 2 TDD evidence

Migration RED:

```text
npm.cmd test -- src/server/db/scheduling-integrity-hardening-migration.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot
```

Result: `1` failed. PostgreSQL rejected `RESTORE_ORIGINAL` with `23514` from `clinic_closure_manual_cases_resolution_action_check`.

Lifecycle RED:

```text
npm.cmd test -- src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot -t "restores a pair fallback|restores only the awaiting PE fallback"
```

Result: `2` failed, `18` skipped. Both pair and Physical Examination-only cases stored `KEEP_CURRENT_REPLACEMENT` instead of `RESTORE_ORIGINAL`.

Typed queue-contract RED:

```text
npx.cmd tsc --noEmit
```

Result: exit `2`, `TS2322`: `RESTORE_ORIGINAL` was not assignable to `ClinicManualCaseDto["resolutionAction"]`.

The queue runtime characterization already passed `1/1` before production edits because the existing safe label formatter rendered `RESTORE_ORIGINAL` as “Restore original”; this proved no new request action or rendering branch was necessary.

Focused GREEN results:

- Migration command above: `1/1` passed.
- Lifecycle command above: `2/2` passed, `18` skipped.
- Queue characterization: `1/1` passed, `7` skipped.
- `npx.cmd tsc --noEmit`: exit `0`.

### Review-fix round 2 regression verification

```text
npm.cmd test -- src/server/db/scheduling-integrity-hardening-migration.integration.test.ts src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/server/services/clinic-calendar.integration.test.ts src/components/settings/ManualResolutionQueue.test.tsx --run --maxWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=30000 --reporter=dot
```

Result: `4` files passed, `53/53` tests passed, exit code `0`.

```text
npx.cmd tsc --noEmit
npx.cmd eslint src/server/db/scheduling-integrity-hardening-migration.integration.test.ts src/server/ovpsa/ovpsa-first-year-lifecycle.ts src/server/ovpsa/ovpsa-first-year-publication.integration.test.ts src/types/clinic-calendar.ts src/components/settings/ManualResolutionQueue.test.tsx
git diff --check
```

Results: TypeScript exit `0`; five-file scoped ESLint exit `0`; diff-check exit `0` with only working-copy LF-to-CRLF notices.

### Review-fix round 2 self-review and residual risk

- Confirmed `RESTORE_ORIGINAL` is added only to persisted/response state. Neither the public Manual Resolution request type nor the server request discriminator accepts it.
- Confirmed the named migration constraint remains idempotent and the existing resolution-completeness constraint still rejects an action on an OPEN case.
- Confirmed both fallback shapes store the same canonical action and continue to leave new appointment IDs/dates null.
- Confirmed existing closure `ASSIGN_REPLACEMENT` and `KEEP_CURRENT_REPLACEMENT` behavior remains covered by the full clinic-calendar and queue regressions.
- The complete repository-wide serialized suite remains reserved for the Task 6 final integrated branch gate under the approved ledger ruling.
