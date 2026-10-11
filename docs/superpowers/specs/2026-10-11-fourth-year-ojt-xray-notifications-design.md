# Fourth-Year OJT External X-ray Schedule Notification Design

**Date:** 2026-10-11  
**Status:** Proposed implementation specification; this commit contains documentation only.  
**Repository:** https://github.com/Eida27/medclinic-scheduler-v2  
**Reviewed baseline:** `main` at `957310bb14733401a1a5ff0e492d2c15dec75ebd`.  
**Implementation plan:** [Implementation plan](../plans/2026-10-11-fourth-year-ojt-xray-notifications.md).  
**Deployment context:** Continue the project's fresh first-deployment planning context. This feature needs no migration or historical notification backfill.

## 1. Outcome and interpretation

Fourth-year OJT students must see their Iloilo Mission Hospital X-ray date in the existing student-portal schedule notifications. Calculate that date from their authoritative KABALAKA Clinic CBC, Urine, and Stool appointment:

**X-ray date = KABALAKA Laboratory appointment date minus 7 calendar days.**

The request's phrase “7 days earlier” could describe either the appointment date or reminder delivery. This specification uses the **appointment-date interpretation**: publish the notice immediately with the schedule, showing an X-ray date seven days before KABALAKA. The clarification prompt received no selection, so this is an explicit planning assumption, not a recorded user confirmation. It can be revised if the user intends a timed reminder instead.

| KABALAKA appointment | X-ray date at Iloilo Mission Hospital |
| --- | --- |
| 2026-08-20 | 2026-08-13 |
| 2026-09-03 | 2026-08-27 |
| 2027-01-04 | 2026-12-28 |
| 2028-03-01 | 2028-02-23 |

The date is a MedClinic instruction for an external service. It does not assert that a hospital slot has been booked or that the X-ray has been performed.

## 2. Scope and approach

Extend the shared authoritative schedule-notification composition. Add one external X-ray schedule detail to eligible students' existing publication, current-state and schedule-change notices. Keep the existing notification types, titles, event keys, mark-read behavior and email eligibility.

Considered alternatives:

| Approach | Trade-off | Decision |
| --- | --- | --- |
| Include X-ray in existing schedule notices | Reuses publication, replacement and catch-up flows; one notice carries the related dates | Selected |
| Create a separate X-ray notification for every schedule event | Extra notifications and deduplication rules; students must compare two notices | Unnecessary for this request |
| Create an XRAY appointment service or timed reminder worker | Requires separate scheduling, capacity or delivery contracts | Outside this request |

This design changes notification content and its server-derived scheduling metadata. It adds no hospital booking integration, third appointment row, separate appointment status, timed reminder job, clinic capacity reservation, student self-rescheduling, or database schema.

## 3. Current repository findings

| File or contract | Verified behavior and relevance |
| --- | --- |
| `src/server/laboratory/laboratory-requirements.ts` | X-ray applies to first years and fourth-year OJT; fourth-year Regular/Tour are excluded |
| `src/server/laboratory/laboratory-completion-policy.ts` | Fourth-year OJT manually verifies CBC/Urine/Stool; successful PE issuance confirms the hospital X-ray |
| `src/server/laboratory/laboratory-checklist.repository.ts` | Checklist year/category are immutable; replacement Laboratory appointments retain the same checklist |
| `src/server/repositories/schedule-state.repository.ts` | Loads authoritative Laboratory/PE state using the caller's transaction; currently lacks saved cohort context |
| `src/server/schedule/schedule-state-sql.ts` | Excludes draft/rescheduled/cancelled rows; an appointment awaiting resolution has no authoritative date |
| `src/server/schedule/schedule-notifications.ts` | Shared builders create portal text, email text, metadata, fingerprints and deterministic event keys |
| `src/server/repositories/schedule-imports.repository.ts` | Links published Laboratory checklists before queuing initial schedule notices |
| `src/server/schedule/schedule-notification-hooks.ts` | Reloads authoritative state for scheduling events |
| `src/server/services/student-verification-catch-up.service.ts` | Builds one current-state catch-up using the same state loader and composer |
| `src/server/services/student-notifications.service.ts` | Uses savepoints for portal/email enqueue failures; preserves existing warning/audit behavior |
| `src/components/student/NotificationList.tsx` | Renders stored title/message; the extra text needs no new page or UI contract |
| `docs/current-policies.md` | Unverified active students may read notices; email verification gates Laboratory uploads/editing |

