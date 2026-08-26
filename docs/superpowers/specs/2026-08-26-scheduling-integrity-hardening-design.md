# Scheduling Integrity Hardening Design

**Date:** 2026-08-26  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design  
**Scope:** Scheduling invariants, appointment lifecycle safety, displacement recovery, legacy scheduling retirement, and student lookup retirement

## Objective

Harden the MedClinic scheduling system so every active scheduling and appointment-mutation path enforces the same core business invariants.

The current code already enforces many rules correctly in the automated paired scheduler, First Year/OVPSA workflow, closure recovery, and priority displacement logic. The hidden inconsistencies come from other paths that can mutate appointments without applying the same rules. This design fixes those cross-path inconsistencies without replacing the approved scheduling algorithm.

The implementation must guarantee that:

- Laboratory always precedes Physical Examination.
- Physical Examination cannot be completed before Laboratory.
- A completed Laboratory cannot be rolled back while its paired Physical Examination is completed.
- Manual rescheduling cannot bypass future-date, weekday, closure, capacity, scheduling-cycle, or pair-order rules.
- Cancelling an unfinished Laboratory also cancels its unfinished paired Physical Examination atomically.
- Automatic displacement never assigns a replacement into the past or into a later scheduling cycle.
- First Year displacement uses the same replacement bounds as other scheduling flows.
- Obsolete coordinator scheduling APIs can no longer bypass the current scheduler.
- Public unauthenticated student schedule lookup is retired in favor of Student Sign in.

This work is a scheduling-integrity hardening effort, not a redesign of FCFS, priority categories, First Year rules, emergency-closure rules, notifications, or the authenticated Student Portal.

---

## Approved Policy Decisions

The following decisions are final for this design.

### Cancellation

If an unfinished Laboratory appointment is cancelled, its unfinished paired Physical Examination is cancelled in the same transaction.

Cancelling only the Physical Examination does not cancel or modify the Laboratory appointment.

### Manual rescheduling

Appointments remain manually reschedulable one at a time. The server rejects any destination that is invalid instead of automatically moving the paired appointment.

### Automatic replacement horizon

Automatic displacement/replacement may overflow beyond March when capacity requires it, but only until the end of the same scheduling cycle. If no valid replacement exists by the cycle closing date, the case goes to Manual Resolution.

### Completed Laboratory rollback

A completed Laboratory appointment cannot be reverted to Pending or No-show while its paired Physical Examination remains completed.

### Legacy scheduling APIs

Obsolete scheduling write APIs remain routable temporarily but return HTTP `410 Gone` with a stable retirement error code directing users to the current Schedule Import workflow.

---

## Non-Goals

This design does not:

- change the approved FCFS baseline;
- change OJT/Tour priority behavior;
- reintroduce the retired Specialized category;
- change First Year/OVPSA ownership or service-exclusivity rules;
- change the approved emergency-closure policy;
- redesign notification delivery architecture;
- replace the current paired schedule generator;
- redesign the Student Portal;
- choose serverless versus persistent hosting;
- add a new scheduling algorithm;
- create a second parallel appointment lifecycle model.

---

# 1. Scheduling Integrity Architecture

## 1.1 Shared server-side authority

The system will introduce a shared scheduling-integrity layer used by every operation that can change an appointment date or lifecycle state.

The browser may disable obviously invalid actions for usability, but UI rules are never authoritative. The server must independently enforce the business rules for every mutation, including direct API calls.

The integrity layer should consist of focused domain helpers rather than one large function. Responsibilities should be separated so each unit can be understood and tested independently.

Illustrative responsibilities include:

- `resolveEffectiveAppointmentPair(...)`
- `validateAppointmentLifecycleTransition(...)`
- `validateManualAppointmentDestination(...)`
- `resolveReplacementBounds(...)`

Exact function names may follow existing project conventions.

## 1.2 Core invariants

Every active flow must preserve these invariants:

| Invariant | Required behavior |
| --- | --- |
| Laboratory dependency | Physical Examination can become `COMPLETED` only when the effective paired Laboratory appointment is `COMPLETED`. |
| Completion rollback | Laboratory cannot be reverted from `COMPLETED` while its paired Physical Examination is `COMPLETED`. |
| Pair order | Laboratory date must be strictly earlier than Physical Examination date. Same-day Lab + PE is invalid. |
| Manual rescheduling | Destination must be a future valid weekday, available for the service, inside capacity, inside the scheduling cycle, and pair-safe. |
| Capacity | Manual and automatic scheduling must honor configured daily service capacity. |
| Closures | Global closures and service-specific/OVPSA reservations remain authoritative. |
| Cancellation | Cancelling unfinished Laboratory cascades to unfinished paired Physical Examination atomically. |
| Replacement lower bound | Automatic displacement cannot create a replacement in the past. |
| Replacement upper bound | Automatic replacement cannot cross the end of the current scheduling cycle. |
| First Year | Existing OVPSA verification and service-exclusivity rules remain active. |
| Concurrency | Mutable capacity/pair state is revalidated under the appropriate locks in the same transaction as the mutation. |

## 1.3 Pair resolution

Pair-aware operations must resolve the effective current Laboratory and Physical Examination appointments rather than treating historical rows as active appointments.

Preferred resolution uses the existing non-null pair identifier when available.

The resolver must exclude obsolete historical rows such as `RESCHEDULED` or `CANCELLED` records when determining the effective current pair.

For development/legacy rows without usable pair lineage, fallback matching may use the same student and scheduling cycle, but it must be deterministic and must not select obsolete history over the current replacement.

## 1.4 Scheduling lineage

New standard appointments must persist the scheduling lineage already represented by the current schema where available, including applicable values such as:

- scheduling category;
- accepted-at timestamp;
- source row order;
- scheduling window start;
- scheduling-cycle identity;
- schedule pair identifier.

This prevents later displacement flows from reconstructing incomplete or contradictory scheduling windows.

A migration is added only if the schema genuinely lacks a required concept. Existing columns must be reused rather than duplicated.

---

# 2. Appointment Lifecycle Integrity

## 2.1 Physical Examination completion prerequisite

When a user attempts to mark a Physical Examination appointment `COMPLETED`, the server must resolve the effective paired Laboratory appointment before changing state.

Completion is permitted only when the Laboratory appointment is already `COMPLETED`.

The action must be rejected when the Laboratory is:

- `PENDING`;
- `NO_SHOW`;
- `CANCELLED`;
- missing or unresolvable;
- otherwise not completed.

A stable domain error should be returned, for example:

- code: `LABORATORY_NOT_COMPLETED`
- message: `Physical Examination cannot be completed until the student's Laboratory appointment is completed.`

The Physical Examination UI should also prevent the obvious invalid action when the displayed Laboratory status is not completed, but the server check remains authoritative.

Existing First Year/OVPSA external-laboratory verification remains active as an additional rule and must not be weakened.

## 2.2 Completed Laboratory correction

When staff attempt to revert Laboratory from `COMPLETED` back to its recorded previous operational state, the server must resolve the paired Physical Examination first.

If the paired Physical Examination is already `COMPLETED`, the Laboratory rollback is rejected.

Suggested domain error:

- code: `PHYSICAL_ALREADY_COMPLETED`
- message: `Laboratory completion cannot be reversed because the paired Physical Examination has already been completed.`

The normal quick-status action does not automatically roll back Physical Examination and does not create a Manual Resolution case.

Existing result-protection rules remain additional restrictions.

## 2.3 Cancellation behavior

Cancellation becomes pair-aware.

For an unfinished Laboratory appointment:

1. authenticate and authorize the actor;
2. begin the transaction;
3. lock the effective pair/scope;
4. re-read authoritative appointment states;
5. validate that Laboratory may be cancelled;
6. cancel Laboratory;
7. if the effective paired Physical Examination exists and is unfinished, cancel Physical Examination in the same transaction;
8. write audit records for all mutated appointments;
9. commit;
10. enqueue or create the appropriate student notification from committed state.

The system must not leave an active pair in this state:

- Laboratory = `CANCELLED`
- Physical Examination = `PENDING` or `NO_SHOW`

Cancelling Physical Examination alone leaves Laboratory unchanged.

If inconsistent legacy data contains a completed Physical Examination while Laboratory is unfinished, cancellation of that Laboratory must be rejected instead of cascading into the completed Physical Examination.

