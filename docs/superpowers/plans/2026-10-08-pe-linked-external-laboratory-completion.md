# PE-Linked External Laboratory Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete first-year IMH laboratory requirements and fourth-year OJT IMH X-ray atomically when CPU Clinic completes PE, while requiring OJT CBC/Urine/Stool beforehand.

**Architecture:** Resolve completion ownership from immutable checklist provenance and use one policy for checklist controls, PE context and issuance. A read-only plan predicts external updates; only the final certificate transaction applies them using current effective-pair locks, existing evidence tables and request replay.

**Tech Stack:** Existing Next.js 16.3.5, React 19.2.4, TypeScript, PostgreSQL/pg, Zod, Vitest and sharp; no upgrades.

**Spec:** [PE-linked external Laboratory completion design](../specs/2026-10-08-pe-linked-external-laboratory-completion-design.md).

**Baseline:** `main` at `9dba421504a1488238ec6b78fdf233e78e23a723`, reviewed 2026-10-08. This is an implementation handoff, not an implementation or passing-test claim.

## Global Constraints

- Treat this as a fresh first deployment; do not infer or backfill clinical facts.
- Use Asia/Manila calendar dates and the existing academic-year boundaries.
- Keep scheduled Laboratory before PE and preserve the First-Year/OVPSA minimum seven-calendar-day gap.
- Preserve the existing CBC/Urine/Stool/X-ray eligibility rules.
- Authorize manual KABALAKA checks and CPU PE completion against the current database staff identity and clinic assignment.
- Commit Laboratory confirmation, PE completion, certificate issuance, audit records and notification work in one database transaction.
- Keep previews and context reads free of clinical, document, audit and notification writes.
- Keep Laboratory clinical completion separate from student document upload status.
- Preserve immutable snapshots, replacement lineage, checklist versions and idempotent clinical requests.
- Add no dependency upgrades, new clinic appointments, new capacity accounting or new database schema.

## Review Focus

1. An older checklist linked through a replacement must use the effective pair and immutable year/category, even after the student's live profile changes; covered by Tasks 1 and 3.
2. A KABALAKA staff session cannot gain CPU authority through the automatic helper, and a CPU staff session cannot manually edit OJT CBC; covered by Tasks 2 and 3.
3. A preview, cancelled form or issuance failure must not accidentally verify external tests or create a result placeholder; covered by Tasks 3 and 4.
4. Concurrent checkbox corrections or replacement writes between render and commit must reject stale issuance without duplicate evidence; covered by Tasks 3 and 5.
5. A certificate correction/revocation must not rewrite hospital confirmation or imply that document uploads are complete; covered by Tasks 3 and 6.

## File map and contracts

| File | Responsibility |
| --- | --- |
| Create `src/shared/laboratory-completion.ts` | Shared test-code, policy and readiness types |
| Create `src/server/laboratory/laboratory-completion-policy.ts` | Pure immutable-context policy |
| Modify `src/server/laboratory/laboratory-requirements.ts` | Re-export shared test-code type; preserve required tests |
| Modify `src/server/laboratory/laboratory-checklist.repository.ts` | Read immutable context and add `completionPolicy` to checklist records |
| Modify `src/server/laboratory/laboratory-checklist.service.ts` | Manual PE-managed-item guard and external-finalizer extraction |
| Create `src/server/laboratory/pe-linked-laboratory.service.ts` | Read-only issuance plan and transaction-local external confirmation |
| Modify `src/server/medical-certificates/certificate.service.ts` | Shared readiness, stale comparison, final transaction, immutable linkage |
| Modify `src/server/medical-certificates/physical-exam-completion-context.service.ts` | Same policy-specific readiness and blockers |
| Modify `src/components/appointments/LaboratoryChecklist.tsx` | Per-test read-only controls and pending-external copy |
| Modify `src/components/appointments/PhysicalExamCompletionForm.tsx` | Typed readiness and contextual mandatory attestation |
| Modify `src/components/appointments/AppointmentDetail.tsx` | Read-only paired external checklist and matching instructions |
| Modify `src/server/repositories/appointments.repository.ts` and `src/server/repositories/student-portal.repository.ts` | First-year awaiting-confirmation display label |
| Create `scripts/browser-pe-linked-laboratory-fixture.ts` | Guarded synthetic setup/status/cleanup for browser acceptance |
| Modify `package.json` | New acceptance fixture commands only |
| Modify `README.md` and `docs/current-policies.md` | Implemented policy and narrow supersession links |

