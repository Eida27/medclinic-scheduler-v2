# Student portal access with email verification at Laboratory submission

Date: 2026-09-29 (Asia/Manila)

Repository: Eida27/medclinic-scheduler-v2

Reviewed baseline: `ae8bc278ec0af1f15aae47e1f11f0d27298b4048` on `main`.

Status: Proposed implementation design, committed at the user's request. The requested access change and access to existing result/certificate downloads are user-confirmed. Technical choices below are implementation recommendations. This commit contains documentation only; it does not implement the feature.

## 1. Design brief and confirmed scope

After successful Student Number, Date of Birth, and complete Middle Name authentication, an active student must be able to view their schedules and portal notifications without registering or verifying an email address.

The user also selected **Allow viewing and downloads** when asked whether unverified students may view existing results and download their Physical Examination certificate.

Email verification becomes mandatory when entering the Laboratory upload or editing workflow. It must be enforced before a draft can be created or changed, before files are selected in that workspace, and before an upload body is processed by an API route. A student can verify voluntarily earlier, but reading the portal must never force verification.

Assume first deployment with a completely fresh database. Preserve existing student authentication, ownership checks, clinical completion rules, staff onboarding, and private storage. No production-data transition or compatibility feature flag is required.

### Meaning of “viewing results”

- Students can see and download their own currently official, finalized Laboratory documents and their own issued PE certificates, including eligible previous-academic-year records.
- Draft, superseded, invalidated, deleted, and pending-deletion Laboratory files do not become downloadable.
- An in-progress edit does not hide its still-finalized official revision.
- A revoked certificate remains visibly revoked and cannot be downloaded.
- Viewing does not create a draft, refresh draft activity, allocate private storage, or change a clinical/submission status.
- Marking one's own notification as read is allowed before email verification. It is part of normal notification use, not Laboratory submission.

## 2. Findings from the reviewed repository

| Area | Current behavior | Design consequence |
| --- | --- | --- |
| Student authentication | `student-auth.service.ts` checks active identity, Student Number, DOB, complete Middle Name, and login throttling. The login form already navigates to `/student`. | Keep the login contract and landing destination. |
| Current identity | `requireStudent()` reads the active student from the database. `requireVerifiedStudent()` additionally requires both `email` and `emailVerifiedAt`. | Reuse these separate authorization levels; do not weaken the verified helper globally. |
| Student pages | Schedule, Notifications, Results overview, and submission detail all use `requireVerifiedStudentPage()`. | Change the three reading pages to authenticated-only guards; retain verification on the submission workspace. |
| Portal navigation | `student/layout.tsx` hides Schedule, Notifications, and Results without `emailVerifiedAt`. | Show these links to every authenticated active student. |
| Notification API | Both GET and PATCH use `requireVerifiedStudent()`. | Both operations must use `requireStudent()`. |
| Results overview | It lists completed current Laboratory appointments, current/historical certificates, and historical Laboratory files. Current Laboratory documents are reached through the submission workspace. | Add a read-only current-document listing to the overview so existing documents can be read without entering that workspace. |
| Submission detail and GET API | `getStudentResultSubmission()` calls `lockOrCreateStudentResultDraft()` when no submission exists. Its repository lookup also prefers a draft over a finalized revision. | Neither helper is a safe source for the unverified Results overview. Keep these entry points verified-only. |
| Download routes | Laboratory file and PE certificate downloads both use `requireVerifiedStudent()`; their services already check student ownership and publication/status eligibility. | Change only the student authentication guard, retaining service checks. |
| Email verification | The form says verification is required for portal access and polling always returns to `/student`. Confirmation uses an explicit POST and does not create a student session. | Update the message and add a constrained return destination for an interrupted Laboratory workflow. |
| Notification delivery | Portal notices are created independently of verified-email eligibility; email delivery requires a verified address. First verification has an existing current-state catch-up. | Keep those delivery rules and deduplication. Access to notices must not depend on SMTP delivery. |

### Approaches considered

