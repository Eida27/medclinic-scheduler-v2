# Clinic Closure Recovery Policy Design

**Date:** 2026-08-14  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Purpose

Revise clinic-closure handling so affected student schedules remain stable and predictable. The system must not silently move students when a closure is too close to their appointment or when the closure is an emergency. Automatic recovery is allowed only for sufficiently early planned closures and only after explicit administrator approval.

The design extends the existing unified clinic calendar, appointment-pair rules, Manual Resolution workflow, notifications, audit trail, and First Year OVPSA scheduling support. It does not introduce a separate scheduling subsystem.

## 2. Core policy

### 2.1 Schedule-stability principle

The closer a student is to an appointment, the less freedom the system has to change that appointment automatically.

A closure-affected appointment is evaluated using the Manila calendar date on which the administrator actually confirms the closure.

```text
noticeDays = affectedAppointmentDate - closurePolicyEffectiveDate
```

Business rule:

- **More than 30 calendar days** of notice: potentially eligible for administrator-approved automatic recovery.
- **30 calendar days or less**: Manual Resolution required.
- **Emergency Closure**: Manual Resolution required regardless of notice period.

The policy uses calendar dates in `Asia/Manila`, not elapsed hours or UTC day boundaries.

### 2.2 Planned closure categories

The following categories may use the notice-period rule:

- `HOLIDAY`
- `CLOSURE`
- `MAINTENANCE`
- `STAFF_UNAVAILABILITY`

`EMERGENCY_CLOSURE` never permits automatic recovery.

### 2.3 Administrator control

For planned closures with students who are otherwise eligible for automation, the administrator chooses one batch-level recovery mode:

- `AUTO_ELIGIBLE` — automatically recover all eligible appointments.
- `MANUAL_ALL` — send all otherwise eligible affected appointments to Manual Resolution.

Mandatory-manual cases remain manual regardless of this choice.

No affected appointment may remain operational on a newly blocked date.

## 3. Architecture

Use a dedicated **Closure Recovery Policy** layer between closure discovery and appointment movement.

```text
Unified Clinic Calendar
  -> Find affected appointment cycles
  -> Closure Recovery Policy
       -> AUTO_RECOVERY_ELIGIBLE
       -> MANUAL_RESOLUTION_REQUIRED + reason
  -> Closure Recovery Allocator for eligible cases
  -> Manual Resolution for non-eligible/fallback cases
  -> Notifications and audit
```

Responsibilities remain separated:

- **Unified Clinic Calendar**: declares unavailable dates and groups closure dates.
- **Closure Recovery Policy**: decides automatic versus manual handling.
- **Closure Recovery Allocator**: assigns replacement capacity without displacement.
- **Manual Resolution**: lets administrators make the smallest safe manual change.
- **Notifications/Audit**: communicate and record outcomes.

## 4. Policy decision order

For each affected appointment cycle, evaluate in this order:

1. If the closure category is `EMERGENCY_CLOSURE` -> Manual Resolution.
2. If the affected appointment is a First Year OVPSA-controlled Laboratory appointment -> Manual Resolution.
3. If the notice period is 30 calendar days or less -> Manual Resolution.
4. Apply existing safety protections:
   - manually locked appointment;
   - draft result files;
   - protected/finalized result data;
   - inconsistent or missing pair;
   - unsafe appointment state.
5. If administrator selected `MANUAL_ALL` -> Manual Resolution.
6. Otherwise -> automatic recovery eligible.
7. If automatic allocation later cannot safely complete -> fall back to Manual Resolution.

Suggested new manual reason codes:

- `EMERGENCY_CLOSURE`
- `NOTICE_PERIOD_PROTECTED`
- `OVPSA_LABORATORY_PROTECTED`
- `ADMIN_CHOSE_MANUAL_RECOVERY`

Existing reason codes remain in use, including `APPOINTMENT_MANUALLY_LOCKED`, `DRAFT_RESULT_FILES_EXIST`, `PROTECTED_RESULTS_EXIST`, `PAIR_MISSING_OR_INCONSISTENT`, `NO_REPLACEMENT_CAPACITY`, and `CONCURRENT_APPOINTMENT_CHANGE`.

When multiple reasons could apply, record the strongest factual reason rather than a weaker batch-choice reason. For example, an emergency case remains `EMERGENCY_CLOSURE` even if the administrator also selected `MANUAL_ALL`.

## 5. Minimal-change scheduling