Use these current implementations and the current policy index. The October 8 design document's pending status is historical; its PE-linked completion behavior is present in the reviewed code.

## 4. Global constraints

- Eligibility is fourth-year OJT from the linked Laboratory checklist's immutable year/category, never the student's mutable profile.
- Anchor the calculation to the authoritative KABALAKA Laboratory appointment, never the Physical Examination or affected old date.
- Subtract exactly 7 calendar days from an ISO date representing an Asia/Manila service date.
- Keep portal notification access independent of email verification.
- Preserve verified-address email eligibility, existing enqueue isolation, retry and deduplication.
- Preserve the October 8 PE-linked external completion policy and all appointment/result protections.
- Add no database migration, dependency upgrade, new appointment service, capacity accounting or timed delivery worker.
- Preserve existing notification type/title/event-key families and noneligible schedule fingerprints.

## 5. Eligibility and immutable context

An external X-ray detail is eligible only when all of the following are true:

1. The selected authoritative row is a published `LABORATORY` appointment in clinic code `KABALAKA_CLINIC`.
2. Its linked checklist belongs to the same student and academic cycle and agrees with the appointment's saved scheduling category.
3. The checklist has `year_level_snapshot = 4` and `scheduling_category_snapshot = 'OJT'`.
4. The appointment is not part of First-Year/OVPSA provenance.

Join `laboratory_checklist_appointments` to `laboratory_checklists` for the selected Laboratory row in the existing state query. Carry the clinic code, cycle and OVPSA indicators through the ranked query. Use LEFT JOINs so missing contextual data does not remove general schedule information. Validate matching ownership/category in the join.

First-Year/OVPSA, fourth-year Regular/Tour, other years, PE-only records, and missing/mismatched checklist context produce no OJT X-ray detail. Do not guess eligibility from a clinic name, student profile, request field, newest unrelated checklist or the presence of an X-ray checkbox. Do not query checklist item verification or medical findings for notification composition.

The state loader remains read-only and keeps its current appointment-selection policy. It must not create/link a checklist or change clinical state. Existing publication/replacement writes establish the checklist before the notice hook runs.

## 6. Date contract and interfaces

Create `src/server/schedule/ojt-external-xray.ts` with a pure resolver and these interfaces:

```ts
type OjtExternalXrayContext = {
  laboratoryAppointmentId: string;
  laboratoryDate: string | null;
  status: AppointmentStatus;
  clinicCode: string;
  yearLevel: number | null;
  schedulingCategory: string | null;
  hasOvpsaProvenance: boolean;
};

type OjtExternalXraySchedule = {
  anchorLaboratoryAppointmentId: string;
  laboratoryDate: string | null;
  xrayDate: string | null;
  provider: "Iloilo Mission Hospital";
  offsetCalendarDays: 7;
};

function deriveOjtExternalXraySchedule(
  context: OjtExternalXrayContext,
): OjtExternalXraySchedule | null;
```

`AppointmentStatus` is the existing exported type in `schedule-notifications.ts`; any reference to it from the helper is type-only. Export the new context/schedule types.

For eligible `PENDING`, `COMPLETED` and `NO_SHOW` records with a valid real ISO calendar date, return the calculated date. “Schedule” describes the planned service date and does not assert clinical completion. Reject JavaScript's normalization of impossible dates such as `2026-02-30`.

For an eligible `AWAITING_RESCHEDULE` record, return the detail with both dates null regardless of its stored original date. A missing/invalid date in an otherwise eligible record also produces both dates null. Draft, cancelled and replaced source rows produce no detail.

Use UTC calendar components for date-only subtraction; do not subtract from a browser-local timestamp. Month, year and leap-year transitions must work. Apply no weekday, holiday, preparation-boundary or academic-cycle clamping to this external instruction. The scheduler continues to enforce its existing rules on internal appointments.

If the calculated date is already past, retain the exact calculated date with the fixed contact instruction below; never silently substitute today or move an internal appointment. This avoids clock-dependent metadata/fingerprints and covers late manual replacements. A calculation crossing the academic-cycle start remains an external instruction, not an internal reservation outside the cycle.

Extend `AuthoritativeScheduleState` with optional `externalXraySchedule?: OjtExternalXraySchedule`. The loader assigns it only when the resolver returns a detail; noneligible states omit it.

## 7. Notification content and metadata

Append the external detail to the existing current schedule lines in both portal and email composition. Include it in every shared builder, including initial publication and first-verification current-state catch-up.