Use `LaboratoryCompletionPolicy` and `PeLaboratoryReadiness` exactly as defined in the spec. The shared mode variants are `STANDARD`, `FOURTH_YEAR_OJT` and `FIRST_YEAR_EXTERNAL`. Extend `LaboratoryChecklistRecord` and frontend checklist views with `completionPolicy`. Keep `PhysicalExamCompletionContext.laboratoryReady` as the `readyForPe` alias and add `laboratoryCompletion: PeLaboratoryReadiness`. Retain existing request/issuance response shapes.

Internal contracts in `pe-linked-laboratory.service.ts`:

```ts
type PeLaboratoryCompletionPlan = PeLaboratoryReadiness & {
  checklistId: string;
  checklistVersionBefore: number;
  checklistVersionAfter: number;
  automaticallyVerifiedTestCodes: LaboratoryTestCode[];
  ovpsaBatchId: string | null;
  ovpsaRevisionId: string | null;
  fingerprint: string;
};
type PeLaboratoryCompletionOutcome = {
  laboratoryAppointmentId: string;
  checklistVersion: number;
  automaticallyVerifiedTestCodes: LaboratoryTestCode[];
};
```

- `loadPeLaboratoryCompletionPlan(client: PoolClient, peAnchor: EffectivePairAnchor): Promise<PeLaboratoryCompletionPlan>`: caller authorizes CPU and locks both effective service scopes first. The loader resolves the current pair/checklist, validates provenance and predicts only allowed automatic changes. It writes nothing.
- `applyPeLinkedLaboratoryCompletion(client: PoolClient, plan: PeLaboratoryCompletionPlan, context: { actor: SessionUser; actorFullName: string; physicalExamAppointmentId: string; certificateId: string; examinationDate: string }): Promise<PeLaboratoryCompletionOutcome>`: caller has just reloaded/revalidated the plan under the final issuance locks. It uses the supplied transaction only.
- `completeExternalLaboratoryWithClient(client: PoolClient, appointmentId: string, actorUserId: string): Promise<void>`: extract the existing private external finalizer from `laboratory-checklist.service.ts` into the new module. Preserve existing identity checks and make valid repeated summary/result finalization nonduplicating. Both modules may import it; the new module must not import the checklist service and create a cycle.

The `examinationDate` in the apply context identifies the PE record; it is not the hospital test-performance date. Record confirmation using the server timestamp and Manila confirmation date as specified.

---

### Task 1: Define completion ownership from immutable provenance

**Files:** Create the shared types, policy module and `src/server/laboratory/laboratory-completion-policy.test.ts`. Modify the requirements and checklist repository files above. Extend `laboratory-requirements.test.ts` where needed.

**Interfaces:** Produce `resolveLaboratoryCompletionPolicy(context: { yearLevel: number | null | undefined; schedulingCategory: string | null | undefined; isOvpsaFirstYear: boolean }): LaboratoryCompletionPolicy` and checklist `completionPolicy`. Consume existing `requiredLaboratoryTests`.

- [ ] **Step 1: Write policy tests with exact outputs.** Cover first-year valid OVPSA, fourth-year OJT, fourth-year Regular/Tour, other supported years, and invalid/missing provenance. Example assertion:

```ts
expect(resolveLaboratoryCompletionPolicy({
  yearLevel: 4, schedulingCategory: "OJT", isOvpsaFirstYear: false,
})).toEqual({
  mode: "FOURTH_YEAR_OJT",
  manualTestCodes: ["CBC", "URINE", "STOOL"],
  peConfirmedTestCodes: ["XRAY"],
  externalProvider: "Iloilo Mission Hospital",
});
```

