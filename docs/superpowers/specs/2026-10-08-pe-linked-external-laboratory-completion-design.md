# PE-Linked External Laboratory Completion Design

**Date:** 2026-10-08  
**Status:** Implementation specification; application changes are pending.  
**Repository:** https://github.com/Eida27/medclinic-scheduler-v2  
**Reviewed baseline:** `main` at `9dba421504a1488238ec6b78fdf233e78e23a723`.  
**Deployment assumption:** First deployment has not occurred; the database is completely fresh.  
**Implementation plan:** [PE-linked external Laboratory completion](../plans/2026-10-08-pe-linked-external-laboratory-completion.md).

## 1. Agreed outcome

CPU Clinic staff should complete a student's Physical Examination (PE) through the existing completion form and certificate workflow without first performing separate checkbox updates for tests conducted at Iloilo Mission Hospital (IMH).

The user explicitly selected **Option A**: fourth-year **OJT** students must have CBC, Urine, and Stool verified at KABALAKA before PE can be completed. PE completion then confirms their IMH X-ray and completes the paired Laboratory appointment. First-Year/OVPSA students have all four external tests and their Laboratory appointment completed automatically with PE.

The automatic update records the authorized CPU actor's confirmation of external requirements. It is not an integration with IMH or an independent determination that a hospital performed a test. The existing required PE attestation must describe the external tests being confirmed.

| Immutable appointment context | Manual verification before PE | Confirmation during successful PE completion | Final clinical state |
| --- | --- | --- | --- |
| Fourth-year OJT | CBC, Urine, Stool; Admin or KABALAKA-assigned Clinic Staff | X-ray at IMH; Admin or CPU-assigned Clinic Staff | Laboratory 4/4 and COMPLETED; PE COMPLETED with issued JPG certificate |
| First-Year/OVPSA with valid external provenance | None | CBC, Urine, Stool, X-ray at IMH; Admin or CPU-assigned Clinic Staff | Laboratory 4/4 and COMPLETED; existing OVPSA external summary and external Laboratory result completed; PE COMPLETED with issued JPG certificate |
| Other supported students, including fourth-year Regular/Tour | Existing applicable checklist | No automatic test confirmation | Existing completed-Laboratory prerequisite and PE certificate workflow |

Only fourth-year **OJT**, not every fourth-year student, receives this X-ray behavior.

## 2. Repository findings and the required change

| Current file or contract | Verified behavior | Change |
| --- | --- | --- |
| `src/server/laboratory/laboratory-requirements.ts` | Already requires X-ray for year 1 and year 4 OJT | Keep the required test sets; add a separate completion policy |
| `src/server/laboratory/laboratory-checklist.repository.ts` | Stores immutable year/category snapshots and links the same checklist across Laboratory replacements | Read those snapshots and expose the completion policy in the checklist response |
| `src/server/laboratory/laboratory-checklist.service.ts` | Every required item can be manually verified; completing an OVPSA checklist writes its external summary; ordinary completion creates a pending-upload placeholder | Reject manual changes to PE-managed items; extract reusable transaction-local external finalization |
| `src/server/medical-certificates/physical-exam-completion-context.service.ts` | Blocks the form until Laboratory is COMPLETED, every item is verified, and an OVPSA summary exists | Report policy-specific PE readiness separately from current Laboratory completion |
| `src/server/medical-certificates/certificate.service.ts` | The same full-Laboratory gate protects preview, issuance and correction; issuance renders outside the final transaction and then revalidates | Plan the permitted external changes without writing, then apply them only inside successful issuance |
| `src/components/appointments/AppointmentDetail.tsx` | First-year PE detail currently permits one-test-at-a-time external verification | Make that paired checklist read-only and explain automatic confirmation |
| `src/components/appointments/LaboratoryChecklist.tsx` | Read-only applies to the entire checklist | Add per-test behavior for OJT and whole-checklist read-only behavior for first years |
| Migrations `019` and `028` | Existing tables support EXTERNAL sources, unique OVPSA verification, immutable events, checklist versions and deferred clinical consistency | Reuse them without weakening constraints or adding schema |
| `src/server/repositories/appointment-no-show.repository.ts` | Excludes OVPSA Laboratory and protects any recorded Laboratory progress | Preserve and test these behaviors |

The current gate would create a circular workflow: the system requires X-ray/all external tests before the very PE action intended to confirm them. Replace that gate with an explicit policy; do not temporarily set fake completion flags.

## 3. Global constraints

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

## 4. Completion policy and readiness

Introduce `src/shared/laboratory-completion.ts` for common types and `src/server/laboratory/laboratory-completion-policy.ts` for the pure policy resolver.

