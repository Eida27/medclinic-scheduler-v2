# Student Portal Upload Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Allow active authenticated students to read their portal and download official documents, requiring email verification only for Laboratory upload and editing.

**Architecture:** Keep database-backed authenticated and verified guards distinct. Project official Laboratory files directly into Results without draft initialization. Validate verification continuation against a narrow local path allowlist.

**Tech Stack:** Next.js 16.3.5 App Router, React 19, TypeScript, PostgreSQL, Vitest, private result storage, encrypted email outbox.

**Spec:** `docs/superpowers/specs/2026-09-29-student-portal-upload-email-verification-design.md`

## Global Constraints

- No schema migration, new role, new cookie type, new environment variable, or email-verification backfill is required.
- Retain migrations 001–029; preserve authentication, ownership, clinical eligibility, storage integrity, staff onboarding, outbox and token lifecycle contracts.
- Permit only the exact paths `/student`, `/student/results`, and `/student/results/<UUID>`.
- Missing/rejected return values fall back to `/student`; array values, extra segments, queries, fragments, backslashes and external URLs are rejected.
- Verification failure remains `STUDENT_EMAIL_VERIFICATION_REQUIRED`, HTTP 403, with message “Verify your email address before uploading or updating Laboratory documents.”
- The overview is the read surface; `/student/results/[appointmentId]` remains the upload/edit workspace.
- Use Asia/Manila configured academic-year closing dates and private/no-store download responses.
- Read installed Next.js guides under `node_modules/next/dist/docs/` before editing Next.js code.
- Use test-first changes, focused RED/GREEN runs, and a read-only task review. Run the complete ordinary serialized database-free suite on final code. Keep implementation in this checkout on `codex/student-portal-upload-email-verification`; no merge/push.

## Review Focus

- Pending replacement email must retain existing verified capability.
- A finalized official revision remains readable while its edit draft exists.
- Losing verification in an already-open workspace clears selected files and never replays a mutation.
- A 401 during verification polling stops future polls and provides sign-in navigation.
- Repeated or malicious return parameters cannot redirect outside the exact allowlist.

---

### Task 1: Capability guards, read routes and constrained continuation helper

**Files:**
- Create `src/server/auth/student-page.ts`, adjacent tests, `src/lib/student-verification-return.ts`, adjacent tests.
- Modify `src/server/auth/current-student.ts`, `verified-student-page.ts`, their tests.
- Modify student layout, Schedule and Notifications pages and adjacent tests.
- Modify notification GET/PATCH, result-file GET, certificate-download GET and adjacent tests.
- Extend existing result-submission route tests across GET, files POST/DELETE, edit POST/DELETE, finalize and submit-changes without changing their verified policy.

**Interfaces:**
- Produce `requireStudentPage(): Promise<CurrentStudent>` using the existing active `requireStudent()` and login redirect convention.
- Produce `parseStudentVerificationReturn(value: unknown): string | null`, returning only valid exact paths; `studentVerificationReturn(value: unknown): string`, returning fallback `/student`; `studentVerificationHref(value: unknown): string`, building `/student/email-verification?returnTo=<encoded safe path>`.
- Extend `requireVerifiedStudentPage(returnTo?: unknown)`; omitted argument preserves `/student/email-verification`, supplied argument uses the safe href.

- [x] Write failing behavioral tests: active unverified reading/nav; authenticated notification GET/PATCH/download success; 401 auth failures, scoped calls and existing 404/410/private responses; verified page denial before workspace service. Parameterize return helper allowed paths and malformed/external/encoded/backslash/array/query/fragment forms. Parameterize each write route's denial before body/service/storage work.
- [x] Run focused affected tests with `npm.cmd test -- --run <test paths> --maxWorkers=1 --no-file-parallelism --reporter=dot`; confirm expected failures.
- [x] Implement helper/guard/navigation/read-route changes, preserving error envelopes and domain checks. Refine the 403 text. Retain separate staff/student authentication contracts.
- [x] Run focused tests then `npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot`; expect all passing.
- [x] Self-review, commit task changes, report RED/GREEN commands and final summaries.

### Task 2: Official Laboratory projection and Results overview

**Files:**
- Modify `src/server/repositories/student-result-submissions.repository.ts` and add focused repository integration tests.
- Modify `src/app/(student)/student/results/page.tsx` and adjacent tests.

**Interfaces:**
- Consume Task 1 page guard and safe verification href.
- Produce `listCurrentLaboratoryDocuments(studentNumber: string)` with the same five-field shape as `listHistoricalLaboratoryDocuments()` (submissionId, academicYearStart, appointmentDate, fileId, originalFilename).