| Approach | Benefit | Trade-off |
| --- | --- | --- |
| **Use existing authenticated/verified guards by capability, and add read-only files to Results overview — selected** | Small change to established flows; no new upload API or database schema; makes all approved reads available. | Requires an explicit current finalized-document query and changes to redirect handling/tests. |
| Make the submission detail a combined read/write page for every student | One destination for result viewing and editing. | Requires refactoring draft-preferred reads and draft creation to prevent writes while browsing; unnecessary for the requested outcome. |
| Add a separate limited-access portal or new session type | Separates the two access levels structurally. | Duplicates navigation and authorization and adds lifecycle work without improving this flow. |

Implement the selected approach. The overview is the read surface; `/student/results/[appointmentId]` remains the upload/edit workspace.

## 3. Access policy

“Authenticated” below means a valid student session plus a current active student record. Email presence alone is not verification. “Verified” means the current database identity has both an email and a verification timestamp.

| Capability | Signed out / invalid session / inactive student | Authenticated, unverified | Authenticated, verified |
| --- | --- | --- | --- |
| Schedule and schedule history | Sign in required | Allowed | Allowed |
| Portal notification list/unread count | Sign in required | Allowed | Allowed |
| Mark own notification read | 401 | Allowed | Allowed |
| Results overview and official document metadata | Sign in required | Allowed | Allowed |
| Own finalized Laboratory file download | 401 | Allowed, subject to existing file eligibility | Same |
| Own issued PE certificate download | 401 | Allowed, subject to existing certificate eligibility | Same |
| Email status and request/resend verification | 401 | Allowed under existing throttling | Allowed, including replacement-email flow |
| Open Laboratory upload/edit workspace or initialize/load its draft | Sign in required / API 401 | Verification redirect / API 403 | Allowed subject to appointment eligibility |
| Add/remove draft files, start/cancel an edit, finalize, submit changes | 401 | 403 verification required | Allowed subject to existing domain rules |
| Other students' data | Denied | Denied | Denied |

The token-based email confirmation page/API remains the existing explicit exception: a valid unexpired single-use token can verify its associated address without logging in. It grants no portal session.

## 4. Student experience

### 4.1 Sign-in, navigation, and reading

1. Keep the current student credentials and case-insensitive Middle Name comparison, with existing spacing/punctuation behavior and throttling.
2. Successful login continues to `/student`, including when both email fields are null.
3. Show **Schedule**, **Notifications**, **Results**, **Email verification**, and **Log out** to authenticated students regardless of verification.
4. Use the same schedule/history and notification data for verified and unverified students. Preserve published/current/previous-year visibility and existing empty states.
5. The Results overview displays current official Laboratory documents, previous-year Laboratory documents, and current/historical PE certificate cards.
6. Add a nonblocking explanation in Results for unverified students: “You can view and download your results. Verify your email before uploading or updating Laboratory documents.” Provide a voluntary verification link.
7. Do not show a mandatory modal, redirect, repeated email request, or blocking banner on Schedule or Notifications. Opening any reading page must not send a verification email.

### 4.2 Laboratory upload and editing entry

Keep Laboratory submission eligibility based on the existing current effective completed appointment rules. Email verification does not make an incomplete, ended-year, replaced, or otherwise ineligible appointment uploadable.

For the existing eligible Laboratory appointment card:

- A verified student sees **Manage Laboratory documents**, linking to the upload/edit workspace.
- An unverified student sees **Verify email to upload or update**, linking to the verification page with that workspace as the return destination.
- Keep finalized-file download links separate from the management action. Downloads remain usable without verification.
- Do not mount `ResultDraftManager` on the unverified overview.
- Disable framework prefetch for links into the workspace because rendering it can initialize a draft. Draft initialization should follow deliberate entry, not background prefetch.

A direct visit to `/student/results/[appointmentId]` must check authentication and verification before calling the submission service. An unverified visit returns to the verification page with the intended workspace retained. It must not create a draft, touch storage, or extend draft expiry.

