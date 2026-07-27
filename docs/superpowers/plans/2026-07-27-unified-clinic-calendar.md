# Unified Clinic Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace clinic-specific unavailable dates with one annual calendar that safely reschedules unfinished appointments, preserves completed work, supports emergency closures and restoration, and routes unsafe cases to administrators.

**Architecture:** A unified closure repository supplies one blocked-date set to imports and calendar operations. Preview and authoritative save share a completion-aware planner; save recalculates under the scheduling advisory lock inside one transaction and isolates known student-level failures with savepoints and explicit manual cases. The existing calendar and student/appointment surfaces consume the new contracts without retaining `clinicId` or `UNBLOCK` compatibility.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL, Zod, Vitest/Testing Library, Tailwind CSS, in-app Browser verification.

## Global Constraints

- Work in isolated branch `codex/unified-clinic-calendar`; do not push, open a PR, or merge without a separate request.
- Use TDD: add a focused failing test, observe the intended failure, implement minimally, and rerun focused coverage before each commit.
- The maximum editable year is 2100 and one operation accepts at most 366 staged date changes.
- Adjacent blocked dates form one closure group only when category and normalized reason match.
- Weekends stay visible but cannot be blocked; today can be blocked only as `EMERGENCY_CLOSURE` with explicit acknowledgment.
- Preserve completed appointments and medical-result contents exactly; general audit metadata must not contain result contents.
- Apply the cleanup migration only after verifying the configured local database identity and exclusive access.

---

### Task 1: Cleanup Migration and Unified Schema

**Files:**
- Create: `database/migrations/014_unified_clinic_calendar.sql`
- Modify: `src/server/db/database.integration.test.ts`

- [ ] Add isolated-schema migration tests for safe cleanup, each preflight stop condition, unrelated history preservation, unified constraints, and zero active dates.
- [ ] Run the new migration tests and confirm they fail because migration 014 is absent.
- [ ] Implement the preflight, attributable rollback cleanup, unified closure/date/request/manual-case/event-link schema, `AWAITING_RESCHEDULE`, and notification event keys.
- [ ] Run focused database tests, verify database identity/exclusivity, apply the migration, and prove zero active blocked dates.
- [ ] Commit as `feat: add unified clinic calendar schema`.

### Task 2: Planning, Application, Restoration, and Manual Resolution

**Files:**
- Modify: `src/server/repositories/clinic-unavailable-dates.repository.ts`
- Modify: `src/server/services/clinic-calendar-planner.ts`
- Modify: `src/server/services/clinic-calendar.service.ts`
- Create: focused manual-case repository/service modules and tests beside these files.

- [ ] Add failing unit/integration tests for contiguous grouping, completion-aware classification, latest-group replacement starts, deterministic capacity allocation, per-student safety fallback, full rollback, restoration, and both manual resolution actions.
- [ ] Replace clinic-scoped planning with unified preview/save planning and date-level lineage.
- [ ] Implement advisory locking, request idempotency, authoritative recalculation, per-student savepoints, notification/audit writes, restoration, and manual resolution.
- [ ] Run focused planner/service/repository coverage and commit as `feat: add unified closure lifecycle`.

### Task 3: APIs, Visibility, Portal, Notifications, and Scheduling

**Files:**
- Modify: `src/types/clinic-calendar.ts`
- Modify: calendar API routes and appointment/student repositories.
- Create: preview and manual-case API routes with route tests.

- [ ] Add failing contract and integration tests for date-only `BLOCK`/`REOPEN`, preview, idempotent save, role access, manual-case pagination/resolution, operational exclusions, awaiting presentation, event-key deduplication, and imports avoiding unified closures.
- [ ] Implement the new contracts and routes, role-aware calendar reads, operational/current-history behavior, student/public unresolved presentation, shared blocked-date scheduling, and notification deduplication.
- [ ] Run focused API, appointment, portal, notification, and scheduling tests; commit as `feat: integrate unified closures across scheduling`.

### Task 4: Annual Calendar and Manual Resolution UI

**Files:**
- Modify: `src/components/settings/ClinicUnavailableCalendar.tsx`
- Modify: calendar presentation/draft components and the settings page.
- Create: annual-grid/impact-preview/manual-resolution components and administrator page tests.

- [ ] Add failing component/page tests for twelve true-date month grids, date-only drafts, preview invalidation, emergency acknowledgment, read-only staff access, manual-case filters, assignment, and keep-current resolution.
- [ ] Build the responsive annual calendar, impact confirmation, role-aware navigation, and administrator manual-resolution queue.
- [ ] Run focused UI/page coverage and commit as `feat: add annual clinic closure workflow`.

### Task 5: Complete Verification

- [ ] Run the complete serialized suite: `npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000`.
- [ ] Run `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Use controlled exclusive fixtures and the in-app Browser to verify future and same-day closures, completion preservation, unresolved/manual flows, restoration, read-only staff access, public/student presentation, exact API payloads, and clean console output.
- [ ] Repeat layout acceptance near 390px, 1280px, and 1536px widths; prove zero fixture residue.
- [ ] Review the diff against the approved design and hand off the unmerged local branch with verification evidence.
