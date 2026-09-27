# Import years, PE completion, and manual resolution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the three workflows in the approved design with live authorization, clinical and scheduling integrity, and Browser acceptance.

**Architecture:** Keep the existing publication and certificate writers authoritative. Add a narrow import-year catalog and a reusable PE completion dialog. Extract the manual-case transaction body into a client-aware helper, then build ordinary bulk planning, signed preview, and atomic application on top; leave coordinated OVPSA recovery in its own path.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, PostgreSQL, Vitest, Browser.

**Spec:** `docs/superpowers/specs/2026-09-27-import-pe-completion-manual-resolution-design.md`

## Global Constraints

- Admin and Coordinator may import; only Admin may configure years or resolve manual cases; PE completion remains Admin or CPU Clinic staff.
- An ordinary manual selection has 1–100 cases from one open academic year and shared service dates; coordinated OVPSA Laboratory recovery stays whole-batch and separate.
- Preserve completed services, checklist lineage, certificate revisions, notifications, import provenance, and transaction boundaries.
- Apply the next additive migration; keep empty academic-year catalog a valid install state.
- Read installed Next.js guides before changing page, route, or component code.

## Review Focus

- A catalog refresh after Manila midnight closes a selected year and invalidates an already reviewed import; test in Task 1.
- Two concurrent identical PE completion requests return one certificate and the same outcome; test in Task 2.
- An awaiting source that consumes no capacity cannot be subtracted when projecting a shared destination; test in Task 4.
- An ordinary selection cannot claim one member of coordinated OVPSA Laboratory recovery; test in Task 4.
- An OVPSA batch spanning queue pages confirms the full current server membership; test in Task 5.

---

### Task 1: Configured import-year catalog and enforcement

**Files:** Modify `src/server/repositories/academic-years.repository.ts`, `src/server/services/academic-years.service.ts`, `src/server/services/schedule-imports.service.ts`, `src/server/services/first-year-schedule-import.service.ts`, `src/server/repositories/schedule-imports.repository.ts`, `src/app/(dashboard)/students/schedule-imports/new/page.tsx`, `src/components/schedules/ScheduleImportForm.tsx`; create `src/app/api/schedule-imports/academic-years/route.ts`; extend matching tests.

**Interfaces:** Produce `listImportAcademicYears(now?: Date): Promise<Array<{startYear:number;label:string;closingDate:string;state:AcademicYearState;selectable:boolean}>>`, `assertImportAcademicYear(startYear:number, client?:PoolClient): Promise<AcademicYearSchedulingBoundary>`, and an Admin/Coordinator private GET catalog. Both publication transactions must use the locked current boundary.

- [ ] Write tests: only configured years (including outside the old range), closed disabling and default choice, empty/failure UI, Admin/Coordinator catalog authorization, preflight/review/final missing or ended errors, changed closing date.
- [ ] Run the focused tests and record the expected failures from generated options and absent year validation.
- [ ] Implement catalog query without linked counts, Manila-based choice/refresh and stale-review invalidation, route and page props, and preflight/review/final guards with field `academicYearStart` and codes `ACADEMIC_YEAR_NOT_CONFIGURED` / `ACADEMIC_YEAR_ENDED`.
- [ ] Run focused tests, migration-independent integration checks, TypeScript/lint, and record passing output.
- [ ] Commit `feat: use configured academic years for imports`.

### Task 2: Direct PE completion and list dialog

**Files:** Modify `src/components/appointments/PhysicalExamCompletionForm.tsx`, `ClinicPublishedSchedule.tsx`, `AppointmentDetail.tsx`, `src/app/(dashboard)/physical-exam/page.tsx`, `src/server/medical-certificates/certificate.service.ts`; create `PhysicalExamCompletionDialog.tsx`, the completion-context route and focused service; extend matching tests.

**Interfaces:** Produce an authorized, private `GET /api/appointments/[appointmentId]/physical-exam-completion-context` and `PhysicalExamCompletionDialog({appointmentId,onClose,onCompleted})`; reuse `POST /complete-physical-exam` for the only write.

- [ ] Write tests: list button authorization and no navigation, stale context isolation, A–D direct submit without preview, mandatory fields, optional preview, exact request retry, and context blockers.
- [ ] Run focused tests and observe failure before implementation.
- [ ] Implement context loading, dialog focus/close behavior, reusable form with direct Submit and optional preview, success download and list refresh, and matching detail behavior. Keep the certificate writer and its effective-scope lock/replay contract authoritative.
- [ ] Run focused component, route, and PostgreSQL certificate tests plus lint/typecheck; inspect JPG output.
- [ ] Commit `feat: complete physical examinations from the list`.

