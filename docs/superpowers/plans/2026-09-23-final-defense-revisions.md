# Final Defense Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Implement the five final defense workflows as one coherent clinical and scheduling system.

**Architecture:** PostgreSQL holds immutable checklist and certificate records with deferred integrity checks. Focused services own clinical transitions, bulk replacement, occupancy, and year visibility; existing scheduling locks, notifications, and authentication remain authoritative. UI controls call strict dedicated APIs and display server state.

**Tech Stack:** Next.js 16.3.5, React 19.2.4, PostgreSQL/pg, Zod 4, Vitest, sharp 0.35.4.

**Spec:** `docs/superpowers/specs/2026-09-22-final-defense-revisions-design.md`

## Global Constraints

- A checked Laboratory test means clinic staff confirmed completion or verified an external result. Uploading a document does not check a test.
- Staff enter the physician finding and certificate details in one completion form; one successful save completes examination and releases the JPG. Never default to Class A.
- Bulk replacement uses one service, clinic, academic year, and chosen date; preview conflicts/capacity before one atomic save.
- Fresh clean database is the deployment assumption. Migration 028 must fail explicitly on preexisting clinical data requiring inferred results.
- Keep ADMIN and assigned CLINIC_STAFF clinical authority; COORDINATOR gains none.
- Store final immutable JPEG bytes in PostgreSQL and keep medical content out of generic notifications and audit metadata.
- Academic year ends after closing_date in Asia/Manila; preserve authorized history and downloads.
- Preserve existing Laboratory document lifecycle, OVPSA batch ownership, scheduling locks, and notification contracts.

## Review Focus

1. A Laboratory checklist corrected after PE issuance must be blocked by a test in Task 2.
2. A certificate retry after a lost response must return the same immutable issue, covered in Task 4.
3. A successful bulk replacement replay after token expiry must return saved IDs after authorization, covered in Task 6.
4. A filtered calendar with hidden capacity holds must still show full/held capacity, covered in Task 7.
5. A current PE in a later academic cycle must never pair with prior year's completed Laboratory, covered in Task 8.

---

### Task 1: Database foundation and shared predicates

**Files:**
- Create: `database/migrations/028_final_defense_clinical_workflows.sql`
- Create: `src/server/laboratory/laboratory-requirements.ts`
- Create: `src/server/appointments/academic-year-visibility.ts`
- Create: `src/server/schedule/scheduling-occupancy.repository.ts`
- Modify: `scripts/db-migration-empty-database-test.ts`
- Test: `src/server/laboratory/laboratory-requirements.test.ts`, `src/server/db/final-defense-schema.integration.test.ts`

**Interfaces:**
- Produces `requiredLaboratoryTests({yearLevel, schedulingCategory}): LaboratoryTestCode[]`.
- Produces `assertOpenAppointmentCycle(client, cycleStart, now): Promise<void>` and `getInternalOccupancy(client, date, clinicId, service): Promise<number>`.
- Migration creates checklist, item, appointment-link, event, physician/profile revision, certificate revision, and clinical mutation request tables.

- [ ] Write requirements tests: year 1 and fourth-year OJT include XRAY; years 2/3 and fourth-year Regular/Tour omit it; missing provenance throws.
- [ ] Run `npm.cmd test -- src/server/laboratory/laboratory-requirements.test.ts --run`; expected RED because the module does not exist.
- [ ] Implement the pure requirements module and migration 028 with immutable identity constraints, linkage, partial unique issued certificate, supported enums, clinical data guard, and deferred consistency triggers; update the migration rehearsal count to 28.
- [ ] Run the requirements test and `npm.cmd run test:migrations:empty`; expected GREEN, 28 migrations first pass and 0 second pass.
- [ ] Commit `feat: add final-defense clinical schema and shared predicates`.

### Task 2: Laboratory checklist lifecycle and completion bypass removal

**Files:**
- Create: `src/server/laboratory/laboratory-checklist.repository.ts`, `src/server/laboratory/laboratory-checklist.service.ts`, `src/components/appointments/LaboratoryChecklist.tsx`, `src/app/api/appointments/[appointmentId]/laboratory-checklist/route.ts`
- Modify: `src/server/services/appointments.service.ts`, `src/server/ovpsa/external-laboratory-verification.service.ts`, `src/server/repositories/appointment-no-show.repository.ts`, replacement writers, schedule lists/detail pages.
- Test: `src/server/laboratory/laboratory-checklist.integration.test.ts`, relevant route/component and no-show tests.