- [ ] **Step 2: Run the new policy tests and record the expected missing-module/function failure.** Run `npm test -- src/server/laboratory/laboratory-completion-policy.test.ts`.
- [ ] **Step 3: Implement the shared types and resolver.** STANDARD keeps the existing required set; first year without valid OVPSA and OVPSA on another year throw `LABORATORY_PROVENANCE_MISSING` (409).
- [ ] **Step 4: Extend the checklist query/record.** Select immutable checklist year/category and the linked appointment's complete OVPSA identity; derive policy from these values. Preserve versions, item sources and replacement links.
- [ ] **Step 5: Add a repository integration assertion in `laboratory-checklist.integration.test.ts`.** Alter a fixture student's live year after snapshot creation and assert the checklist's OJT policy/required XRAY is unchanged; a replacement shares the same policy.
- [ ] **Step 6: Verify.** Run `npm test -- src/server/laboratory/laboratory-completion-policy.test.ts src/server/laboratory/laboratory-requirements.test.ts` and `npm run test:integration -- src/server/laboratory/laboratory-checklist.integration.test.ts`. Require all selected tests to pass.
- [ ] **Step 7: Commit this policy/DTO change.** Suggested message: `feat: define PE-managed external laboratory tests`.

### Task 2: Protect PE-managed items from manual PATCH

**Files:** Modify `laboratory-checklist.service.ts`. Extend `laboratory-checklist.integration.test.ts` and `src/app/api/appointments/[appointmentId]/laboratory-checklist/route.test.ts`. Create the new PE-linked service module for the extracted external finalizer.

**Interfaces:** Consume Task 1's policy. Produce `completeExternalLaboratoryWithClient` with the contract above and unchanged `setLaboratoryTestVerification` request/return shapes.

- [ ] **Step 1: Write failing integration tests.** Build first-year fixtures using `acceptAndScheduleImport` with valid FIRST_YEAR_OVPSA provenance, following `first-year-schedule-import.integration.test.ts`. For OJT XRAY and each first-year test, submit both `checked: true` and `checked: false` and assert `LABORATORY_TEST_PE_MANAGED`/422 plus unchanged item state, version, events and appointment. Add the explicit CPU-staff/OJT-CBC forbidden assertion.
- [ ] **Step 2: Run `npm run test:integration -- src/server/laboratory/laboratory-checklist.integration.test.ts`.** Confirm new PE-managed tests fail under current manual behavior.
- [ ] **Step 3: Enforce the per-test guard after current actor/pair validation and before no-op return or any mutation.** Preserve normal manual verification, version conflict, automatic-no-show reason, protected-result and certificate-history rules.
- [ ] **Step 4: Extract the external finalizer.** Validate effective appointment's batch/revision/provider; use the unique appointment verification record without replacing previous identity. Preserve existing result status protection and completion semantics. Import the helper back into the checklist service while avoiding circular imports.
- [ ] **Step 5: Update endpoint tests for the domain error.** Expect 422 and the spec's exact error message; keep actor/UUID checks unchanged.
- [ ] **Step 6: Verify the selected integration and route tests.** Run the integration command from Step 2 and `npm test -- "src/app/api/appointments/[appointmentId]/laboratory-checklist/route.test.ts"`.
- [ ] **Step 7: Commit.** Suggested message: `fix: reserve external test confirmation for PE completion`.

### Task 3: Plan and apply external confirmation in PE issuance

**Files:** Complete `pe-linked-laboratory.service.ts`; modify the certificate and PE-context services. Create `src/server/laboratory/pe-linked-laboratory.integration.test.ts` and `src/server/medical-certificates/physical-exam-completion-context.service.test.ts`; extend `certificate.integration.test.ts` and `certificate-replay.test.ts`.

**Interfaces:** Consume Task 1 policy and Task 2 finalizer. Produce the plan/apply contracts above and `laboratoryCompletion` on completion context. Preserve `completePhysicalExam`, preview/correction/revocation signatures and issuance outcome.

