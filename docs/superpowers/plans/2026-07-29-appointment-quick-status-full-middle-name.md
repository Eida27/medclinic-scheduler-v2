# Appointment Quick Status and Full Middle Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display complete student middle names and let authorized clinic operators update attendance safely from the Laboratory and Physical Exam tables.

**Architecture:** Extend the existing strict schedule-import and shared SQL name formatter, then add a semantic branch to the existing appointment PATCH service. The server derives restoration state from locked appointment history and reuses current result-protection, placeholder, history, and audit infrastructure. A reusable client button owns interaction only; the server remains authoritative.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL, Zod, Vitest, Testing Library, and the in-app Browser.

## Global Constraints

- Use `Middle Name` as the single exact CSV header and reject legacy `MI` files.
- Do not add a database migration, previous-status column, or parallel history table.
- Preserve appointment dates, automatic no-shows, detailed corrections, rescheduling, filters, sorting, pagination, and read-only Appointments summary badges.
- Run each behavior through a failing test before production code.
- Use the guarded exclusive local acceptance database and prove zero fixture residue.
- Do not push, open a pull request, merge to `main`, or remove the worktree.

---

### Task 1: Full middle-name import and display foundation

**Files:**
- Modify: `src/server/services/student-import-csv.ts`
- Modify: `src/server/students/student-display-name.ts`
- Modify: import repositories, UI instructions, template, fixtures, and focused tests

**Interfaces:**
- `ImportedStudentRow.middleName: string | null`
- Exact header: `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth`
- `studentDisplayNameSql(alias)` renders the full trimmed middle name.
- A separate legacy formatter remains search-only for former initial-form queries.

- [ ] Write and run failing parser, persistence, formatter, and search tests.
- [ ] Implement the strict header/property rename, template/UI copy, formatter, and compatibility search.
- [ ] Run focused tests and commit the green slice.

### Task 2: Completion history and semantic quick-status service

**Files:**
- Modify: `src/server/repositories/appointments.repository.ts`
- Modify: `src/server/services/appointments.service.ts`
- Modify: appointment repository, service, integration, and route tests

**Interfaces:**
- `completedFromStatus: "PENDING" | "NO_SHOW" | null`
- `{ quickStatusAction: "MARK_COMPLETED" | "REVERT_COMPLETION"; expectedStatus: "PENDING" | "NO_SHOW" | "COMPLETED" }`

- [ ] Write and run failing list/history, authorization, transition, result-protection, audit, concurrency, and API tests.
- [ ] Add locked history derivation and a mutually exclusive semantic request parser.
- [ ] Apply every quick transition atomically with one status log and one audit row.
- [ ] Run focused tests and commit the green slice.

### Task 3: Clinic table interaction and dialog accessibility

**Files:**
- Create: `src/components/appointments/AppointmentQuickStatusButton.tsx`
- Modify: `src/components/appointments/ClinicPublishedSchedule.tsx`
- Modify: `src/components/ui/ConfirmDialog.tsx`

**Interfaces:**
- `AppointmentQuickStatusButton` consumes appointment ID, current status, and derived completion source only.
- Student name and number link independently to the existing clinic detail route.

- [ ] Write and run failing component/page/accessibility tests.
- [ ] Implement button states, confirmations, loading/error behavior, and route refresh.
- [ ] Remove the Open column, add student links, and add focus trapping/restoration to the shared dialog.
- [ ] Run focused tests and commit the green slice.

### Task 4: Guarded Browser acceptance and final verification

**Files:**
- Modify: `scripts/browser-clinic-scheduler-ux-fixture.ts`
- Modify: `src/test/browser-clinic-scheduler-ux-fixture.test.ts`
- Modify: `package.json` only if a new fixture command is required

- [ ] Lock the supplied CSV's row count, BOM, size, SHA-256, and full-name sample behavior in fixture tests.
- [ ] Prepare/import/publish/stage through the guarded fixture and real UI.
- [ ] Use the in-app Browser to exercise both immediate and confirmed status transitions, protected-data rejection, links, read-only summary badges, filters, sorting, pagination, network payloads, and console output.
- [ ] Run fixture status and cleanup checks and prove zero residue.
- [ ] Run the serialized full suite, lint, production build, and `git diff --check`.
- [ ] Review the complete diff against the approved design and commit final acceptance changes locally.
