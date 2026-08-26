# Scheduling Integrity Hardening Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-26-scheduling-integrity-hardening-design.md`

## Global Constraints

- Work only in the isolated `codex/scheduling-integrity-hardening` worktree.
- Use strict red-green-refactor TDD for every behavior change. Record the failing and passing commands.
- Preserve existing authorization, FCFS/category/source ordering, clinic-scope, result-protection, audit, notification, closure, and First Year ownership behavior unless the spec explicitly changes it.
- Use Manila calendar dates. Laboratory must be strictly earlier than Physical Examination.
- Revalidate mutable pair, closure/reservation, and capacity state under the existing global schedule queue plus effective appointment-scope locks in the same transaction as each mutation.
- Reuse existing appointment lineage columns. Add only the Manual Resolution schema needed for non-closure displacement exhaustion.
- Retired write routes authenticate first, return HTTP 410 with stable codes, and perform no mutation. API POST requests are never redirected.
- Browser acceptance must use the in-app Browser against a real authenticated local flow and a guarded fixture whose cleanup proves zero residue.
- Do not push or merge this branch.

### Task 1: Shared pair integrity, lifecycle guards, and cancellation

**Outcome:** Pair-aware appointment mutations enforce dependency and rollback rules atomically.

- Add focused shared scheduling-integrity helpers and repository support for resolving the effective current pair. Prefer non-null pair lineage; fall back deterministically to the same student and cycle. Exclude obsolete `RESCHEDULED` and `CANCELLED` history.
- Add tests first for PE completion with completed, pending, no-show, cancelled, and missing Lab; completed-Lab rollback with completed PE; existing OVPSA and result-protection rules; Lab cancellation cascading to paired PE in `PENDING` or `NO_SHOW`; PE-only cancellation; and inconsistent completed-PE rejection.
- Apply the guards in quick-status and detailed mutation paths. Lock both effective scopes, re-read authoritative rows in the transaction, write history/audit once, and emit notifications only from committed state.
- Use stable codes `LABORATORY_NOT_COMPLETED` and `PHYSICAL_ALREADY_COMPLETED` while retaining existing protected-result and authorization codes.

### Task 2: Manual rescheduling, concurrency, capacity, and lineage

**Outcome:** A one-at-a-time manual move cannot bypass any scheduling rule or lose scheduling lineage.

- Add tests first for past/today, invalid weekday, global closure, service-specific closure, OVPSA reservation, capacity exhaustion, Lab-on/after-PE, PE-on/before-Lab, out-of-cycle, stale `expectedUpdatedAt`, simultaneous last-slot attempts, and a valid move.
- Acquire the global schedule queue and both pair scopes; then re-read the appointment, pair, academic-year closing date, blocked dates/reservations, and capacity in the transaction.
- Reject invalid destinations with stable codes `APPOINTMENT_DATE_IN_PAST`, `APPOINTMENT_DATE_BLOCKED`, `DAILY_CAPACITY_EXCEEDED`, `PAIR_ORDER_VIOLATION`, and `OUTSIDE_SCHEDULING_CYCLE`. Never move the paired appointment automatically.
- Ensure replacements copy pair/cycle plus scheduling category, accepted-at, source-row, window-start, and window-end lineage. Standard Schedule Import publication must populate those existing columns.
- Send the existing optional `expectedUpdatedAt` from the appointment UI, surface authoritative errors, and preserve historical rows, audit, and committed-date notifications.

### Task 3: Manual Resolution schema and bounded Standard displacement

**Outcome:** Priority displacement either creates valid same-cycle replacements or a durable Manual Resolution case without fabricating a date.

- Add migration `025_scheduling_integrity_hardening.sql` and migration tests. Add `case_source` with `CLINIC_CLOSURE` and `AUTOMATIC_DISPLACEMENT`, backfill closure cases, allow a null closure reference only for automatic displacement, and extend case/event reason constraints with `NO_VALID_REPLACEMENT_WITHIN_CYCLE`.
- Extend Manual Resolution repository/service DTOs with `caseSource`; closure-specific identifiers/dates become nullable. Existing closure cases and resolution behavior must remain compatible.
- Add pure replacement-bound tests: Lab/pair lower bound is the later of the original window start and next valid clinic date after Manila today; PE-only also respects Lab date plus one; upper bound is the same academic-year closing date.
- Refactor Standard priority displacement to plan and apply under the global queue and scope locks. Continue after March through the cycle close, never enter a later cycle, preserve FCFS/category/source/pair lineage, and keep the incoming priority publication atomic.
- When capacity is exhausted, set affected current appointments to `AWAITING_RESCHEDULE`, create the automatic-displacement Manual Resolution case/event with source metadata, notify staff, and send no student replacement-date notification.

### Task 4: First Year bounded displacement and Manual Resolution fallback

**Outcome:** First Year recovery uses the same future/cycle bounds without weakening OVPSA protections.

- Add tests first for historical window starts, post-March recovery, cycle-closing exhaustion, Manual Resolution fallback, pair order, persisted-lineage preference with deterministic legacy fallback, FCFS/category/source preservation, and unchanged First Year verification/service exclusivity.
- Make the First Year batch/repository expose the academic-year closing date and pass it into planning.
- Use the shared replacement bounds per displaced candidate. Remove March 31 and multi-year replacement cutoffs while preserving normal preference-window semantics.
- Apply planned replacements and Manual Resolution fallbacks atomically with incoming First Year publication. Exhausted lower-priority candidates must not block valid First Year ownership or receive fabricated dates.

### Task 5: Retired routes, lookup privacy, and UI safeguards

**Outcome:** Obsolete write/public paths are inert and the active UI explains server-enforced dependencies.

- Add route tests first, then make authenticated legacy write handlers return HTTP 410 `SCHEDULING_WORKFLOW_RETIRED` without parsing or mutation: coordinator create/validate/edit and appointment generate/publish. Preserve coordinator GET/history views and internal helpers still used by Schedule Imports; remove only dead write wrappers/components and active `BOTH` writes.
- Redirect `/student-lookup` to `/student/login`, point the homepage CTA to login, and make `/api/student-lookup` return the identical generic HTTP 410 `STUDENT_LOOKUP_RETIRED` response for missing, existing, and malformed identifiers without querying. Remove the dead lookup form and public repository function while preserving authenticated Student Portal behavior.
- Disable PE completion controls when projected Lab status is not completed and render an accessible explanation. Keep server authority, retries, confirmations, and authoritative refresh behavior.
- Update Manual Resolution queue presentation for both case sources and nullable closure context.

### Task 6: Guarded Browser acceptance and final verification

**Outcome:** Automated and real authenticated acceptance demonstrate the complete hardened flow and zero residue.

- Add a guarded scheduling-integrity fixture plus setup/status/cleanup package scripts and fixture tests. Setup must create deterministic admin/staff/student, pair, capacity, legacy-route, privacy, and displacement/manual-case scenarios without colliding with existing fixtures.
- In the in-app Browser verify blocked PE completion, Lab-then-PE completion, invalid and valid manual rescheduling, automatic-displacement Manual Resolution, retired API 410/no mutation, homepage/lookup redirects, public lookup privacy, authenticated Student Portal schedules, responsive/accessibility behavior, exact network codes, and zero console errors.
- Cleanup must prove zero residue for students, appointments/history, imports/batches, manual cases/events, audits, notifications/outbox, storage, and state files.
- Run focused tests, the complete serialized suite, TypeScript checking, lint, production build, and `git diff --check`. Request a whole-branch code review and address all Critical/Important findings before branch handoff.
