# Fresh whole-branch review

Reviewer: `/root/final_branch_review`, GPT-6 Astra, fresh context, read-only review.
Compared main `22020b36b13fdb2b90a6e80cccdd7e5027ffc53a` with `0c4a19543b641af1244fa3b9628e2bf12fa9b450`.
Package: `review-22020b3..0c4a195.diff` (609987 bytes). This report preserves the returned findings and scope decisions in concise form.

Strengths: immutable checklist policy and effective lineage; current database authorization; planning without writes and atomic final issuance; fingerprint revalidation and real concurrency barriers; correction metadata preservation; honest distinction between historical failed runs and the six passing final gates.

## Important findings (parent graded by concrete user impact)

1. **OVPSA cancellation lock inversion (Important, P2).** The PE planner takes `FOR SHARE OF b,r,m,ms,ls,ps` after student service scopes and appointment locks. Cancellation takes batch/revision and membership locks before the same student scopes. A concurrent cancellation and PE context/issuance can deadlock with PostgreSQL `40P01`; the transaction wrapper does not retry. Establish a common scheduling lock before student scopes, retain final provenance revalidation, and reproduce actual service concurrency with real database locks.
2. **Completed certificates become uncorrectable after batch cancellation (Important, P2).** The shared planner requires current published revisions, unreleased memberships and active reservations even for correction. Cancellation deliberately preserves completed appointments and clinical history while cancelling the batch and releasing membership/reservations. Correction preview and correction then fail `LABORATORY_PROVENANCE_MISSING` despite valid saved evidence. Distinguish new-issuance active provenance from completed historical ownership, preserving the original confirmation metadata, summary and result. Add issuance -> cancellation -> correction preview/correction coverage with unchanged Laboratory evidence.

Critical: none. Minor: none. No deferred minor findings.
Ready to merge at review time: no, until the two Important findings are fixed and verified.
One combined TDD fix pass is authorized by the execution protocol. No second whole-branch review will be requested.

## Reviewer declined to judge

1. Hosted/Linux execution, deployment readiness and SMTP delivery are outside this local review/evidence.
2. Real hospital performance is authorized staff attestation, not independent hospital verification.
3. Historical migration/backfill is outside the approved fresh first-deployment assumption.
4. Whether the actual examination must occur on/after its scheduled PE date is an existing business rule; the change preserves the existing actual-date contract.
5. Runtime reproduction of the two findings was prohibited by the read-only review; the findings were based on reachable source and SQL lock order.

## Implementer resolution after the review

Both Important findings were reproduced and fixed together in one TDD pass on source `9ed5731f02d0040bca58d7f3c5a4d66aeae371da`. Three actual cancellation-versus-PE service cases reproduced `40P01`; issuance -> cancellation -> correction preview reproduced `LABORATORY_PROVENANCE_MISSING`. All four passed after the fix, followed by 62 focused clinical/OVPSA tests, six focused unit tests, authenticated Browser correction acceptance and all six fresh final gates (630 integration tests, 1,276 unit tests, empty migration, lint, production build, typecheck). Laboratory evidence and original confirmation metadata remained unchanged. See the linked primary evidence document and raw RED/GREEN/gate outputs. No second whole-branch review was performed and no Minor findings were deferred.
