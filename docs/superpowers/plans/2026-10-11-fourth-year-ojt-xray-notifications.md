# Fourth-Year OJT External X-ray Schedule Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document plans future application work; it does not authorize executing it in the documentation-only task.

**Goal:** Include fourth-year OJT students' Iloilo Mission Hospital X-ray date, exactly seven calendar days before KABALAKA Laboratory, in existing portal schedule notices.

**Architecture:** Derive one optional external X-ray schedule detail from the selected Laboratory appointment and its immutable linked checklist. Enrich the shared schedule state, then reuse the existing notification builders and delivery hooks. No third appointment, migration or timed worker is needed.

**Tech Stack:** Existing Next.js 16.3.5, React 19.2.4, TypeScript, PostgreSQL/pg and Vitest 4.1.8; no dependency changes.

**Spec:** [Fourth-year OJT X-ray notification design](../specs/2026-10-11-fourth-year-ojt-xray-notifications-design.md).  
**Reviewed baseline:** `main` at `957310bb14733401a1a5ff0e492d2c15dec75ebd`.  
**Planning assumption:** The X-ray appointment date is KABALAKA minus seven calendar days; the notification is created at publication. The user did not select an answer to the clarification prompt.

## Global constraints

- Eligibility is fourth-year OJT from the linked Laboratory checklist's immutable year/category, never the student's mutable profile.
- Anchor the calculation to the authoritative KABALAKA Laboratory appointment, never the Physical Examination or affected old date.
- Subtract exactly 7 calendar days from an ISO date representing an Asia/Manila service date.
- Keep portal notification access independent of email verification.
- Preserve verified-address email eligibility, existing enqueue isolation, retry and deduplication.
- Preserve the October 8 PE-linked external completion policy and all appointment/result protections.
- Add no database migration, dependency upgrade, new appointment service, capacity accounting or timed delivery worker.
- Preserve existing notification type/title/event-key families and noneligible schedule fingerprints.

## Review focus

1. Mutable profile changes and replacement lineage must not change saved OJT eligibility: Task 2.
2. Pending resolution/cancelled sources must not expose an old date as an active X-ray date: Tasks 1–4.
3. An unverified student and an SMTP outage must still allow portal reading: Tasks 3–4.
4. Same-day/past and cross-month/year dates must retain exact subtraction without changing scheduling: Tasks 1 and 4.
5. Retries, transaction rollback and non-OJT fingerprints must preserve existing behavior: Tasks 3–4.

## File map

| File | Responsibility |
| --- | --- |
| Create `src/server/schedule/ojt-external-xray.ts` and `.test.ts` | Pure eligibility/date resolver and exported context/detail types |
| Modify `src/server/repositories/schedule-state.repository.ts` | Read immutable checklist context in the existing query and attach the optional detail |
| Modify `src/server/repositories/schedule-state.repository.integration.test.ts` | Prove transaction visibility, saved eligibility and authoritative replacement selection |
| Modify `src/server/schedule/schedule-notifications.ts` and `.test.ts` | State type, shared content, conditional metadata and fingerprint |
| Create `src/server/schedule/ojt-external-xray-notifications.integration.test.ts` | Persisted publication/replacement/catch-up/rollback tests using real services |
| Modify `src/server/appointments/bulk-replacement.integration.test.ts` | Cover batch OJT replacements through the current bulk service |
| Create `src/components/student/NotificationList.test.tsx` | Render the existing stored message and exercise own-notice mark-read |
| Modify `README.md`, `docs/current-policies.md`, `docs/e2e.md` | Record shipped policy and browser acceptance only when implementation passes |
| Create `docs/superpowers/evidence/2026-10-11-fourth-year-ojt-xray-notifications.md` | Record actual commands/results and browser evidence from implementation |

Read repository `AGENTS.md` first. Before changing Next.js code, read the relevant local Next.js guides required by it. Use the current lockfile; no package upgrade is part of this work. Inspect the current branch and diff before implementation and use the worktree skill if isolation is needed.

## Task 1: Pure OJT external date resolver

**Files:** Create `src/server/schedule/ojt-external-xray.ts` and `src/server/schedule/ojt-external-xray.test.ts`.