Closure recovery must change as little of the student's existing schedule as safely possible.

### 5.1 Physical Examination-only closure

If only the Physical Examination date is affected and the existing Laboratory appointment remains valid:

- keep Laboratory unchanged;
- move only Physical Examination;
- preserve `Laboratory < Physical Examination`.

### 5.2 Laboratory closure

If an unfinished Laboratory appointment is affected:

- move the Laboratory appointment;
- preserve the existing Physical Examination only if it remains valid after the replacement Laboratory date;
- otherwise move the minimum additional appointment required to preserve pair ordering.

### 5.3 Completed appointments

- Completed Laboratory appointments are never recreated or moved.
- Completed Laboratory + pending Physical Examination: only Physical Examination may move.
- Completed pair: preserve both.
- Unsafe inverted states such as pending Laboratory + completed Physical Examination require Manual Resolution.

## 6. First Year OVPSA rules

First Year OVPSA Laboratory appointments are externally controlled and conducted through Iloilo Mission Hospital scheduling coordination.

### 6.1 OVPSA Laboratory closure

Any closure affecting a First Year OVPSA Laboratory appointment requires Manual Resolution regardless of notice period or closure category.

The Laboratory appointment becomes `AWAITING_RESCHEDULE` and the case should state clearly that OVPSA / Iloilo Mission Hospital coordination is required.

### 6.2 Related Physical Examination

The related Physical Examination is held within the same manual case until the revised OVPSA Laboratory date is known.

- If the existing Physical Examination is still safely after the new Laboratory date, keep it unchanged.
- If the new Laboratory date would invalidate the existing Physical Examination order or date, the administrator must assign a new Physical Examination date.

### 6.3 First Year Physical Examination-only closure

A First Year Physical Examination that is affected while the OVPSA Laboratory remains valid follows the normal policy:

- emergency -> Manual Resolution;
- 30 days or less -> Manual Resolution;
- more than 30 days -> potentially auto-eligible;
- replacement Physical Examination must remain after the protected Laboratory date.

## 7. Automatic recovery allocator

Automatic closure recovery is not a fresh scheduling competition.

### 7.1 Free capacity only

Closure recovery may use only genuinely available capacity.

It must never displace another student to make room for a replacement. If safe capacity cannot be found, the affected student falls back to Manual Resolution.

This rule applies regardless of whether other students are Regular, OJT, Tour, Specialized, or another category.

First Year OVPSA priority/displacement rules remain separate from closure recovery.

### 7.2 Recovery queue fairness

Affected students keep their original scheduling position.

Order the recovery queue by:

1. original affected appointment date, earliest first;
2. original appointment creation/order, oldest first;
3. student number only as a deterministic tie-breaker.

For a Laboratory closure, use the original Laboratory appointment position. For a Physical Examination-only closure, use the original Physical Examination appointment position.

Do not reapply category-priority ordering during closure recovery.

### 7.3 Atomic per-student recovery

A student-level move must be atomic.

If both Laboratory and Physical Examination must move, either both replacement operations succeed together or neither becomes operational. A partial pair must never be published.

Student-level safety failures fall back to Manual Resolution. Unexpected database/integrity failures may still roll back the entire closure transaction.

## 8. Preview and confirmation workflow

### 8.1 Preview is informational

`Review impact` evaluates policy and capacity without changing appointments.

The preview should show:

- total affected students;
- automatic-recovery eligible count;
- Manual Resolution required count;
- complete-pair or multi-appointment move estimate;
- Physical Examination-only move estimate;
- preserved/unaffected appointment count;
- expected capacity fallback count when determinable;
- manual counts grouped by reason.

Example reason groups:

- notice period protected;
- emergency closure;
- OVPSA Laboratory protected;
- manually locked/protected;
- inconsistent appointment state;
- capacity fallback.

### 8.2 Batch-level choice

The administrator chooses one mode for all otherwise eligible students:

- **Automatically reschedule eligible appointments** (`AUTO_ELIGIBLE`)
- **Send eligible appointments to Manual Resolution** (`MANUAL_ALL`)

No per-student checkbox selection is needed in the closure confirmation dialog.

For an emergency-only closure, the automatic option is disabled because all affected cases are mandatory-manual.

### 8.3 Save-time revalidation

The server recalculates the policy under the scheduling lock when the administrator confirms the save.

```text
Preview -> choose recovery mode -> Confirm -> recalculate -> apply
```