The resolver takes `yearLevel`, `schedulingCategory` and a server-derived `isOvpsaFirstYear` flag. Use the checklist's `year_level_snapshot` and `scheduling_category_snapshot`, not the student's mutable current year, a client field or a display label.

Define these exact modes and policy fields:

```ts
type PeLaboratoryMode = "STANDARD" | "FOURTH_YEAR_OJT" | "FIRST_YEAR_EXTERNAL";
type LaboratoryTestCode = "CBC" | "URINE" | "STOOL" | "XRAY";
type LaboratoryCompletionPolicy = {
  mode: PeLaboratoryMode;
  manualTestCodes: LaboratoryTestCode[];
  peConfirmedTestCodes: LaboratoryTestCode[];
  externalProvider: "Iloilo Mission Hospital" | null;
};
```

| Mode | manualTestCodes | peConfirmedTestCodes | externalProvider |
| --- | --- | --- | --- |
| STANDARD | Existing required set | Empty | null |
| FOURTH_YEAR_OJT | CBC, URINE, STOOL | XRAY | Iloilo Mission Hospital |
| FIRST_YEAR_EXTERNAL | Empty | CBC, URINE, STOOL, XRAY | Iloilo Mission Hospital |

Missing/unsupported snapshot data, a year-1 appointment without valid OVPSA lineage, or OVPSA lineage attached to another year must fail closed with `LABORATORY_PROVENANCE_MISSING` (409). There is no fallback to current student data. Validate batch, revision, reservation, student, cycle and paired-appointment ownership when loading the issuance plan.

`PeLaboratoryReadiness` contains `laboratoryAppointmentId`, `laboratoryCompleted`, `readyForPe`, `missingManualTestCodes` and `completionPolicy`. The existing context field `laboratoryReady` becomes an alias of `readyForPe`; use `laboratoryCompleted` to report actual persisted completion.

- STANDARD is ready only when the effective Laboratory appointment is COMPLETED and every required item is verified.
- FOURTH_YEAR_OJT is ready once its three manual tests are verified. An unchecked X-ray and PENDING Laboratory appointment do not block PE.
- FIRST_YEAR_EXTERNAL is ready with valid current external provenance even when all four items are unchecked and Laboratory is PENDING. The OVPSA external-summary row is an output of completion, not a prerequisite.
- Missing pairs/checklists, inactive/replaced/cancelled records, invalid clinic/provenance, closed cycles, unsupported statuses and existing PE blockers remain blockers.
- Already completed Laboratory records must have a complete, valid checklist and any required external summary. Do not silently repair inconsistent completed records.

Preserve current PE status rules: PENDING or an eligible automatic NO_SHOW with its required reason. Do not create a manual-NO_SHOW bypass. External Laboratory is excluded from the automatic no-show sweep as today; partially verified OJT Laboratory stays in progress.

## 5. Manual verification and user experience

The checklist response gains `completionPolicy`. Derived policy is returned consistently by both API-loaded checklists and server-loaded detail props.

For OJT, show four checkboxes. CBC, Urine and Stool remain editable by the existing authorized actors. X-ray remains visible and read-only. Before PE, show **“X-ray at Iloilo Mission Hospital — confirmed when Physical Examination is completed.”** At 3/4 show **“CBC, Urine and Stool verified. Awaiting X-ray confirmation at Physical Examination.”**

For first years, show all four checkboxes read-only. Show **“Laboratory tests at Iloilo Mission Hospital will be confirmed when CPU Clinic completes the Physical Examination.”** Remove the existing instruction and controls for one-test-at-a-time checking on PE detail. After completion the boxes display the saved 4/4 state.

The PATCH checklist endpoint must reject checking **or unchecking** any PE-managed item, including an attempted no-op, with `LABORATORY_TEST_PE_MANAGED` (422): **“This test is confirmed when CPU Clinic completes the Physical Examination.”** Enforce this on the server; disabling a checkbox alone is insufficient. Keep unrelated-clinic/session/onboarding rejection and ordinary correction protections.

Both the PE list dialog and detail form use the same readiness/context contract. OJT blockers name the missing manual tests. The form explains which external tests submission will confirm and extends the existing single mandatory attestation:

- STANDARD: keep current physician-finding attestation.
- OJT: **“I attest that these details match the physician's recorded finding and that the student's X-ray at Iloilo Mission Hospital has been completed.”**
- First year: **“I attest that these details match the physician's recorded finding and that the student's CBC, Urine, Stool and X-ray at Iloilo Mission Hospital have been completed.”**