**Interfaces:**
- Consumes the exact `OjtExternalXrayContext` in spec Section 6; `AppointmentStatus` is a type-only import from `schedule-notifications.ts`.
- Exports `OjtExternalXrayContext`, `OjtExternalXraySchedule` and `deriveOjtExternalXraySchedule(context: OjtExternalXrayContext): OjtExternalXraySchedule | null`.
- Produces the five-field detail consumed by Tasks 2–3; an eligible undated/awaiting record has both dates null.

- [ ] **Step 1: Write resolver tests.** Use a complete eligible context named `ojt`: lab ID `lab-1`, clinic `KABALAKA_CLINIC`, year 4, category `OJT`, status `PENDING`, no OVPSA provenance and date `2026-08-20`.

```ts
expect(deriveOjtExternalXraySchedule(ojt)).toEqual({
  anchorLaboratoryAppointmentId: "lab-1",
  laboratoryDate: "2026-08-20",
  xrayDate: "2026-08-13",
  provider: "Iloilo Mission Hospital",
  offsetCalendarDays: 7,
});
```

Add parameterized assertions:

| Inputs differing from `ojt` | Expected |
| --- | --- |
| Date `2026-09-03` / `2027-01-04` / `2028-03-01` | X-ray `2026-08-27` / `2026-12-28` / `2028-02-23` |
| Date `2026-08-01` | `2026-07-25`; no academic-start clamp |
| Date `2026-08-16` (Sunday) | `2026-08-09`; no weekday clamp in the resolver |
| Year 1, 2 or 3; year 4 Regular/Tour; wrong clinic; OVPSA provenance; missing saved year/category | null detail |
| `DRAFT`, `CANCELLED`, `RESCHEDULED` | null detail |
| `AWAITING_RESCHEDULE` with an old stored date | Detail with `laboratoryDate: null`, `xrayDate: null` |
| Null date, `2026-02-30`, `2026-13-01`, malformed date | Detail with both dates null |
| `COMPLETED` / `NO_SHOW` with a real date | Same planned date; no clinical completion assertion |

Repeat a dated input under different host timezone settings and with host clocks before, on, and after its X-ray date: the result must be identical.

- [ ] **Step 2: Run the tests and confirm failure.**  
Run `npm test -- src/server/schedule/ojt-external-xray.test.ts`. Expect a missing-module/export failure before implementing the resolver.

- [ ] **Step 3: Implement the resolver.** Match the spec's eligibility/status branches. Validate the real ISO date by comparing parsed UTC components with the input, then subtract seven using UTC calendar components. Do not access the clock, database, browser timezone or clinical items.

- [ ] **Step 4: Rerun the resolver tests.** Same command; expect all cases passing.

- [ ] **Step 5: Commit the resolver and tests.**  
Commit message: `feat: derive fourth-year OJT external X-ray schedule dates`.

## Task 2: Load immutable context with authoritative schedule state

**Files:** Modify `src/server/repositories/schedule-state.repository.ts` and its existing `.integration.test.ts`; add the optional state type property in `src/server/schedule/schedule-notifications.ts`.

**Interfaces:**
- Consumes Task 1's resolver and exported detail type.
- Preserves `loadAuthoritativeScheduleState(client: PoolClient, studentNumber: string): Promise<AuthoritativeScheduleState | null>`.
- Adds `externalXraySchedule?: OjtExternalXraySchedule` to `AuthoritativeScheduleState`; omit the property when ineligible.

- [ ] **Step 1: Write repository integration assertions.** Create a published OJT pair and immutable academic snapshot through valid fixture helpers; call `linkPublishedLaboratoryAppointments` before reading it. In the caller's transaction, a Laboratory date `2092-08-20` must produce `2092-08-13`. Then change the live student profile to year 3: the same saved checklist must still produce the detail.

Add a linked Laboratory replacement on `2092-08-27`: the anchor ID must equal the replacement ID and X-ray must be `2092-08-20`; changing only the paired PE date must not change it. Cover fourth-year Regular/Tour, valid First-Year/OVPSA, PE-only, missing contextual data and inactive/unknown students. Use rollback-local fixtures for inconsistent/missing context; do not commit a constraint-invalid appointment or disable database triggers. Existing saved selection semantics and non-OJT fingerprints must remain valid.