Final validation must use the actual `Asia/Manila` confirmation date, current appointment state, current capacity, current locks/protections, and current blocked dates.

If a case becomes unsafe between preview and confirmation, the closure still saves and that case falls back to Manual Resolution.

### 8.4 Mixed closure batches

A single save may contain different closure categories.

`AUTO_ELIGIBLE` applies only to appointments that are eligible under their own closure category and policy evaluation. Emergency cases in the same batch remain manual.

## 9. API and type changes

Extend the clinic calendar operation request with an explicit recovery mode rather than a Boolean.

Conceptually:

```ts
type ClinicClosureRecoveryMode = "AUTO_ELIGIBLE" | "MANUAL_ALL";
```

Keep emergency acknowledgment separate because it confirms the nature of the closure, not the recovery mode.

Extend preview/result DTOs to expose final policy counts and notification-warning counts.

Remove operational restoration counts from the new reopening workflow because reopening no longer moves students back automatically.

## 10. Data model changes

### 10.1 `clinic_closure_groups`

Add immutable policy context:

- `recovery_mode`
- `policy_effective_date`

`policy_effective_date` is the Manila calendar date used for notice calculations. Existing `created_at` remains the exact timestamp.

### 10.2 `clinic_closure_manual_cases`

Extend allowed reason codes with:

- `EMERGENCY_CLOSURE`
- `NOTICE_PERIOD_PROTECTED`
- `OVPSA_LABORATORY_PROTECTED`
- `ADMIN_CHOSE_MANUAL_RECOVERY`

Store structured policy metadata sufficient to explain the decision, including as applicable:

- policy effective date;
- original affected appointment date;
- notice days;
- closure category;
- selected recovery mode;
- affected service;
- whether the case is OVPSA-controlled.

### 10.3 Appointment reschedule events and audit

Continue using `appointment_reschedule_events` as the permanent schedule lineage.

Record policy decision metadata such as:

- `recoveryMode`
- `noticeDays`
- `policyDecision`
- `reasonCode`
- recovery queue ordering information when useful for audit.

Existing restoration-related columns may remain for schema/history compatibility, but the new operational workflow must stop generating automatic-restoration events.

## 11. Manual Resolution behavior

Manual Resolution should show both the affected appointment and relevant paired context while clearly labeling what actually requires change.

Example:

```text
Affected
Laboratory - 2026-09-08

Related / currently unaffected
Physical Examination - 2026-09-15
```

The interface should support the smallest safe administrator action:

- assign only the affected Laboratory;
- assign only the affected Physical Examination;
- assign both appointments when pair integrity requires it;
- explicitly preserve the related appointment when it remains safe.

The backend always performs final validation. Manual handling does not bypass business rules.

Validate:

- date is not blocked;
- date is an allowed scheduling day;
- capacity exists;
- Laboratory precedes Physical Examination;
- protected/completed appointments are respected;
- OVPSA protections are respected;
- no other student is displaced;
- optimistic/manual-case token is current.

## 12. Notifications

### 12.1 Automatic recovery

After a successful automatic replacement:

- create the student-portal notification;
- attempt email notification through the existing email mechanism;
- include the new appointment date(s).

### 12.2 Manual Resolution

When an affected appointment enters Manual Resolution:

- set unfinished affected appointment(s) to `AWAITING_RESCHEDULE`;
- notify the student that the closure affected the appointment and an administrator will provide a safe replacement;
- do not invent a replacement date.

After the administrator resolves the manual case, generate a second notification with the actual replacement schedule.

### 12.3 Delivery failure

Notification delivery failure, especially email failure, must not undo a valid scheduling decision.

Record the failure and expose a delivery warning in the final admin summary so clinic staff can follow up manually.

## 13. Reopening a closure date

Reopening restores **calendar availability only**.

It must not automatically:

- restore original student appointments;
- cancel current replacement appointments;
- move students back to the old date;
- resolve Manual Resolution cases;
- emit schedule-change notifications solely because a date reopened.

Existing replacement appointments remain official. Open manual cases remain open until an administrator resolves them.

If an administrator later wants to place a student on the reopened date, that is a deliberate manual scheduling decision subject to all current safety rules.

## 14. Error handling

### 14.1 Safe student-level fallback

Known student-level safety problems do not invalidate a real closure. The closure remains active and the affected case falls back to Manual Resolution.

Examples:

- no replacement capacity;
- appointment changed after preview;
- new result protection appeared;
- new manual lock appeared;
- appointment pair became inconsistent;
- OVPSA protection detected;
- notice-period policy requires manual handling.

### 14.2 Capacity races

Capacity is recalculated at confirmation time.

Process the recovery queue in approved original-order sequence. Students receive remaining free capacity until exhausted; later students fall back to Manual Resolution.

Do not displace unrelated students.

### 14.3 Hard failures

Unexpected database, referential-integrity, or transaction failures may roll back the complete operation. They must not be silently converted to business-rule manual cases.

## 15. Testing requirements

### 15.1 Notice boundary

Unit tests must verify:

| Notice | Expected result |
|---|---|
| 0 days | Manual |
| 1 day | Manual |
| 29 days | Manual |
| 30 days | Manual |
| 31 days | Auto-eligible |
| 60 days | Auto-eligible |

Tests must use Manila calendar dates.

### 15.2 Emergency closures

Every `EMERGENCY_CLOSURE` case is Manual Resolution regardless of notice period, including far-future emergency dates.

### 15.3 Minimal-change rules

Test:

- PE-only closure preserves valid Laboratory;
- Laboratory closure changes the minimum appointments required;
- completed Laboratory never moves;
- completed pair remains unchanged;
- invalid completion order goes manual;
- OVPSA Laboratory always goes manual;
- existing PE is preserved after manual OVPSA Lab replacement when still valid;
- PE requires manual replacement when revised OVPSA Lab invalidates ordering.

### 15.4 Recovery fairness

Replace student-number-priority assumptions in existing closure allocation tests.

Verify:

- earlier original affected date wins;
- same-date older original appointment wins;
- student number is only a final tie-breaker;
- Regular/OJT/Tour/Specialized categories do not reorder closure recovery.

### 15.5 Recovery mode

For `AUTO_ELIGIBLE`:

- eligible planned cases may auto-recover;
- 30-day-or-less cases remain manual;
- emergency remains manual;
- OVPSA Laboratory remains manual;
- unsafe/capacity-failed cases fall back to manual.

For `MANUAL_ALL`:

- otherwise eligible cases become manual;
- mandatory-manual cases keep their stronger factual reason code.

### 15.6 Reopening

Verify that reopening:

- makes the date available;
- does not restore old appointments;
- does not cancel replacements;
- does not move students;
- does not resolve manual cases.

### 15.7 Notification failure

Verify email failure produces an admin warning but does not roll back a valid automatic or manual scheduling decision.

## 16. Acceptance scenario

On **2026-08-14**, an administrator confirms a planned closure affecting:

- Student A — appointment 2026-09-10: 27 days -> Manual Resolution.
- Student B — appointment 2026-09-13: 30 days -> Manual Resolution.
- Student C — appointment 2026-09-14: 31 days -> auto-eligible.
- Student D — 2026-10-05 First Year OVPSA Laboratory -> Manual Resolution.
- Student E — 2026-10-06 Physical Examination only, valid Laboratory retained -> auto-eligible.
- Student F — 2026-10-07 manually locked -> Manual Resolution.

Administrator selects `AUTO_ELIGIBLE`.

Expected result:

- A, B, D, and F enter Manual Resolution with accurate reason codes.
- C and E receive automatic replacements using free capacity only.
- C and E are processed according to original appointment order.
- No other student is displaced.
- Valid unaffected paired appointments are preserved.
- Portal notifications are created and email is attempted.
- Simulated email failure appears only as an admin warning.
- Reopening the closure later does not move C or E back to their original dates.

## 17. Non-goals

This design does not introduce:

- student self-rescheduling;
- automatic student acknowledgment as a prerequisite for schedule validity;
- category reprioritization during closure recovery;
- displacement of unrelated students for closure recovery;
- automatic restoration after reopening;
- a separate incident-management or background recovery subsystem.

## 18. Design summary

The closure-recovery policy prioritizes schedule stability over aggressive automation.

Automatic recovery is allowed only when a planned closure is confirmed **more than 30 calendar days** before the affected appointment, the administrator explicitly chooses automatic recovery, and all safety rules permit it. Emergency closures, appointments with **30 days or less** of notice, First Year OVPSA Laboratory appointments, protected cases, and unsafe fallback cases are handled through Manual Resolution.

Automatic recovery makes the smallest safe change, preserves the student's original recovery queue position, uses only free capacity, never displaces another student, and never silently restores schedules when a closure date is reopened.