Verified workspace entry retains the existing create/load behavior and every current clinical, ownership, revision, and stale-draft check. All editing actions, including cancel edit and remove file, remain part of the verified Laboratory workflow.

### 4.3 Verification and return

Use a `returnTo` query parameter on the existing verification page; do not add database fields or embed the destination in the email token.

- Permit only the exact paths `/student`, `/student/results`, and `/student/results/<UUID>`.
- Validate the parsed value with a shared pure helper. Reject external/protocol-relative URLs, backslashes, extra path segments, query strings/fragments, malformed IDs, and repeated/array values. Missing or rejected values fall back to `/student`.
- Construct links from known application paths; never pass unvalidated query input to navigation or redirect functions.
- Give the verified-page guard an optional constrained destination so it can preserve the selected workspace when redirecting. Keep its existing default for callers without a destination.
- Pass the sanitized destination to `EmailVerificationForm`. On a successful status poll, navigate there and refresh server state.
- If the student is already verified on arrival with an explicit valid return destination, continue there immediately. Ordinary navigation to Email verification without `returnTo` must still show the current/replacement-email form.
- Keep an ordinary **Back to schedule** link available while waiting or after a mail error.
- Update unverified copy to: “Verify your email to upload or update Laboratory documents. You can still view schedules, notifications, and existing results.”
- Confirmation remains an explicit POST. Opening its email link alone must not consume the token. Its success state provides a portal link and tells students they can return to their original tab.
- The originating tab retains its existing five-second polling and cleanup. A link opened in another browser does not transfer authentication; sign-in is still needed to read the portal.
- If the session expires while waiting, handle the status API's 401 as sign-in required and stop polling. Do not retry forever or infer success from the email tab.
- Recheck ownership and eligibility at the return destination. A return path is navigation context, never permission; another student's or a no-longer-eligible appointment remains inaccessible.

Keep token expiry, single use, resend cooldown, throttling, encrypted outbox content, email uniqueness, and previous verified address retention. A pending replacement address does not invalidate an existing verified address or block that student's uploads.

## 5. Server and data design

### 5.1 Page authorization

Add a small `requireStudentPage()` helper in `src/server/auth/student-page.ts` around `requireStudent()`. Redirect unauthenticated requests to `/student/login`; do not add an email check. Keep errors consistent with the existing page conventions.

Use it in Schedule, Notifications, and Results overview. Keep `requireVerifiedStudentPage()` in submission detail with the validated return destination. Retain active-identity checks per request and the existing separate staff/student session cookies. The proxy already authenticates student portal paths without an email gate and needs no policy change.

Do not treat a layout check, a hidden button, a client boolean, or a session claim as sufficient authorization for an API request. Derive verification from the database-backed student helper.

### 5.2 Read-only Laboratory document projection

Add `listCurrentLaboratoryDocuments(studentNumber)` beside `listHistoricalLaboratoryDocuments()` in the existing submission repository. The proposed name is new.

- Read only official `FINALIZED` Laboratory submissions belonging to the session student; ensure the joined appointment is also Laboratory and belongs to the same student.
- Exclude discarded submissions, deleted files, and files pending storage deletion. Keep these eligibility/ownership predicates consistent with `getAccessibleStudentResultFileRow()`; add a missing predicate there if necessary so listing and direct download enforce the same policy.
- Use configured academic-year closing dates in Asia/Manila. Current/upcoming documents have a closing date on or after today; historical documents have an earlier closing date. Keep listing and direct-download eligibility consistent.
- Reuse the existing historical projection shape: submission ID, academic-year start, appointment date, file ID, and original filename. No storage keys, bytes, token material, or administrative revision history go to the overview/client.
- An active edit draft must not replace or suppress the official finalized file list. Do not query through the current draft-preferred `getStudentResultSubmissionRow()`.
- A Laboratory appointment with no official files shows an empty state and, if eligible, the upload-management entry. Merely viewing that state must not initialize a submission.
- Order deterministically by academic year descending, appointment date descending, then file upload time and file ID. Align the existing historical query with the same ownership/status exclusions where needed.
- Render downloads through the existing private file endpoint. No new public storage URLs, listing API, or read-only detail route is required.