Completed appointments continue to use existing correction/result-protection rules rather than ordinary cancellation behavior.

## 2.4 Audit and notification behavior

Lifecycle mutations must preserve the existing audit model.

For cascading Laboratory cancellation, both appointment state changes must be auditable. If the existing notification infrastructure supports a combined schedule-cancellation message, prefer a single coherent notification over two contradictory independent messages.

Rejected mutations produce no appointment mutation, no success audit, and no schedule-change notification.

---

# 3. Manual Rescheduling Integrity

Manual rescheduling remains one appointment at a time. Invalid changes are rejected; the system does not silently move the paired appointment.

## 3.1 Eligibility

The appointment must be in a status that the existing workflow permits to be manually rescheduled, such as `PENDING` or `NO_SHOW`.

Existing OVPSA restrictions remain active.

## 3.2 Future-date rule

The destination date must be strictly later than the current calendar date in `Asia/Manila`.

Manual rescheduling cannot place an appointment in the past or use a historical date simply because it is otherwise available.

Suggested error code:

`APPOINTMENT_DATE_IN_PAST`

## 3.3 Weekday rule

The destination must be a valid clinic scheduling weekday under the existing weekday rules.

## 3.4 Closure and service-availability rule

The destination must not be blocked by:

- a global clinic closure;
- a relevant service-specific restriction;
- a First Year/OVPSA service-exclusive reservation;
- another existing rule that makes that service unavailable on that date.

Suggested error code:

`APPOINTMENT_DATE_BLOCKED`

## 3.5 Scheduling-cycle rule

The destination must remain inside the appointment's current scheduling cycle.

Manual rescheduling must not silently move a student into a later cycle.

Suggested error code:

`OUTSIDE_SCHEDULING_CYCLE`

## 3.6 Pair-order rule

When rescheduling Laboratory, the destination Laboratory date must remain strictly earlier than the effective paired Physical Examination date.

When rescheduling Physical Examination, the destination Physical Examination date must remain strictly later than the effective paired Laboratory date.

Same-day Laboratory and Physical Examination is invalid.

Suggested error code:

`PAIR_ORDER_VIOLATION`

## 3.7 Capacity rule

The destination service/date must not exceed the configured maximum daily capacity after applying the proposed move.

Suggested error code:

`DAILY_CAPACITY_EXCEEDED`

Capacity must be computed using authoritative current appointment state and the same semantics used by the automatic scheduler.

## 3.8 Concurrency rule

Validation that depends on mutable state must happen under the same transaction and locking strategy as the mutation.

The implementation must prevent two simultaneous manual moves from both claiming the same final available capacity slot.

The relevant appointment scope and destination service/date scope must be locked before final validation and insertion/replacement.

## 3.9 History-preserving reschedule

Successful manual rescheduling must continue using the existing replacement/history model rather than destructively editing historical appointment rows if the current system already preserves replacements that way.

After commit:

- the new effective appointment is visible;
- old appointment history remains traceable;
- pair identity and scheduling-cycle lineage remain intact;
- the actor and old/new dates remain auditable;
- the student receives the existing schedule-change notification.

Failed validation must leave all state unchanged.

---

# 4. Automatic Displacement and Replacement Bounds

## 4.1 Shared future lower bound

Every automatic displacement/replacement path must use the same future-date lower-bound rule.

For Laboratory or a complete pair:

`lowerBound = max(originalSchedulingWindowStart, next valid clinic date after Manila today)`

For Physical Examination-only replacement:

`lowerBound = max(originalSchedulingWindowStart, next valid clinic date after Manila today, laboratoryDate + 1 day)`

Normal weekday, closure, service reservation, and capacity checks still apply after the lower bound is established.

This rule prevents First Year displacement and other recovery flows from assigning historical dates simply because an old scheduling window began earlier.

## 4.2 Scheduling-cycle upper bound

Automatic replacements may overflow beyond March when capacity requires it, but only until the closing date of the same scheduling cycle.

The current multi-year search behavior must be removed for these replacement paths.

For a cycle that closes July 31, for example:

- March exhausted -> April allowed;
- April exhausted -> May/June/July allowed;
- no valid slot through July 31 -> automatic recovery stops.

The system must never silently schedule the student into a later academic cycle.