Use this exact dated text, replacing only the ISO dates:

> X-ray schedule: {xrayDate} at Iloilo Mission Hospital, 7 calendar days before your KABALAKA CBC, Urine, and Stool appointment on {laboratoryDate}. Contact CPU Clinic for instructions if this date has passed.

For an eligible detail with no authorized date:

> X-ray schedule at Iloilo Mission Hospital: awaiting an authorized KABALAKA appointment date.

Keep the existing Laboratory and PE lines and schedule notice. The portal notice is stored immediately when the scheduling transaction commits, subject to existing enqueue-isolation behavior. Do not defer its creation until the X-ray date or wait for a student to open the portal.

Add `metadata.externalXraySchedule` only when the detail exists, containing the five fields of `OjtExternalXraySchedule`. Store no DOB, findings, result values, uploads, verifier identity or hospital booking identifier.

For fingerprints, conditionally extend the existing canonical object with an explicit ordered tuple of the anchor appointment ID, Laboratory date, X-ray date, provider and offset. Omit the extra property entirely for noneligible states so existing literal non-OJT hashes remain stable. Do not hash the current clock or mutable student profile.

Preserve existing event-key families. A repeated publication or request produces the existing single event notice; the first-verification catch-up uses the extended current-state fingerprint. Do not introduce a separate XRAY event or replay old publication events.

## 8. Lifecycle behavior

| Event/state | Required notification behavior |
| --- | --- |
| Initial publication | Immediately show KABALAKA date and X-ray date minus seven |
| Authorized Laboratory replacement | New notice uses the effective replacement Laboratory date; exclude replaced source as an active date |
| PE-only replacement | Keep X-ray date anchored to unchanged Laboratory date |
| Laboratory awaiting Manual Resolution | Show pending X-ray text; do not present the affected old date as current |
| Manual Resolution completion | Show replacement KABALAKA date and its newly calculated X-ray date |
| Cancellation | Follow current authoritative state: no cancelled row may supply an active X-ray date |
| Eligible unaffected Laboratory survives another service's cancellation | Retain its valid X-ray schedule detail |
| First email verification | Current-state catch-up includes the currently derived detail; do not replay historical notices |
| Portal read/mark-read | Reading adds no clinical/scheduling writes; existing own-notice mark-read remains available |
| PE completion | Existing clinical action confirms X-ray; notification generation itself never confirms a test |

All authorized scheduling paths use the existing shared loader/composer; avoid separate calculations at each call site. Old notices remain dated historical event records, with read state intact. Later notices carry updated current dates; no historical rewrite or blanket backfill is required for the fresh-deployment scope.

Do not add new failure semantics to scheduling. Portal and email enqueue failures retain existing savepoint/warning behavior. Ordinary transaction rollback must leave no newly created notice or outbox row. Missing cohort context suppresses the external detail while keeping general notices usable.

## 9. Acceptance criteria

1. A fourth-year OJT KABALAKA date of `2026-08-20` produces `2026-08-13` in stored portal and verified-email schedule content.
2. The notice exists at publication; it does not depend on email verification, portal login or a timed worker.
3. After Laboratory replacement to `2026-08-27`, the new notice shows X-ray `2026-08-20`. A PE-only change leaves that date unchanged.
4. Eligibility survives a change to the student's live year/category because the linked checklist remains authoritative.
5. First-Year/OVPSA and fourth-year Regular/Tour receive no OJT minus-seven instruction.
6. Pending Manual Resolution has no active X-ray date. Cancelled/replaced rows cannot supply one.
7. Month/year/leap transitions, impossible/null dates and late scheduling follow Sections 6–7.
8. Request retries create no duplicate event notice/outbox work; non-OJT literal fingerprint tests still pass.
9. Portal and verified email use identical X-ray dates; address authorization and outbox retries retain existing behavior.
10. No new appointment, reservation, result, checklist verification, certificate or capacity consumption is caused by composing/reading the detail.
11. Existing OJT PE readiness at 3/4 and PE-linked X-ray confirmation continue to pass.
12. Browser acceptance proves an unverified OJT student can read the notice and mark it read on desktop and a narrow screen.

## 10. Delivery boundary

Implement only after reviewing this spec and its plan. The present requested deliverable is the documentation commit. On feature implementation, update `docs/current-policies.md`, `README.md` and `docs/e2e.md` with the implemented rule and acceptance evidence; do not label the feature as currently shipped in this documentation-only commit.