Reuse `studentCertificateHistory()` for PE cards. Reuse existing certificate download controls and status rules. This does not expose earlier corrected certificate revisions to students or reintroduce PE uploads.

### 5.3 Route-by-route contract

In the table, `:appointmentId`, `:fileId`, and `:certificateId` denote the existing dynamic route segments.

| Route | Method | Required guard after implementation |
| --- | --- | --- |
| `/api/student/notifications` | GET, PATCH | `requireStudent()` |
| `/api/student/result-files/:fileId` | GET | `requireStudent()`; keep `getStudentResultFile()` ownership/status/integrity checks |
| `/api/student/medical-certificates/:certificateId/download` | GET | `requireStudent()`; keep UUID, ownership, latest revision, and revocation checks |
| `/api/student/result-submissions/:appointmentId` | GET | `requireVerifiedStudent()`; this can initialize a draft |
| `/api/student/result-submissions/:appointmentId/files` | POST | `requireVerifiedStudent()` before multipart parsing/buffering |
| `/api/student/result-submissions/:appointmentId/files/:fileId` | DELETE | `requireVerifiedStudent()` before mutation |
| `/api/student/result-submissions/:appointmentId/edit` | POST, DELETE | `requireVerifiedStudent()` before edit creation/cancellation |
| `/api/student/result-submissions/:appointmentId/finalize` | POST | `requireVerifiedStudent()` before finalization |
| `/api/student/result-submissions/:appointmentId/submit-changes` | POST | `requireVerifiedStudent()` before revision promotion |
| `/api/student/email/status` | GET | Existing `requireStudent()` |
| `/api/student/email/request-verification` | POST | Existing `requireStudent()` and throttling |
| `/api/student/email/verify` | POST | Existing token validation; no session creation |

Preserve the error envelope and `STUDENT_EMAIL_VERIFICATION_REQUIRED` code with HTTP 403. Its message should explain the restricted action: “Verify your email address before uploading or updating Laboratory documents.” Missing/invalid/inactive sessions remain HTTP 401.

A stale open workspace receiving that 403 must present a verification action with its appointment return path and stop the failed action. Do not automatically retry a POST/DELETE or upload files after verification. Browser file selections are not stored or transferred through verification.

Keep private/no-store responses and existing non-disclosing ownership failures. A forged request must fail even when it supplies another student's ID, changes client verification flags, bypasses navigation, or directly calls an endpoint. Keep file limits, file-signature validation, expected submission IDs, checksums, cleanup intents, revision history, and PE-upload rejection.

### 5.4 Notifications and email delivery

Portal notifications and email messages remain separate channels:

1. Preserve existing business-event creation and deduplication of portal notices regardless of email verification.
2. Allow unverified students to list their own notices and mark them read; keep updates scoped by both notification ID and session student.
3. Queue schedule/result notification emails only for an eligible verified address. Verification-request emails may still go to the pending address as part of proving ownership.
4. Keep existing first-verification current-state catch-up behavior, including its event keys and failure isolation. Do not replay every historical notice or mark previously unread notices as read.
5. An SMTP outage must not prevent login, schedule/notification/result viewing, or authorized downloads. It can delay first verification and therefore Laboratory upload access; do not bypass verification.

### 5.5 Fresh database and operational scope

No schema migration, new role, new cookie type, new environment variable, or email-verification backfill is required. Existing nullable student email fields, verification requests, notifications, submission revisions, and outbox tables are sufficient.

Retain migrations 001–029 present at the reviewed baseline. Do not delete migration 023 because its filename refers to mandatory verification; its uniqueness and outbox protections remain needed. Do not stamp imported students as verified, add synthetic default email addresses, or change the nine-column import format.

SMTP remains an installation prerequisite for staff onboarding and student Laboratory submission verification. Staff verification/password-change requirements are unchanged. Scheduling, Laboratory-before-PE, clinical checklist completion, certificate issuance, and Administrator result management remain outside this change.