## 4.3 Manual Resolution fallback

When no valid replacement exists by the cycle closing date:

1. do not create an invalid or out-of-cycle appointment;
2. preserve the displacement event and affected student's scheduling context;
3. route or create the case in the existing Manual Resolution workflow;
4. record a stable reason such as `NO_VALID_REPLACEMENT_WITHIN_CYCLE` or the project's equivalent;
5. notify staff through the existing operational workflow;
6. do not send the student a fabricated replacement date.

The final transactional shape must prevent a misleading partial success where the original appointment is displaced but the workflow reports successful automatic recovery without a replacement.

## 4.4 Preserve displacement priority

This hardening does not change approved displacement priority or FCFS fairness.

Existing behavior remains:

- First Year protected schedules may displace eligible lower-priority appointments;
- approved priority-category scheduling may displace eligible Regular students;
- Regular displacement selection continues moving the correct later-accepted eligible Regular appointment rather than selecting arbitrarily.

Only replacement date safety and lineage consistency are changed.

---

# 5. First Year / OVPSA Displacement Consistency

## 5.1 Shared replacement rules

First Year displacement must stop reconstructing replacement behavior independently where shared rules can be used.

For every displaced lower-priority student, the recovery path must preserve:

- original accepted-at/FCFS lineage;
- scheduling category;
- source-row ordering;
- scheduling cycle;
- pair identity where available;
- future-date lower bound;
- Laboratory-before-Physical Examination ordering;
- service capacity;
- global closures;
- First Year service-exclusive reservations;
- cycle closing date.

First Year students continue owning their protected OVPSA dates according to the existing approved design. This change affects only how displaced students are safely recovered afterward.

## 5.2 Remove artificial March 31 hard stop

March 31 may continue to participate in normal Regular scheduling preference/window semantics, but it must not be reconstructed as the hard replacement deadline when the approved policy allows overflow later within the same scheduling cycle.

Displacement recovery may continue after March until the actual cycle closing date.

This removes the inconsistency where one scheduler permits overflow while First Year recovery prematurely reports capacity exhaustion.

## 5.3 Persist lineage instead of guessing

Standard schedule publication must populate the existing scheduling-lineage columns needed by later displacement logic.

First Year recovery should read persisted lineage first and use deterministic legacy fallback only when older development/test rows lack those values.

---

# 6. Retire Legacy Scheduling Entry Points

## 6.1 Retirement strategy

Obsolete scheduling write endpoints remain routable temporarily but return HTTP `410 Gone`.

The response should contain a stable error code such as:

`SCHEDULING_WORKFLOW_RETIRED`

and a message similar to:

`This scheduling workflow has been retired. Use Schedule Imports to create and publish student schedules.`

API POST requests must not be redirected to another API.

## 6.2 Known legacy surfaces to review

Implementation must review and retire obsolete write operations capable of bypassing the modern workflow, including known areas such as:

- `POST /api/coordinator-schedules`;
- legacy coordinator validation endpoints;
- legacy appointment-generation endpoints;
- legacy appointment-publication endpoints.

Each route must be reference-checked before removal/retirement so read-only historical/admin functionality that remains useful is not accidentally deleted.

## 6.3 Eliminate legacy `BOTH` write behavior

No active scheduling API may use the old `BOTH` write mode to create Laboratory and Physical Examination appointments on the same date.

If an internal display/filter type still represents both services, that does not authorize same-day appointment generation.

All new paired scheduling must flow through the approved paired scheduler where:

`Laboratory date < Physical Examination date`

is mandatory.

## 6.4 Preserve modern infrastructure

Do not delete shared schedule-batch repositories/services merely because the retired coordinator flow used them. Modern grouped imports may still depend on that infrastructure.

Only dead entry points and truly unused code should be deleted after reference analysis.

Modern active workflows remain:

- Standard Schedule Import;
- First Year/OVPSA import;
- approved displacement logic;
- hardened manual appointment rescheduling;
- lifecycle/status operations through the shared invariant layer;
- required read-only historical views.

---

# 7. Retire Public Student Schedule Lookup

## 7.1 Browser behavior

The legacy `/student-lookup` route remains only for compatibility and redirects to `/student/login`.

The homepage `Find my schedule` action must point to `/student/login`.