**Interfaces:**
- Consumes Task 1 tables, requirement codes, open-cycle and scope locks.
- Produces `setLaboratoryTestVerification(appointmentId, raw, actor)` and `getLaboratoryChecklist(appointmentId, actor)`.
- Produces one authoritative versioned checklist per root Laboratory lineage.

- [ ] Write failing integration tests for exact required items, internal/external permissions, partial progress, final-item completion, stale version, same-lineage replacement, new-cycle reset, downstream rollback protection, and no-show race.
- [ ] Run the focused tests; expected RED on missing checklist service.
- [ ] Implement publication linkage, replacement propagation, PATCH transaction, events, derived completion and external summary; preserve partial work through valid manual movement and route automatic displacement to Manual Resolution.
- [ ] Replace quick-status UI with accessible checkboxes and PE progress/read-only action; reject `status=COMPLETED` and `quickStatusAction` at old route/service boundaries and remove obsolete component/tests.
- [ ] Run focused integration/component/API tests, then the serialized suite; expected GREEN and no completion bypass.
- [ ] Commit `feat: verify laboratory tests through lineage checklists`.

### Task 3: Physician configuration and deterministic certificate rendering

**Files:**
- Create: `src/server/medical-certificates/certificate-schema.ts`, `certificate-renderer.ts`, physician repository/service, Administrator settings page/routes.
- Modify: `package.json`, `package-lock.json` to move sharp 0.35.4 into production dependencies.
- Test: certificate schema, renderer, profile API/UI tests.

**Interfaces:**
- Consumes Task 1 physician tables.
- Produces validated physician revision snapshots and `renderMedicalCertificate(snapshot, mode): Promise<Buffer>`.
- Rendering returns landscape A4 3508x2480 JPEG, 300 DPI, 4:4:4, quality 95, under 8 MiB.

- [ ] Write failing tests for class/remarks/sex/date validation, signature PNG/JPEG limits and metadata removal, long Unicode text overflow, preview watermark, JPEG dimensions/DPI and production dependency use.
- [ ] Run focused tests; expected RED.
- [ ] Implement Administrator-only profile revisions with active catalog, normalized private signature bytes, and escaped/wrapped deterministic layout using bundled fonts. Preview contains no issued number.
- [ ] Run focused tests and production-dependency render smoke test; expected GREEN.
- [ ] Commit `feat: configure physicians and render medical certificates`.

### Task 4: Atomic PE issuance, correction, revocation, and downloads

**Files:**
- Create: `src/server/medical-certificates/certificate.repository.ts`, `certificate.service.ts`, `src/components/appointments/PhysicalExamCompletionForm.tsx`, `src/components/medical-certificates/CertificateDownload.tsx`, dedicated completion/preview/download/revision routes.
- Modify: PE list/detail and student result views, notification builders, generic appointment completion guard.
- Test: certificate service integration, authorization route, form/component tests.

**Interfaces:**
- Consumes Task 2 final checklist, Task 3 renderer/profile snapshots, Task 1 certificate/request tables.
- Produces idempotent `completePhysicalExam`, `correctMedicalCertificate`, `revokeMedicalCertificate`, and authorized immutable-byte download.

- [ ] Write failing tests for missing prerequisite/profile, late encoding, class B/C/D completion, two-phase rollback, duplicate concurrent request, mismatched replay, correction revision, revoke/410, student ownership and staff clinic access.
- [ ] Run focused tests; expected RED.
- [ ] Implement preview validation and rendering; transaction rechecks versions/permissions under locks and writes certificate bytes, appointment/exam result, audit and notification together.
- [ ] Implement one-save form, safe private downloads, correction/revocation history, and historical access.
- [ ] Run focused tests and serialized suite; expected GREEN.
- [ ] Commit `feat: issue immutable examination certificates atomically`.

### Task 5: Remove Physical Examination upload workflow and align projections

**Files:**
- Modify: `src/server/services/student-result-submissions.service.ts`, `src/server/repositories/student-result-submissions.repository.ts`, student/admin result routes/pages, result summaries, reports/export queries.
- Test: forged PE payload, Laboratory regression, results/report tests.

**Interfaces:**
- Consumes Task 4 issued certificate state.
- Produces Laboratory-only document submission and separate PE completion/certificate projections.

- [ ] Write failing tests proving every PE upload/edit/finalize/ZIP path rejects forged appointment IDs without storage writes; Laboratory draft/revision/finalization remains operational.
- [ ] Run focused tests; expected RED on accepted PE paths.
- [ ] Remove PE branches, constrain result_type in migration 028, replace copy and projections with certificate availability and finding labels without equating fitness to completion.
- [ ] Run focused tests, serialized suite and PDF layout inspection for changed Reports output; expected GREEN.
- [ ] Commit `refactor: retire physical-exam result uploads`.