## 6. Implementation impact

All paths below are relative to the repository root. New filenames are proposals; the other files exist at the reviewed baseline.

| Files | Intended work |
| --- | --- |
| `src/server/auth/student-page.ts` (new) and its tests | Authenticated-only student page guard. |
| `src/server/auth/current-student.ts` and `current-student.test.ts` | Preserve distinct guards; refine verification error text; cover current identity states. |
| `src/server/auth/verified-student-page.ts` and tests | Preserve the Laboratory workspace destination through verification. |
| `src/lib/student-verification-return.ts` (new) and tests | Shared narrow return-path validation; no arbitrary URL redirects. |
| `src/app/(student)/student/layout.tsx`, `page.tsx`, `notifications/page.tsx` and tests | Always expose authenticated read navigation; replace verified page guards. |
| `src/app/(student)/student/results/page.tsx` and tests | Read-only official file listings, certificate access, clear management action, and nonblocking verification copy. |
| `src/server/repositories/student-result-submissions.repository.ts` and focused integration tests | Add current finalized-document projection and align historical ownership/status filtering. |
| `src/app/(student)/student/results/[appointmentId]/page.tsx` and tests | Keep verified-only workspace and guard-before-service order. |
| `src/app/api/student/notifications/route.ts` and tests | Authenticated GET and PATCH with existing student scope. |
| `src/app/api/student/result-files/[fileId]/route.ts` and tests | Authenticated official-file download with retained service checks. |
| `src/app/api/student/medical-certificates/[certificateId]/download/route.ts` and new adjacent route tests | Authenticated issued-certificate download; preserve 404/410 and private response behavior. |
| `src/app/(student)/student/email-verification/page.tsx`, `src/components/student/EmailVerificationForm.tsx`, `EmailVerificationConfirmation.tsx` and tests | Context-specific messaging, validated continuation, back navigation, status/session handling. |
| `src/components/student-results/ResultDraftManager.tsx` and tests | Handle a verification-required response with a safe verification action and no automatic resubmission. |
| Existing result-submission route tests | Prove every draft/upload/edit/finalization operation still denies unverified requests before service or storage work. |
| Student login page/form tests and `src/proxy.test.ts` | Confirm existing login destination and session separation; implementation changes only if a regression is found. |
| `src/server/services/student-email.integration.test.ts`, notification/catch-up tests, and student portal end-to-end coverage | Verify verification lifecycle, email eligibility, ownership, and cross-feature behavior. |
| `README.md`, `docs/current-policies.md`, `docs/installation.md`, `docs/e2e.md`, and student-email acceptance fixture expectations | Replace portal-wide verification claims and document the new first-deployment journey when implementation ships. |

Do not rewrite historical specifications as though they always described this policy. On implementation, link this spec from `docs/current-policies.md` and identify it as superseding the August 22 portal-wide verification gate and any later document repeating that gate. The August 22 verification-token, email ownership, notification, outbox, and staff rules remain applicable.

## 7. Acceptance criteria and verification

These are required checks for the future implementation, not test results from this documentation commit.

### 7.1 Authentication and reading

- An active imported student with null email and null verification timestamp signs in and lands on Schedule without a verification redirect.
- Repeat with a pending verification request and with an unverified email value: Schedule, history, Notifications, and Results remain accessible.
- All authenticated navigation links are visible, including direct reloads and bookmarked reading routes.
- Anonymous, expired-token, invalid-token, inactive, and staff-only sessions cannot read student data. Keep existing student credential/throttle tests.
- Unverified notification GET and PATCH work for the owning student. Cross-student listing and mark-read attempts reveal/change nothing.
- Visiting Schedule, Notifications, Results, or verification information does not automatically request an email.

### 7.2 Results and download boundaries