- [ ] **Step 1: Build coherent synthetic test fixtures.** Reuse `insertTestScheduleImportGroup`, `insertTestStudent` and `linkPublishedLaboratoryAppointments` for OJT. Use `acceptAndScheduleImport` with FIRST_YEAR_OVPSA input, following `first-year-schedule-import.integration.test.ts`, for complete first-year provenance. Control the test clock for valid import and later examination dates; restore it in cleanup. Create active physician signatures as existing certificate tests do.
- [ ] **Step 2: Write failing readiness/issuance tests.** Assert OJT 3/4 PENDING is ready and first-year 0/4 PENDING is ready, while every missing OJT manual code blocks. Assert first-year readiness does not require an external summary yet. Preview must leave the exact pre-call clinical/evidence/result/notification counts unchanged.
- [ ] **Step 3: Run `npm run test:integration -- src/server/laboratory/pe-linked-laboratory.integration.test.ts src/server/medical-certificates/certificate.integration.test.ts`.** Confirm the new successful-external cases fail at the old full-Laboratory gate.
- [ ] **Step 4: Implement the read-only planner.** Validate the effective pair, checklist snapshots, clinic and OVPSA batch/revision/reservation ownership. Predict `checklistVersionAfter = checklistVersionBefore + 1` when at least one external item is pending, otherwise keep the version. Reject inconsistent already-COMPLETED records. Fingerprint the identities/state specified in the design.
- [ ] **Step 5: Replace duplicated readiness gates.** Context, preview and initial issuance preparation use the planner. Acquire sorted effective scopes before any resolver/checklist row locks, including preparation/context paths. Keep all existing date/status/cycle/student/physician blockers. Correction mode still requires completed valid Laboratory and copies the prior certificate revision's `laboratoryCompletion` metadata unchanged instead of regenerating a no-op confirmation snapshot.
- [ ] **Step 6: Implement the transaction-local apply function.** Verify only pending external items; add per-item EXTERNAL events; bump once; complete the effective Laboratory with its status log. First year uses the extracted summary/result finalizer. OJT uses `ensurePendingUploadResult` and never receives an OVPSA summary. Return the actual version and changed codes.
- [ ] **Step 7: Integrate apply into final issuance after stale/replay validation and before certificate snapshot persistence.** Compare the plan fingerprint along with existing context comparisons. Assert the applied version equals the predicted version. Save the spec's post-update snapshot linkage and audit, then retain PE/result/certificate/notification/request writes in that same transaction. STANDARD does no automatic Laboratory writes.
- [ ] **Step 8: Add failure and authority tests.** Assert zero partial effects for render failure and a forced error after confirmation begins; invalid date/class/physician/provenance; closed cycle; Coordinator, KABALAKA staff and expired/deleted/unonboarded actor. For successful Class B/C/D retain remarks rules and EXTERNAL confirmation.
- [ ] **Step 9: Add replay and lifecycle assertions.** Identical retries preserve certificate bytes and add no events/version/log/summary/notification; changed payload reusing requestId conflicts. Correction, correction preview and revocation preserve Laboratory verifier timestamps/version/events. OJT result remains PENDING_UPLOAD, first-year result is COMPLETED with no draft/files.
- [ ] **Step 10: Verify.** Run the selected integration command from Step 3 plus `npm test -- src/server/medical-certificates/physical-exam-completion-context.service.test.ts src/server/medical-certificates/certificate-replay.test.ts`. Require success and inspect persisted post-update snapshot/version and unique external-summary rows.
- [ ] **Step 11: Commit.** Suggested message: `feat: confirm IMH laboratory tests during PE issuance`.

### Task 4: Expose one consistent staff workflow

**Files:** Modify `LaboratoryChecklist.tsx`, `PhysicalExamCompletionForm.tsx` and `AppointmentDetail.tsx`. Extend checklist/form/dialog tests and `src/app/(dashboard)/physical-exam/[appointmentId]/page.test.tsx`. Extend `src/app/api/appointments/[appointmentId]/physical-exam-completion-context/route.test.ts`. Create `src/app/api/appointments/[appointmentId]/complete-physical-exam/route.test.ts` and `src/app/api/appointments/[appointmentId]/physical-exam-certificate-preview/route.test.ts`.

**Interfaces:** Consume checklist `completionPolicy` and `PhysicalExamCompletionContext.laboratoryCompletion`. Use existing dialog-to-form flow; no new endpoint or request field.