Students access schedules only after authenticating through the Student Portal.

## 7.2 API behavior

The unauthenticated `/api/student-lookup` data-access path must be removed or disabled so callers cannot retrieve schedule, compliance, appointment, or result information by probing student identifiers.

The retired public API must not reveal whether a student number exists.

## 7.3 Dead-code cleanup

Delete `StudentLookupForm` and any client/server helpers used only by the retired public flow after confirming there are no authenticated consumers.

Any repository function used exclusively for public unauthenticated schedule lookup should also be removed after reference analysis.

## 7.4 Authorization boundary

All remaining student schedule data requires authenticated Student Portal access.

All staff scheduling mutations continue requiring authenticated staff/admin/coordinator access plus the existing role and clinic-scope authorization.

Scheduling-domain validation does not replace authentication or authorization.

The required order remains:

1. authentication;
2. authorization/scope checks;
3. scheduling-domain validation;
4. transaction/locking;
5. mutation.

---

# 8. Data Integrity and Migration Policy

## 8.1 Migration decision

A migration is not automatically required.

Implementation must first inspect the current schema for all required lineage fields. If they already exist, the standard schedule creation path should begin populating them consistently.

Add a migration only when an approved required concept has no current representation.

Do not create duplicate columns for concepts already modeled by the database.

## 8.2 Fresh production database

The system is preparing for first deployment with a fresh production database. Therefore, this design does not require a complex production historical-data backfill solely to repair pre-existing live records.

Development and test databases may still contain older rows, so runtime pair resolution should remain deterministic when optional lineage fields are absent.

## 8.3 Existing inconsistent development rows

The implementation must not silently rewrite inconsistent historical rows during application startup or migration.

For example, if development data contains:

- Laboratory = `PENDING`
- Physical Examination = `COMPLETED`

new mutations must refuse to deepen the inconsistency. Test/development records may be corrected deliberately through reset or explicit administrative cleanup.

Fresh production data should be prevented from entering such states at all.

## 8.4 Preserve database protections

Existing uniqueness, active-appointment, pair, schedule-cycle, and result-protection constraints must not be weakened.

Where appropriate, existing database constraints should remain a second layer behind service-level validation.

---

# 9. Transaction and Locking Requirements

Validation that depends on mutable state must be repeated inside the transaction that performs the mutation.

The implementation must not rely on a pre-transaction capacity or pair-state check and then write later assuming nothing changed.

The following flows require authoritative re-read and suitable locks before final mutation:

- Physical Examination completion dependency;
- Laboratory completion rollback protection;
- Laboratory cancellation cascade;
- manual rescheduling destination capacity;
- pair-order validation during manual rescheduling;
- automatic displacement recovery;
- First Year replacement allocation.

Existing appointment-scope, advisory, schedule-queue, and service/date locking patterns should be reused where appropriate instead of inventing an unrelated concurrency subsystem.

The objective is to prevent races such as two requests both seeing one remaining capacity slot and both consuming it.

---

# 10. Error Contract

Domain failures should expose stable machine-readable codes with clear human-readable messages.

Illustrative codes include:

- `LABORATORY_NOT_COMPLETED`
- `PHYSICAL_ALREADY_COMPLETED`
- `PAIR_ORDER_VIOLATION`
- `APPOINTMENT_DATE_IN_PAST`
- `APPOINTMENT_DATE_BLOCKED`
- `DAILY_CAPACITY_EXCEEDED`
- `OUTSIDE_SCHEDULING_CYCLE`
- `NO_VALID_REPLACEMENT_WITHIN_CYCLE`
- `SCHEDULING_WORKFLOW_RETIRED`

Exact naming should follow existing project conventions where a domain-error framework already exists.

Tests should assert stable domain meaning instead of depending only on exact English message text.

Retired scheduling workflows specifically return HTTP `410 Gone`. Other validation failures should use the project's existing appropriate 4xx behavior.

---

# 11. UI Behavior

## 11.1 Physical Examination quick status

When Laboratory status is not `COMPLETED`, the Physical Examination completion control should be disabled or otherwise unavailable and explain that Laboratory completion is required.

This is an ergonomic safeguard only. The server remains authoritative in case another browser/session changes state between render and submission.