- Unverified students can list and download their own current and historical official Laboratory files and issued PE certificates.
- A still-finalized official Laboratory revision stays visible/downloadable while an edit draft exists.
- Draft/superseded/invalidated/deleted/pending-deletion files are excluded and not downloadable; revoked certificates remain labeled and return the existing 410 on direct download.
- Other-student file/certificate IDs remain inaccessible with non-disclosing failures.
- Empty current-result states and historical-only states render correctly across the Manila academic-year boundary.
- Record submission count, draft activity timestamps, result status, cleanup-intent count, and storage contents before and after reading pages; all remain unchanged.
- Normal navigation/prefetch of reading pages does not initialize a draft.

### 7.3 Verification enforcement and continuation

- For each workspace/API operation in section 5.3, unverified access yields the specified redirect/403 and never reaches the mutation/draft service.
- The upload route rejects unverified access before multipart parsing, file buffering, validation side effects, or storage allocation.
- Test both missing email and missing verification timestamp; possession of only one never grants upload access.
- The verified workspace retains initial upload, add/remove files, finalization, edit/cancel, submit-changes, invalidation replacement, and stale-submission behavior.
- A valid verification completed in another tab is detected by polling, returns to the chosen Laboratory appointment, and needs no logout/login when the original session remains valid.
- Voluntary verification without a destination returns to Schedule. Already-verified students can still manage replacement email normally.
- Invalid/replayed/expired verification links, cooldowns, duplicate email ownership, mail failure, and session expiry have usable errors and never block reading access for an otherwise valid student session.
- Test every allowed return path and rejected external/protocol-relative/backslash/encoded/extra-segment/repeated/query/fragment form. Redirects always stay within the allowlist.
- A crafted other-student return appointment remains inaccessible after verification. A closed/replaced appointment is revalidated.
- If a workspace loses verification before its next action, its server request fails, the UI offers verification, and no upload/mutation is automatically replayed.
- A pending replacement email retains the old verified address and existing upload capability.

### 7.4 Cross-feature and first-deployment proof

- Create a synthetic published schedule and a schedule change for an unverified student. Confirm portal notices are readable immediately and no schedule email is queued to an unverified address.
- Complete first verification through the real token flow; preserve the current-state catch-up/deduplication and verified-address notification behavior.
- Confirm Laboratory document upload never checks clinical checklist items or completes PE, and forged PE uploads remain rejected.
- Confirm verified/unverified reading behavior during a temporary SMTP outage; retain staff mandatory onboarding.
- Rehearse with a newly created disposable test database, migrations/reference seeds, first-Administrator bootstrap, staff onboarding, configured academic year, and synthetic student import. Do not bypass verification by updating email timestamps with SQL.
- Exercise the complete browser path at desktop and narrow viewport widths, including navigation, mark-read, current/historical downloads, verification interruption/return, and upload/edit. Inspect real responses and confirm no redirect loops.

Use the repository's existing database-free `npm test`, `npm run lint`, and `npm run build` gates for implementation. Run `npm run test:integration` and `npm run test:migrations:empty` using the documented dedicated disposable database configuration. Start with focused tests for changed authorization, queries, and continuation, then run the required repository gates. Tests must assert behavior and absence of side effects, not only changed helper names.

## 8. Delivery sequence and completion definition

1. Add the authenticated page helper and constrained return-path helper with focused tests.
2. Open Schedule, Notifications, Results navigation, notification GET/PATCH, and authorized download routes to authenticated active students.
3. Add the pure official Laboratory document projection and render current/historical file downloads without entering the workspace.
4. Preserve workspace/mutation verification, disable workspace-link prefetch, and implement verification return/error handling.
5. Update active policy/installation/acceptance documentation and relevant fixture expectations.
6. Run the tests and fresh-database/browser journeys above; record actual evidence separately from planned checks.

The feature is complete when unverified students can use all approved reading/download functions, every Laboratory submission entry/action still requires verification on the server, verification returns them to the intended eligible workspace, and the updated policy is consistently reflected in the UI, APIs, tests, and active documentation.

This specification is ready for review and a separate implementation task. Committing it does not change runtime access or claim that the implementation acceptance checks have passed.