### Task 6: Atomic bulk replacements

**Files:**
- Create: `src/server/appointments/bulk-replacement.service.ts`, preview/commit API routes, `src/components/appointments/BulkReplacementDialog.tsx`.
- Modify: schedule list selection/action wiring and shared replacement linkage.
- Test: service integration, token, API, and UI tests.

**Interfaces:**
- Consumes Tasks 1-2 occupancy, checklist linkage, effective scopes, pair rule, year boundary.
- Produces `previewBulkReplacement` signed 10-minute actor-bound HMAC token and `commitBulkReplacement` idempotent all-or-nothing result.

- [ ] Write failing tests for 1/100/101 IDs, duplicate IDs, exact capacity, one-row conflict rollback, invalid pair order, protected/OVPSA exclusion, request replay after token expiry, forged token, and competing writers.
- [ ] Run focused tests; expected RED.
- [ ] Implement strict schema, canonical payload/token, preview with no writes, sorted lock acquisition, live aggregate revalidation and one transaction for replacements/events/notifications; wire selection and preview UI.
- [ ] Run focused tests and serialized suite; expected GREEN.
- [ ] Commit `feat: preview and save bulk replacements atomically`.

### Task 7: Calendar occupancy and accessible details

**Files:**
- Create: `src/server/services/calendar-occupancy.service.ts`, `src/components/settings/clinic-calendar/CalendarDayDetails.tsx`, `src/app/api/clinic-calendar/occupancy/route.ts`.
- Modify: `src/components/settings/ClinicUnavailableCalendar.tsx`, calendar page heading/navigation.
- Test: occupancy integration, color-state, keyboard/touch component tests.

**Interfaces:**
- Consumes Task 1 shared occupancy and Task 6 scheduling state.
- Produces bounded annual grouped count response with private/no-store cache policy.

- [ ] Write failing tests for zero/green/red/overfull/external-only/unconfigured/closed/reserved dates, distinct students vs appointments, immutable college snapshots, hidden capacity holds, focus/touch details, preserved closure drafts.
- [ ] Run focused tests; expected RED.
- [ ] Implement one bounded query, service-specific used/max, grouped college/service totals, accessible detail popover/legend and 60-second/focus refresh without draft loss.
- [ ] Run focused tests and serialized suite; expected GREEN.
- [ ] Commit `feat: show authoritative calendar capacity and day details`.

### Task 8: Current and historical academic-year views

**Files:**
- Modify: `src/server/repositories/current-effective-appointments.repository.ts`, summary/dashboard/portal/work queue readers, schedule/summary and student pages, no-show worker.
- Test: current/historical repository integration, page/worker tests.

**Interfaces:**
- Consumes Task 1 Manila boundary and Task 4 history/download state.
- Produces CURRENT vs YEAR(startYear) scopes applied before ranking, cycle-specific pair identity, and server-side mutation denial for ended years.

- [ ] Write failing tests for closing date/current next day/closed, browser timezone independence, two active cycles, no cross-year pairing, current list/count consistency, historical report preservation, prior-year portal downloads, and zero-progress sweep vs partial checklist.
- [ ] Run focused tests; expected RED.
- [ ] Apply scope before ranking; expose year selectors and historical labels; refresh open tabs after Manila midnight/focus; block closed-year mutations while retaining authorized history.
- [ ] Run focused tests and serialized suite; expected GREEN.
- [ ] Commit `feat: scope current schedules to open academic years`.

### Task 9: Documentation, browser acceptance, and clean-install rehearsal

**Files:**
- Modify: `README.md`, `docs/installation.md`, `database/README.md`, `docs/e2e.md`, `docs/current-policies.md`, superseded design notes and acceptance fixtures.

**Interfaces:**
- Consumes all previous tasks; no new runtime interface.

- [ ] Update docs/fixtures so fresh installation configures physician, checks tests, issues/downloads certificate, performs bulk replacement, reads calendar and historical years; remove obsolete PE upload and quick-status acceptance.
- [ ] Run lint, TypeScript, build, serialized unit/component suite, disposable integration suite and `npm.cmd run test:migrations:empty`; expected all green with migration count 28 then 0.
- [ ] Use the requested Browser for authenticated real-route verification of staff clinical flows, student download, bulk replacement, calendar details, and ended-year history; inspect DOM/API and console.
- [ ] Render and inspect JPG variants and changed Reports PDF; verify fixture cleanup leaves no shared-DB residue.
- [ ] Review whole branch against the spec, fix material findings, record any remaining limits.
- [ ] Commit `docs: document final-defense workflows and installation`.