## 11.2 Manual reschedule errors

Manual reschedule forms must display meaningful server errors for:

- past date;
- invalid weekday;
- closure/service reservation;
- pair-order violation;
- capacity exhaustion;
- cycle-boundary violation;
- stale/concurrent state.

The UI must not pretend a failed mutation succeeded.

## 11.3 Authoritative refresh

Do not introduce optimistic state transitions that bypass authoritative server state. Existing refresh-based status behavior and conflict protection should continue to use refreshed server data after successful mutation.

---

# 12. Notification and Audit Semantics

Notifications are generated only from committed state.

Successful manual rescheduling and automatic replacement should include the committed new date using the existing notification model.

A Manual Resolution fallback must not invent a replacement date.

A rejected mutation sends no schedule-change notification.

Audit records must preserve:

- actor;
- affected appointment(s);
- prior and final state;
- old/new appointment date where relevant;
- displacement/cascade relationship where applicable.

Retired API calls rejected before mutation do not create ordinary appointment audit records, although low-level operational logging may be used to identify stale callers during rollout.

---

# 13. Expected Implementation Areas

The exact file list may change after implementation-level reference analysis, but work is expected around:

- `src/server/services/appointments.service.ts`
- appointment repositories and related repository tests
- shared scheduling-domain helpers/services
- `src/server/repositories/schedule-imports.repository.ts` or its current scheduling publication service
- First Year/OVPSA displacement services
- appointment PATCH/reschedule API routes
- Laboratory and Physical Examination quick-status UI/components
- manual rescheduling UI/error handling
- `src/app/page.tsx`
- `/student-lookup` compatibility page/route
- `/api/student-lookup`
- `StudentLookupForm.tsx`
- obsolete coordinator scheduling routes
- obsolete legacy generation/publication routes
- relevant route/service/component/integration tests

Implementation must perform reference analysis before deleting shared code.

---

# 14. Testing Requirements

This change requires cross-layer regression coverage because the original hidden bugs were caused by correct rules being enforced in some paths but bypassed in others.

## 14.1 Lifecycle tests

Verify that:

1. Physical Examination completion succeeds when paired Laboratory is completed.
2. Physical Examination completion is rejected when Laboratory is Pending.
3. Physical Examination completion is rejected when Laboratory is No-show.
4. Physical Examination completion is rejected when Laboratory is Cancelled.
5. Physical Examination completion is rejected when no effective Laboratory can be resolved.
6. Existing OVPSA verification remains enforced.
7. Completed Laboratory rollback is rejected when paired Physical Examination is completed.
8. Existing result-protection rules still block protected corrections.
9. Cancelling unfinished Laboratory atomically cancels unfinished paired Physical Examination.
10. Cancelling Physical Examination alone leaves Laboratory unchanged.
11. Cascading cancellation rejects inconsistent state where Physical Examination is already completed.

## 14.2 Manual rescheduling tests

Verify rejection of:

1. past dates;
2. today when the approved rule requires strictly future dates;
3. weekends/invalid clinic weekdays;
4. global closure dates;
5. service-specific blocked dates;
6. OVPSA service-exclusive dates for conflicting services;
7. over-capacity destination dates;
8. Laboratory on or after paired Physical Examination;
9. Physical Examination on or before paired Laboratory;
10. destination outside the scheduling cycle.

Verify that a valid reschedule succeeds and preserves audit/history/pair lineage.

## 14.3 Concurrency tests

Add integration/repository coverage demonstrating that simultaneous valid-looking requests cannot both consume the same last capacity slot.

Where practical, verify locking for manual reschedule and automatic replacement independently.

## 14.4 Automatic scheduling regression tests

Verify that:

1. the existing paired generator still schedules Laboratory before Physical Examination;
2. existing FCFS behavior remains unchanged;
3. existing priority displacement ordering remains unchanged;
4. closures and service reservations remain respected.

## 14.5 Displacement/replacement tests

Verify that:

1. a displaced student with an old window start is never assigned to a past date;
2. replacement may overflow beyond March within the same cycle;
3. replacement stops at the cycle closing date;
4. exhausted same-cycle capacity routes to Manual Resolution;
5. replacement Physical Examination is always later than Laboratory;
6. no automatic replacement crosses into a later scheduling cycle;
7. persisted lineage is used for later displacement decisions.