Keep the existing `attested: true` request field; infer the applicable tests on the server. Add no extra confirmation dialog or upload requirement. Preserve classifications A/B/C/D, required remarks, physician/signature selection, date validation and late-encoding reasons. Completing any supported class confirms the applicable tests; test completion does not imply a Class A finding.

Replace first-year schedule display text `Awaiting External Laboratory Result` with **“Awaiting confirmation at Physical Examination”** in staff and student readers. Keep persisted statuses unchanged. Refresh the list/detail after the server confirms success; do not optimistically check tests while submission is in progress.

## 6. Transaction design

Add `src/server/laboratory/pe-linked-laboratory.service.ts` with a read-only planning function and a transaction-local apply function. Neither creates its own transaction or publicly authorizes general Laboratory changes.

### Preparation and preview

1. Revalidate the CPU actor. Identify the PE student/cycle and acquire the existing sorted effective Laboratory/PE scope locks before calling the pair resolver, which locks appointment rows.
2. Resolve the effective pair, lock its checklist and read immutable provenance and item state.
3. Build `PeLaboratoryCompletionPlan`: readiness, effective Laboratory/checklist identity, observed version, predicted resulting version, pending external test codes, valid OVPSA identity and a stable fingerprint.
4. Enforce current clinical/date/physician/snapshot blockers. The actual examination cannot predate Laboratory, as in the current service. Do not change the scheduled dates or OVPSA separation rules.
5. Prepare the certificate snapshot and release the preparation transaction. Render with the existing renderer.
6. Preview returns only preview bytes. Context reads, previews, invalid forms, rendering failures and cancelled dialogs perform no completion work.

The fingerprint includes effective Laboratory ID/date/status/updated timestamp, checklist ID/version and item verification state, academic snapshot ID/year/category, OVPSA identity and resolved policy. Continue comparing the PE, physician and certificate student/examination snapshots as well. This detects replacement or checkbox changes even when a shared checklist is reused.

### Final issuance transaction

1. Revalidate the CPU actor and existing `requestId`/payload-hash replay checks.
2. Acquire the same sorted service scope locks before pair/checklist locks; recheck request replay after waiting.
3. Reload the plan and certificate context. Reject changed preparation with `EXAMINATION_STALE` (409) before any writes.
4. Apply only pending `peConfirmedTestCodes`. Set `verified_at` to the confirmation timestamp, `verified_by` to the CPU actor and `verification_source='EXTERNAL'`. Keep OJT manual tests' original actor, source and timestamps.
5. Add one immutable `laboratory_checklist_events` row per newly verified item, with EXTERNAL source, actor snapshot and reason **“Iloilo Mission Hospital test confirmed during CPU Physical Examination.”** Increment the checklist version once for the whole automatic update when at least one item changed; do not increment it on replay/no-op.
6. Require all applicable tests to be verified, then set the effective Laboratory appointment to COMPLETED with the existing status-log writer. Record the association with the PE action in the audit.
7. For first years, insert the unique `ovpsa_external_laboratory_verifications` record with the effective Laboratory's validated batch/revision and IMH provider. Preserve an existing valid row. Complete its `laboratory_results` record through the extracted external finalizer; use the Manila confirmation date, not an invented hospital-performance date.
8. For OJT, call existing `ensurePendingUploadResult` after clinical completion. Preserve an existing result/file revision. Do not complete a document upload or create a first-year OVPSA row for OJT.
9. Persist the certificate's immutable examination snapshot, then perform existing certificate issuance, PE status change, `exam_results` completion, certificate audit/event, portal notification/outbox work and clinical-request outcome.
10. Commit only when all steps and deferred constraints succeed. Any failure rolls back Laboratory changes and all issuance-side effects.

Keep the existing successful issuance response shape and actor-scoped idempotency. Same-request retries return the existing certificate without additional checklist events, version bumps, status logs, external summaries or notifications. A reused ID with a different payload remains `CLINICAL_REQUEST_CONFLICT`.

## 7. Evidence and lifecycle

Reuse existing evidence structures; no migration is needed:

- `laboratory_checklist_items.verification_source` remains INTERNAL/EXTERNAL. IMH confirmation uses EXTERNAL even for OJT, whose Laboratory appointment is managed by KABALAKA.
- The certificate's `examination_snapshot` retains `laboratoryAppointmentId` and stores the **post-update** `checklistVersion`. Add `laboratoryCompletion` with `mode`, `checklistId`, `checklistVersionBefore`, `checklistVersionAfter`, `automaticallyVerifiedTestCodes` and `externalProvider`.
- Add audit action `LABORATORY_EXTERNAL_CONFIRMED_DURING_PE` with effective Laboratory ID, PE ID, certificate ID, mode, provider, changed test codes and version transition. Emit it when there is new confirmation work.
- Existing event history and OVPSA verification remain authoritative; do not overwrite previous verifier identity/timestamps to make a retry appear new.
- Certificate correction/its preview does not confirm tests again. It requires the completed valid Laboratory state and preserves the original confirmation linkage in revised snapshots.
- Certificate revocation does not erase confirmed Laboratory evidence, uncheck tests or delete external verification. Preserve current revocation behavior and existing certificate-history protection against manual checklist rollback. Adding a lab-evidence revocation or PE reissuance workflow is outside scope.