- [ ] **Step 2: Run the focused repository test and confirm failure.**  
Run `npm run test:integration -- src/server/repositories/schedule-state.repository.integration.test.ts`. Expect the new detail assertions to fail. Use the runner's disposable database; do not point it at a populated deployment database.

- [ ] **Step 3: Enrich the existing state query.** Carry clinic code, academic cycle, saved category and OVPSA provenance into `ranked_current`. LEFT JOIN the selected lab's link/checklist with same-student/cycle/category predicates. Call Task 1's resolver for that lab row and assign the optional property only for a nonnull result.

Keep general notices when the join yields no context. Do not query mutable student year, create checklists, read test results, alter row ranking or issue a per-notice extra checklist query.

- [ ] **Step 4: Rerun the focused integration test.** Same command; expect all repository assertions passing.

- [ ] **Step 5: Commit.**  
Commit message: `feat: expose saved OJT X-ray context in schedule notification state`.

## Task 3: Compose consistent portal/email content and fingerprints

**Files:** Modify `src/server/schedule/schedule-notifications.ts` and `src/server/schedule/schedule-notifications.test.ts`.

**Interfaces:**
- Consumes Task 2's optional `state.externalXraySchedule`.
- Preserves every existing `build*Notification` function signature and `StudentNotificationInput`.
- Produces the exact dated/pending text from spec Section 7, optional `metadata.externalXraySchedule`, and an extended eligible fingerprint.

- [ ] **Step 1: Write builder assertions.** Make an eligible copy of the existing fixture with Laboratory `2026-08-20` and the derived detail. The initial notice must retain its existing type/title/event key and contain `X-ray schedule: 2026-08-13 at Iloilo Mission Hospital` plus the KABALAKA `2026-08-20` anchor in both `message` and `emailTextBody`. Assert the entire fixed line, including the contact sentence, against the spec.

Parameterize every shared builder: initial, current-state, priority displacement, closure replacement, awaiting resolution, Manual Resolution completion, administrator replacement, restoration and cancellation. Supply their actual authoritative resulting state; cancellation with no lab has no detail, while a surviving unaffected lab retains its detail.

```ts
expect(notice.metadata?.externalXraySchedule).toEqual(detail);
expect(fingerprintScheduleState(eligible)).not.toBe(
  fingerprintScheduleState({ ...eligible, externalXraySchedule: undefined }),
);
expect(fingerprintScheduleState(currentState)).toBe(
  "fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
);
```

Also assert fingerprint stability across object insertion order, pending-date changes and repeated identical inputs. Confirm metadata omits the new field for noneligible states and no medical/result values enter text or metadata.

- [ ] **Step 2: Run builder tests and confirm failure.**  
Run `npm test -- src/server/schedule/schedule-notifications.test.ts`. Expect missing X-ray text/metadata assertions to fail.

- [ ] **Step 3: Extend common composition.** Append the fixed dated/pending line in `currentLines`. Add the detail to metadata and conditionally append the spec's ordered tuple to fingerprint canonicalization. Retain the old canonical object entirely when no detail exists. Leave event-key/type/title families and previous-service history lines intact; do not duplicate calculation at call sites or synthesize an old X-ray date from previous/current mixed contexts.

- [ ] **Step 4: Rerun focused unit regressions.**  
Run `npm test -- src/server/schedule/schedule-notifications.test.ts src/server/services/student-notifications.service.test.ts src/app/api/student/notifications/route.test.ts 'src/app/(student)/student/notifications/page.test.tsx'`. Expect all selected tests passing.

- [ ] **Step 5: Commit.**  
Commit message: `feat: include OJT hospital X-ray dates in schedule notices`.

## Task 4: Prove persisted lifecycle, portal access and unchanged clinical behavior

**Files:** Create the integration test and component test from the file map; modify the existing bulk replacement integration test. Update `README.md`, `docs/current-policies.md`, `docs/e2e.md` and the new evidence record after verification.

**Interfaces:**
- Uses real `acceptAndScheduleImport`, `queueAuthoritativeScheduleNotification`, `queueFirstVerificationCurrentStateCatchUp`, current replacement/Manual Resolution services and `NotificationList`.
- Relies on Tasks 1–3's shared state and `StudentNotificationInput`; creates no new endpoint or notification type.