## 14.6 First Year tests

Verify that:

1. First Year service-exclusive dates remain protected;
2. First Year displacement preserves displaced-student FCFS/category/source-row lineage;
3. First Year displacement never assigns historical replacement dates;
4. First Year recovery can continue after March until cycle close;
5. no valid same-cycle replacement routes to Manual Resolution;
6. existing First Year completion verification remains unchanged.

## 14.7 Legacy retirement tests

Verify that:

1. obsolete coordinator scheduling writes return `410 Gone`;
2. response contains the stable retirement code;
3. retired routes perform no database mutation;
4. no active route can use legacy `BOTH` generation to create same-day Laboratory + Physical Examination;
5. Standard Schedule Import remains operational;
6. First Year import remains operational.

## 14.8 Student lookup/privacy tests

Verify that:

1. `/student-lookup` redirects to `/student/login`;
2. homepage schedule CTA points to Student Sign in;
3. unauthenticated public lookup no longer returns student schedule/compliance data;
4. retired public lookup does not reveal whether a student number exists;
5. authenticated Student Portal still displays the student's current schedule normally.

## 14.9 Broader regression verification

Before implementation is considered complete, run the relevant full suite and verify that the hardening does not break:

- emergency-closure behavior;
- Manual Resolution workflows;
- First Year ownership rules;
- result upload/result protection;
- clinic-scope authorization;
- schedule notifications;
- authenticated Student Portal;
- appointment quick-status conflict handling;
- TypeScript strictness;
- production build.

---

# 15. Implementation Order

The safest implementation order is:

1. Add shared pair/date/lifecycle invariant helpers and tests.
2. Harden Physical Examination completion and Laboratory correction.
3. Implement dependency-aware cancellation.
4. Harden manual rescheduling and destination-capacity locking.
5. Persist standard scheduling lineage consistently.
6. Replace automatic recovery bounds with the shared future lower bound and cycle closing date.
7. Update First Year displacement to use the same replacement rules.
8. Retire legacy coordinator/generation/publication write APIs with `410 Gone`.
9. Remove the unauthenticated student lookup and redirect its browser route.
10. Update UI safeguards and domain-error presentation.
11. Run targeted tests, full relevant tests, type checking, linting, and production build verification.

This ordering establishes the shared invariant foundation before higher-level workflows depend on it.

---

# 16. Acceptance Criteria

Implementation is complete only when all of the following are true:

- No active workflow can mark Physical Examination completed while its effective Laboratory appointment is incomplete.
- A completed Laboratory cannot be rolled back while its paired Physical Examination is completed.
- Cancelling an unfinished Laboratory atomically cancels its unfinished paired Physical Examination.
- Cancelling Physical Examination alone does not cancel Laboratory.
- Manual rescheduling cannot create past, weekend, blocked, over-capacity, out-of-cycle, or pair-order-invalid appointments.
- Manual rescheduling does not silently move the paired appointment.
- All automatically displaced appointments are future appointments.
- Automatic displacement may overflow beyond March but cannot leave the same scheduling cycle.
- Capacity exhaustion by the cycle closing date routes to Manual Resolution.
- Standard generated appointments persist sufficient scheduling lineage for later displacement.
- First Year displacement uses the same future/cycle bounds while preserving all approved First Year protections.
- No active API can use retired legacy `BOTH` scheduling to create same-day Laboratory and Physical Examination appointments.
- Retired scheduling write APIs return HTTP `410 Gone` and perform no mutation.
- `/student-lookup` redirects to Student Sign in.
- The unauthenticated public lookup no longer exposes student schedule, compliance, appointment, or result information.
- Existing FCFS, priority, closure, result-protection, authorization, audit, and notification behavior remains intact unless explicitly changed by this design.
- Relevant automated tests, TypeScript checks, linting, and production build verification pass before implementation is declared complete.

---

# 17. Handoff Notes

This document is the approved architectural design. It intentionally describes business invariants and implementation boundaries without prescribing unnecessary internal class/function names.

Before writing application code, the implementation plan should map these requirements to the current repository files and tests, preserve existing conventions, and use test-driven changes for each bug class.

No application-code change is part of this design-spec commit.