- [ ] **Step 1: Write failing UI tests.** OJT has four boxes with only X-ray disabled; first year has four disabled boxes. Assert the spec's exact explanatory text. Clicking PE-managed tests sends no PATCH; manual OJT checks still send the versioned PATCH.
- [ ] **Step 2: Run `npm test -- src/components/appointments/LaboratoryChecklist.test.tsx src/components/appointments/PhysicalExamCompletionForm.test.tsx src/components/appointments/PhysicalExamCompletionDialog.test.tsx`.** Confirm new policy/copy assertions fail before implementing controls.
- [ ] **Step 3: Implement checklist controls.** Apply both whole-view permission/readOnly and policy-based per-item restrictions. Missing policy must not expose editable external controls; show a load error until valid server context exists.
- [ ] **Step 4: Update detail and completion form.** Make paired Laboratory read-only on every PE detail, remove manual first-year instructions, and render the relevant single attestation/external-test summary. Keep existing form validation, busy state, uncertain-response same-request retry, JPG preview and successful refresh.
- [ ] **Step 5: Add list/detail and cancellation assertions.** Both paths allow eligible OJT/first-year PE, expose missing manual blockers, and do not optimistically change boxes. Closing the dialog or clicking preview sends no checklist PATCH or completion POST.
- [ ] **Step 6: Test route contracts.** Completion preserves current dataResponse/outcome and private/no-store; preview returns only private JPEG bytes; context exposes readiness without adding signature bytes or mutations. Keep UUID and Admin/Clinic Staff guards.
- [ ] **Step 7: Verify the UI and route suites.** Run the Step 2 command and `npm test -- "src/app/(dashboard)/physical-exam/[appointmentId]/page.test.tsx" "src/app/api/appointments/[appointmentId]/physical-exam-completion-context/route.test.ts" "src/app/api/appointments/[appointmentId]/complete-physical-exam/route.test.ts" "src/app/api/appointments/[appointmentId]/physical-exam-certificate-preview/route.test.ts"`.
- [ ] **Step 8: Commit.** Suggested message: `feat: show PE-managed hospital tests in clinical workflows`.

### Task 5: Prove replacement, concurrency and existing database invariants

**Files:** Extend `pe-linked-laboratory.integration.test.ts`, `laboratory-checklist.integration.test.ts`, `src/server/services/appointments-locking.integration.test.ts` and `src/server/db/final-defense-schema.integration.test.ts`. Do not add a migration.

**Interfaces:** Exercise the public checklist/PE services and existing replacement/no-show operations against a disposable migrated database.

- [ ] **Step 1: Add effective-lineage tests.** Replace an eligible Laboratory appointment with the same checklist and verify the old ID cannot receive confirmation; the new effective pair alone completes. Cover valid current first-year reservation ownership and a wrong-revision pairing.
- [ ] **Step 2: Add deterministic race tests using synchronization barriers, not timing sleeps.** Pause issuance after rendering; uncheck one manual OJT test or replace an appointment in another transaction; resume issuance and expect `EXAMINATION_STALE` with no automatic effects.
- [ ] **Step 3: Add concurrent-request tests.** Same actor/request/payload returns one outcome; competing distinct requests yield at most one issuance and one set of external item events. Include a no-show sweep racing OJT checks and verify recorded progress cannot become NO_SHOW.
- [ ] **Step 4: Extend schema assertions.** At commit, COMPLETED Laboratory requires all four tests for these contexts, PE requires its one issued certificate/result, and OVPSA summary remains unique. Assert an independent direct status-only completion still fails existing constraints. Retain immutable history checks.
- [ ] **Step 5: Run `npm run test:integration -- src/server/laboratory/pe-linked-laboratory.integration.test.ts src/server/laboratory/laboratory-checklist.integration.test.ts src/server/services/appointments-locking.integration.test.ts src/server/db/final-defense-schema.integration.test.ts`.** Require every scenario to pass without disabling constraints in the behavior under test.
- [ ] **Step 6: Commit the meaningful regressions.** Suggested message: `test: verify atomic PE laboratory confirmation and races`.

### Task 6: Verify visible state, fresh installation and policy documentation

