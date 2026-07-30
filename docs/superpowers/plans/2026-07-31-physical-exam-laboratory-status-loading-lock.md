# Physical Exam Laboratory Status and Loading Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current paired Laboratory appointment status on Physical Exam rows and prevent duplicate quick-status requests through authoritative refresh.

**Architecture:** Add an opt-in paired-status projection to the existing appointment list query, surface it through the shared clinic schedule component only for Physical Exam, and make the shared quick-status control use a synchronous request guard plus prop-driven completion. Reuse the guarded clinic Browser fixture for deterministic acceptance and cleanup.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL, Tailwind CSS, Vitest, Testing Library, and the in-app Browser.

## Global Constraints

- No database migration or appointment PATCH API contract change.
- No optimistic status transition or per-row browser request.
- Preserve server expected-status conflict protection, existing confirmation rules, filters, sorting, pagination, and the Laboratory table layout.
- Use exact-pair matching for non-null Physical Exam pair IDs; use deterministic same-cycle fallback only when the Physical Exam pair ID is null.
- Run every production behavior through a failing test before implementation.
- Use the guarded exclusive local acceptance database and prove zero fixture residue.
- Do not push, open a pull request, merge to `main`, or remove the feature worktree.

---

### Task 1: Paired Laboratory status repository projection

**Files:**
- Modify: `src/server/repositories/appointments.repository.ts`
- Modify: `src/server/repositories/appointments.repository.test.ts`
- Modify: `src/server/services/appointments-published.integration.test.ts`

**Interfaces:**
- `listAppointments` accepts `includeLaboratoryStatus?: boolean`.
- List items expose `laboratoryStatus: "PENDING" | "COMPLETED" | "NO_SHOW" | null`.
- The count query and existing filter/order parameters remain unchanged.

- [ ] Write failing repository tests for opt-in SQL and real-database exact-pair, replacement, legacy fallback, null-match, totals, and filters.
- [ ] Add one opt-in lateral projection that matches the same student and `schedule_cycle_start`; requires the same non-null `schedule_pair_id`; falls back only when the Physical Exam pair ID is null; accepts published active leaf Laboratory rows; and orders fallback by date, creation time, then ID descending.
- [ ] Run focused unit and integration tests, self-review, and commit the green slice.

### Task 2: Physical Exam table status column

**Files:**
- Modify: `src/app/(dashboard)/physical-exam/page.tsx`
- Modify: `src/app/(dashboard)/physical-exam/page.test.tsx`
- Modify: `src/components/appointments/ClinicPublishedSchedule.tsx`
- Modify: `src/components/appointments/ClinicPublishedSchedule.test.tsx`
- Verify: `src/app/(dashboard)/laboratory/page.test.tsx`

**Interfaces:**
- `ClinicPublishedSchedule` accepts `showLaboratoryStatus?: boolean`.
- Physical Exam enables both repository and table options; Laboratory enables neither.

- [ ] Write failing page/table tests for five-column order, read-only status text and tones, `Not available`, unchanged Laboratory columns, empty state, and pagination.
- [ ] Render a non-interactive compact badge between Date and Physical Exam Status with slate Pending, emerald Completed, red No-show, and muted unavailable styling.
- [ ] Run focused page/component tests, self-review, and commit the green slice.

### Task 3: Synchronous quick-status loading lock

**Files:**
- Modify: `src/components/appointments/AppointmentQuickStatusButton.tsx`
- Modify: `src/components/appointments/AppointmentQuickStatusButton.test.tsx`

**Interfaces:**
- Existing component props and PATCH payload remain unchanged.
- A request generation is keyed by appointment ID, authoritative status, and completion source.

- [ ] Write failing observable tests for same-act direct and confirmed duplicates, post-success lock retention, prop-driven release, stale-row invalidation, API/network retry, spinner accessibility, and unchanged payloads/tones/messages.
- [ ] Add a synchronous ref lock before any await/state update; invalidate stale request completions when keyed props change; retain success busy state until authoritative props change; release immediately on failure.
- [ ] Render an `aria-hidden` motion-safe spinner with `Updating...`, keep `aria-busy`, and ensure disabled controls cannot use hover, lift, scale, or shine effects.
- [ ] Run focused tests, self-review, and commit the green slice.

### Task 4: Guarded Browser acceptance and final verification

**Files:**
- Modify: `scripts/browser-clinic-scheduler-ux-fixture.ts`
- Modify: `src/test/browser-clinic-scheduler-ux-fixture.test.ts`
- Modify: `src/test/browser-clinic-scheduler-ux-ownership.integration.test.ts`

**Interfaces:**
- Fixture state exposes a tracked Physical Exam row with no active Laboratory match while retaining pending, completed, no-show, and protected quick-status cases.

- [ ] Write failing fixture ownership/validation tests and extend the staged fixture without weakening database identity or cleanup guards.
- [ ] Prepare, import, publish, and stage against the exclusive loopback acceptance database.
- [ ] Use the in-app Browser on `/physical-exam` and `/laboratory` to verify headers, badge states, non-interactivity, rapid-click request counts, busy accessibility, refreshed success, confirmation locking, protected failure/retry, payloads, and console output.
- [ ] Run fixture status and cleanup; prove zero residue.
- [ ] Run focused tests, the serialized full suite, lint, production build, and `git diff --check`.
- [ ] Review the complete branch diff and commit final acceptance changes locally.