- [x] Write failing integration coverage for current/closing-today/historical classification, official revision during edit, and exclusion of discarded/draft/superseded/invalidated/deleted/pending-deletion/foreign/wrong-type records. Snapshot submission/draft activity/status/cleanup state around reads. Verify direct file access and listing agree. Write page tests for unverified current/historical downloads/certificates, empty states and verified/unverified management actions.
- [x] Run focused unit tests and new integration test through documented disposable runner; observe RED.
- [x] Implement read-only projection with submission AND appointment ownership and Laboratory type, FINALIZED and undiscarded submissions, eligible files and configured academic year. Current `closing_date >= Manila today`, historical `< today`. Deterministic year/date DESC, uploaded_at/file ID order. Align accessible download predicates. Do not use draft-preferred lookup.
- [x] Render official current downloads separately from management action; require completed current effective Laboratory eligibility for management. Disable workspace link prefetch; show nonblocking unverified explanation and safe verification entry. Preserve certificate cards/revocation and historical downloads. Do not mount ResultDraftManager.
- [x] Run focused unit/integration tests, typecheck and focused lint; expect green and no read side effects. Carry the complete ordinary serialized unit suite to final code. Self-review and commit.

### Task 3: Workspace interruption, verification return and polling lifecycle

**Files:**
- Modify submission detail page/tests; email-verification page/tests; EmailVerificationForm, EmailVerificationConfirmation and tests; ResultDraftManager and tests.

**Interfaces:**
- Consume Task 1 return helper and optional verified-page guard argument.
- Pass sanitized `returnTo: string` into `EmailVerificationForm`; default `/student` supports existing consumers.

- [x] Write failing tests for guard-before-submission ordering with appointment return path; explicit valid already-verified continuation versus ordinary replacement form; all invalid/array return values. Test five-second status continuation/refresh, unmount cleanup, transient errors, 401 sign-in and stopped polling, no automatic mail request. Test explicit token POST with success portal/original-tab links. Test stale workspace 403 on upload/remove/start-edit/cancel/finalize/submit-changes, selected-file clearing, safe verification action and no replay.
- [x] Run focused tests to expected RED.
- [x] Preserve verified-only workspace entry before service; sanitize route context. Implement page/form continuation and session handling; retain replacement-address behavior and existing token/request lifecycle. Provide Back to schedule. Confirmation stays explicit POST and grants no session.
- [x] Handle verification-required mutation responses across shared mutate handler with safe appointment verification link, stop action and clear selections; no automatic retry or file transfer.
- [x] Run focused tests, typecheck and focused lint; expect green. Carry the complete ordinary serialized unit suite to final code. Self-review and commit.

### Task 4: Active documentation and disposable Browser acceptance fixture

**Files:**
- Update README.md, docs/current-policies.md, docs/installation.md, docs/e2e.md.
- Update student-email fixture expectations as applicable; add guarded synthetic disposable acceptance harness and its focused behavioral tests under scripts/src/test following repository conventions.
- Add evidence document under docs/superpowers/evidence/ after actual verification.

**Interfaces:**
- Consume preceding capability/UI/projection changes.
- Reuse dedicated loopback test-database ownership and storage cleanup utilities; never modify the application database for acceptance.

- [ ] Test-first fixture guards/behavior for disposable target and fixture state when needed; retain existing fixture guard tests. Prepare fresh DB with migrations/reference seeds, real bootstrap and staff onboarding, configured year and synthetic import, completed Laboratory, official current/historical files and certificates, notices for null-email/pending/unverified/other students. Verification must use real token flow, not SQL timestamp updates. Use loopback SMTP sink.
- [ ] Update policy to supersede August 22 portal-wide gate while preserving its token/outbox/staff protections; document upload-only gate, reads, downloads, continuation and SMTP behavior. Keep historical specs intact.
- [ ] Run `npm.cmd run lint`, `npm.cmd run build`, full database-free suite, `npm.cmd run test:integration`, `npm.cmd run test:migrations:empty` with unique dedicated target URLs and disposal consent. Read final exit codes and summaries.
- [ ] Use requested Browser for real authenticated desktop/narrow journey: sign-in/reading/navigation/read notice/current-historical downloads; deliberate upload interruption; explicit token confirmation in second tab and polling return; verified initial upload/finalize/edit/remove/cancel/submit changes; ownership/invalid return/SMTP/session errors and real denied API responses. Inspect console and response evidence. Compare read state/storage before-after.
- [ ] Clean owned fixture/database/storage/server processes, prove zero residue, write actual evidence including any unavailable acceptance. Commit deliverables and obtain final fresh review.