**Files:** Modify the staff/student appointment readers, `README.md`, `docs/current-policies.md` and `package.json`. Extend `src/server/repositories/appointments.repository.test.ts`, `src/server/laboratory/pe-linked-laboratory.integration.test.ts` and `src/server/services/student-result-submissions.integration.test.ts`. Create the guarded browser fixture and `docs/superpowers/evidence/2026-10-08-pe-linked-external-laboratory-completion.md` with actual executed results.

**Interfaces:** Current appointment/result readers consume persisted completion. Fixture supports `setup`, `status` and `cleanup`; package commands are `acceptance:pe-linked-laboratory:setup`, `acceptance:pe-linked-laboratory:status` and `acceptance:pe-linked-laboratory:cleanup`, each invoking `tsx --env-file=.env.local scripts/browser-pe-linked-laboratory-fixture.ts <action>`.

- [ ] **Step 1: Add reader/document tests.** Use `getStudentPortalSchedule(studentNumber)` against the migrated database to assert the exact first-year awaiting-confirmation label before PE and saved COMPLETED after, together with the staff appointment reader. OJT clinical completion does not finalize a document or bypass verified-email/ownership upload gates. First-year completion creates no upload draft/file. Preserve unverified authenticated reading and authorized certificate downloads.
- [ ] **Step 2: Update both first-year display-label SQL expressions.** Replace `Awaiting External Laboratory Result` with the spec's exact new label in both staff readers and the student portal.
- [ ] **Step 3: Create the synthetic browser fixture.** Use complete import/snapshot/OVPSA provenance, runtime Manila dates, valid one-day ordinary/seven-day first-year separation, and active physician profiles. Include an OJT missing-manual case, OJT 3/4-ready case, first-year 0/4-ready case and an ordinary control. Require `BROWSER_PE_LINKED_ACCEPTANCE_LOCAL_TEST_DB=1`, a named loopback test database and matching saved database identity for cleanup; follow existing fixture protections. Add only its package scripts.
- [ ] **Step 4: Run browser acceptance on the disposable local instance.** As KABALAKA staff check OJT CBC/Urine/Stool; observe disabled X-ray and 3/4 PENDING. As CPU staff verify OJT/first-year PE list and detail readiness, preview unchanged state, and submit Class A plus a remarked B/C/D case. Reload Laboratory/PE and inspect persisted evidence through fixture status.
- [ ] **Step 5: Verify student and scheduling effects.** Log in as the affected student, see completed appointments and download the correct private JPG. Confirm no unexpected draft/file, extra hospital appointment, capacity charge or duplicate notification. Confirm ordinary controls retain their old prerequisite.
- [ ] **Step 6: Update current documentation after behavior passes.** Record these rules and narrow supersession of September 22/27 external-test prerequisites. Keep unrelated policies and fresh capacity defaults. Add executed command results, synthetic screenshots/state evidence and unresolved limitations to the evidence document; never mark unexecuted checks as passed.
- [ ] **Step 7: Run final gates once after the last code change.** Run `npm test`, `npm run test:integration`, `npm run test:migrations:empty`, `npm run lint`, `npx tsc --noEmit` and `npm run build`. Supply the existing test-runner PostgreSQL configuration and use its disposable-database harness; do not point tests or resets at a user's working database.
- [ ] **Step 8: Clean up the browser fixture and verify status.** Cleanup only the saved matching synthetic fixture; retain necessary acceptance artifacts.
- [ ] **Step 9: Commit.** Suggested message: `docs: record PE-linked laboratory completion acceptance`.

## Execution notes and completion gate

Read both this plan and its spec before implementation. Follow root `AGENTS.md` and read the installed Next.js guide before modifying framework code. Inspect baseline drift and map names to current files without reverting another person's changes.

`scripts/test-integration.ts` passes path filters through to Vitest and creates/migrates/seeds a disposable database. Use the commands above rather than direct integration runs against application data. Because there is no schema change, keep the existing migration ledger and trigger inventory intact.

Stop implementation completion claims until A1–A15 in the spec have corresponding verified evidence, all final gates pass and the user-visible workflow has been exercised. A documentation-only commit does not establish these results.

Implementation is a separate task. This handoff does not implement, deploy or publish the revised application.