- [ ] **Step 1: Add persisted end-to-end assertions.** In `ojt-external-xray-notifications.integration.test.ts`, use actual fourth-year OJT import publication, with a configured academic year and valid preferred month, then inspect the resulting dates instead of assuming the scheduler ignores its preparation boundary.

Name tests for these specific behaviors: `publishes an immediate X-ray notice for an unverified OJT student`, `updates the X-ray notice after a Laboratory replacement`, `retains the anchor after a PE-only replacement`, `clears the current X-ray date while Laboratory awaits resolution`, `recalculates after Manual Resolution completes`, `omits a cancelled Laboratory date`, `catches up only the current X-ray state on first verification`, and `rolls notification work back with its scheduling transaction`.

For each dated notice, assert `xrayDate = stored Laboratory date - 7 calendar days`, matching portal/email text and metadata. For pending/cancelled states, assert no old date is presented as current. For late replacement, retain the exact date and contact instruction. Check one notice per retried event, zero email rows for an unverified student, one current-state catch-up for a verified student, and verified-email content using the shared outbox. Simulate an email enqueue failure and assert the portal row remains readable under existing savepoint behavior.

Count appointment rows/reservations and snapshot checklist items before/after notice composition: no extra service or test confirmation may appear. Snapshot notices' read state before a later event and prove it is unchanged. All committed fixtures must satisfy current clinical/provenance constraints and use owned disposable test data.

- [ ] **Step 2: Add batch and rendering assertions.** Extend `bulk-replacement.integration.test.ts` with two fourth-year OJT Laboratory replacements; each student's stored notice must use its own effective lab ID/date, and each has one event notice on retry. In `NotificationList.test.tsx`, render the stored dated message and assert provider/date text and an own-ID PATCH when “Mark read” is clicked; do not change the component merely to manufacture coverage.

- [ ] **Step 3: Run the new focused tests.**  
Run `npm test -- src/components/student/NotificationList.test.tsx`.  
Run `npm run test:integration -- src/server/schedule/ojt-external-xray-notifications.integration.test.ts src/server/appointments/bulk-replacement.integration.test.ts`.  
Inspect results; assertions should now pass through shared composition. If a real path bypasses it, capture a failing assertion before a targeted fix. Review the existing hooks in import, appointments, closure, bulk replacement and catch-up services; avoid copying date logic into them.

- [ ] **Step 4: Verify complete regressions on final code.** Run, individually:

```bash
npm test
npm run test:integration
npm run test:migrations:empty
npx next typegen
npx tsc --noEmit
npm run lint
npm run build
```

Require exit code zero for each. Preserve existing OJT 3/4 PE readiness and PE-linked X-ray confirmation cases in `src/server/laboratory/pe-linked-laboratory.integration.test.ts`; no notification-only operation can verify XRAY. Confirm migration count remains 32 with zero pending on rerun, since this feature adds no schema.

- [ ] **Step 5: Perform browser acceptance and write evidence.** Use synthetic owned students in a local disposable acceptance environment. Publish a fourth-year OJT schedule; sign in unverified and open `/student/notifications`. Confirm its publication notice already exists, names Iloilo Mission Hospital and shows the exact seven-day date; mark it read. Replace Laboratory, then PE only; verify date changes only with Laboratory. Exercise awaiting/reassigned Manual Resolution, compare a fourth-year Regular/Tour and First-Year student, and verify verified-email content through the local SMTP sink. Repeat notice reading at desktop and narrow viewport. Reading must not create results/drafts or alter checklist/certificate state.

Record the actual baseline, commands, exit codes/test counts, screenshots and stored notification/metadata checks in the evidence record. Clean up only owned acceptance data. Document the implemented rule and link the spec/plan in the current-policy index only after these checks pass.

- [ ] **Step 6: Commit the acceptance coverage and shipped documentation.**  
Commit message: `test: verify OJT X-ray notice lifecycle and portal access`.

## Completion and handoff

The feature is complete when all spec acceptance criteria map to passing tests/browser evidence and the final diff contains only this notification feature, its tests and relevant documentation. Review the plan's stated timing assumption before executing product changes. The current documentation commit must contain only this spec and plan; it must not claim these application tests have already run.