The existing deferred invariant that COMPLETED Laboratory equals a fully verified checklist remains intact. The PE result/issued-certificate invariant remains intact. The pending OJT state is genuinely 3/4 until the final transaction; never remove X-ray from its requirements to obtain a 3/3 result.

## 8. Scheduling, documents and access

Reuse the same effective Laboratory checklist through replacements. Confirm only the effective current appointment and preserve predecessor/history rows. Existing partial-progress protection, manual locks and result/certificate protection remain applicable.

First-year external Laboratory continues to consume no KABALAKA internal capacity and retains OVPSA reservations. OJT CBC/Urine/Stool stays in its existing KABALAKA Laboratory booking; X-ray adds no hospital appointment, reservation or capacity charge. Preserve the fresh defaults of 100 for both configured internal services.

First-year external completion creates no student upload draft or file. OJT clinical completion can expose the existing optional document workflow, with email verification still required for upload/edit. It does not make upload a PE prerequisite. Unverified authenticated students retain current schedule/notification/results-reading and authorized certificate-download access.

Existing portal notification and eligible-email outbox work remains part of PE issuance. Do not add duplicate notices per automatically checked test or roll back business completion because asynchronous SMTP later fails.

## 9. Acceptance requirements

| ID | Case | Required evidence |
| --- | --- | --- |
| A1 | Fourth-year OJT with any manual test missing | Context names missing tests; preview/issuance blocked; no Laboratory or certificate writes |
| A2 | OJT with CBC/Urine/Stool verified and X-ray pending | 3/4 PENDING before submission; PE context ready; successful completion produces 4/4, both appointments completed and one certificate |
| A3 | Valid first-year external pair, no boxes checked | PE context ready; preview leaves 0/4 and PENDING; submit produces 4/4, both completed, one external summary/result and one certificate |
| A4 | Manual PATCH of OJT X-ray or any first-year test | Both check/uncheck requests rejected; no version/event/status change |
| A5 | Other years and fourth-year Regular/Tour | Existing manual test sets and full-Laboratory gate preserved |
| A6 | Changed live student year, missing/invalid provenance, wrong batch or pair | Immutable context decides eligibility; malformed provenance fails closed |
| A7 | Coordinator, KABALAKA actor completing PE, deleted/expired/unonboarded staff | Rejected before confirmation or issuance writes; CPU staff cannot manually change OJT CBC |
| A8 | Invalid form, date, inactive physician, preview, render failure or final-write failure | No partial automatic confirmation, certificate, status log, summary, audit or notification |
| A9 | Replay, double click, concurrent same/different requests | At most one successful issuance; no duplicate external events/summary/version bump |
| A10 | Checkbox correction, replacement or no-show racing issuance | Serialized under common locks or stale rejection; only effective pair updated |
| A11 | Certificate correction/revocation | Laboratory confirmation identity, timestamps, version and events preserved |
| A12 | Midnight sweep | External first-year Laboratory excluded; OJT manual progress retained |
| A13 | OJT documents and first-year external result | Upload status remains separate; no fake file/draft; verification and ownership gates preserved |
| A14 | Classes B/C/D and historical records | Classification/remarks rules preserved; completion does not imply Class A; closed-year mutation rejected |
| A15 | Browser reload and student access | Server state persists across list/detail; first-year label clears after completion; authorized student sees completed schedule and JPG certificate |

Run meaningful policy, service, API, UI, database-invariant and concurrency tests. Rehearse on a disposable fresh database with all existing migrations and reference seed; no production-data migration or reset is part of this work.

## 10. Authority and delivery

This specification changes only per-test completion ownership and the corresponding PE prerequisites described above. After implementation it supersedes the September 22 final-defense and September 27 direct-PE documents only where they require manual first-year verification or completed external tests before PE issuance. Other clinical, scheduling, security and certificate policies keep their authority.

At implementation time update `README.md` and `docs/current-policies.md` with this rule and link the new design/plan. Do not describe it as currently deployed before the code and acceptance checks pass.

Deliver the shared policy, transaction-local confirmation helper, changed readiness/API/UI behavior and verification evidence. The present GitHub commit delivers this design and its implementation plan only.