### Task 3: Shared manual-case transaction and lock order

**Files:** Modify `src/server/services/clinic-calendar.service.ts` and focused manual-case integration tests; create focused transaction-aware helper modules only where extraction reduces coupling.

**Interfaces:** Produce `resolveClinicClosureManualCaseWithClient(client:PoolClient, caseId:string, request:ClinicManualCaseResolutionRequest, actor:SessionUser)` with no nested transaction; public single-case wrapper retains its current route behavior. Acquire queue, effective scopes, cases, then appointment/checklist locks in a deterministic order shared with OVPSA recovery.

- [ ] Write integration tests preserving individual assign/keep behavior and exposing completion/checklist/resolver lock races.
- [ ] Run tests RED for the missing helper/lock ordering.
- [ ] Extract the client-aware body and establish lock order without changing existing action semantics.
- [ ] Run individual and OVPSA recovery tests and inspect deadlock/rollback results.
- [ ] Commit `refactor: share manual resolution transaction logic`.

### Task 4: Atomic ordinary-case bulk planning and APIs

**Files:** Create `src/server/services/manual-resolution-batch.service.ts`, routes for selection, availability, bulk preview and resolve, focused tests, and `database/migrations/029_manual_resolution_batch_requests.sql`; reuse Task 3 helper, occupancy, protection, notifications, and scope locks.

**Interfaces:** `GET /selection` returns bounded explicit IDs/tokens/counts; `POST /availability` returns bounded month service/date states; `POST /bulk/preview` returns all rows/conflicts and a ten-minute domain-separated signed proof only if all valid; `POST /bulk/resolve` atomically applies the canonical reviewed plan with `BULK_MANUAL_RESOLUTION` replay.

- [ ] Write API and PostgreSQL tests for role, Zod bounds/duplicates/cross-cycle, group provenance, eligibility, date/pair rules, aggregate projected capacity (12 fits, 13 fails), protected services, token binding, expiry, no preview writes, exact replay, fault rollback, and contention.
- [ ] Run focused tests RED; note the failed contracts.
- [ ] Add additive action constraint migration, server selection/availability/planning, preview signing and complete revalidation, then one-transaction apply with per-case/batch audit and stable notifications.
- [ ] Run focused unit and integration tests, empty-database migration proof, and lint/typecheck.
- [ ] Commit `feat: resolve ordinary manual cases atomically in groups`.

### Task 5: Batch UI and full OVPSA membership

**Files:** Modify `src/components/settings/ManualResolutionQueue.tsx`, relevant types, OVPSA route/service and tests; create `ManualResolutionBatchDialog.tsx`, `ManualResolutionDatePicker.tsx`, selection/availability UI tests.

**Interfaces:** Queue retains explicit case ID/token selection across pages in one filter context; dialog previews and confirms exact ordinary selection/shared dates; an authorized OVPSA context GET loads all linked current case IDs/tokens independent of page.

- [ ] Write tests for page/group selection counts, filter and stale selection reset, date colors plus labels/capacity, preview invalidation, successful refresh, and full OVPSA membership across pages.
- [ ] Run UI/route tests RED.
- [ ] Implement selection controls, server-backed group query, month calendar, batch dialog, and OVPSA full context while preserving existing individual controls.
- [ ] Run focused tests, accessibility checks, lint/typecheck.
- [ ] Commit `feat: add manual resolution batch controls`.

### Task 6: Acceptance, documentation, and whole-branch verification

**Files:** Update `README.md` and workflow documentation; add guarded Browser fixtures/screenshots under existing acceptance conventions when needed.

**Interfaces:** Complete the spec's empty-install and three-flow acceptance gate; preserve synthetic fixture/database cleanup.

- [ ] Run `npm run test:migrations:empty`, focused tests, targeted `npm run test:integration`, full serialized `npm test`, `npm run lint`, and `npm run build`; read final exit codes/summaries.
- [ ] Use Browser on the running authenticated app for import states, PE popup/class completion/JPG, ordinary shared-date resolution, OVPSA full-batch recovery, responsive/keyboard behavior, and console/API checks. Capture screenshots and clean fixture residue.
- [ ] Update README/workflow steps with screenshots and known operational prerequisites.
- [ ] Review branch against this spec, fix critical/important findings with RED→GREEN tests, rerun affected/full gates, and commit final fixes.
