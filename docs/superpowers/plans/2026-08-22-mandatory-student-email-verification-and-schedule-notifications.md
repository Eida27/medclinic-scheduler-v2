# Mandatory Student Email Verification and Schedule Notifications Implementation Plan

Date: 2026-08-22
Status: Approved for execution
Spec: `docs/superpowers/specs/2026-08-22-mandatory-student-email-verification-and-schedule-notifications-design.md`

## Context

Implement the approved mandatory student email verification and schedule notification design in the isolated `.worktrees/mandatory-student-email-verification` worktree on branch `codex/mandatory-student-email-verification`. Use red-green-refactor for every production behavior and preserve existing scheduling correctness, portal history, minimal student sessions, and asynchronous email delivery.

## Global Constraints

- `StudentSession` remains unchanged and contains no email-verification state.
- The coordinator CSV remains exactly nine columns: `Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth`.
- Student authentication may succeed before verification, but all normal student pages and APIs must enforce mandatory verification on the server.
- The verification token is valid for 30 minutes, is single-use, and only its SHA-256 hash may be persisted as verification identity. Raw tokens must never enter plaintext database columns, audits, or logs.
- Verification requests have a 60-second cooldown and a rolling limit of five requests per student in 15 minutes. A new request invalidates earlier pending requests.
- Verification completion is token-only and sessionless. It must not create a student session or emit `Set-Cookie`.
- Verified email ownership is unique by `LOWER(BTRIM(email))` for active students with `email_verified_at IS NOT NULL`, with the database as the final concurrency authority.
- A replacement leaves the old verified address active until the candidate address is verified successfully.
- Verification email bodies use AES-256-GCM with a dedicated 32-byte Base64 `EMAIL_OUTBOX_ENCRYPTION_KEY`, a versioned envelope, worker-only decryption, and ciphertext clearing after delivery or obsolescence. Schedule emails stay plaintext for operational review.
- SMTP and outbox delivery remain outside scheduling transactions. Valid scheduling work must commit even if notification enqueue or delivery fails; existing savepoint isolation remains intact.
- Schedule state is authoritative inside the caller's transaction and fingerprinted with stable SHA-256 input containing appointment IDs, statuses, authoritative dates, correct locations, and open Manual Resolution identity.
- `AWAITING_RESCHEDULE` treats the prior date as affected, never active, and never invents a replacement.
- First Year Laboratory location must render as Iloilo Mission Hospital where applicable.
- The exact approved Schedule Notice from the spec is shared by the Schedule page and every schedule email.
- Schedule emails exclude DOB, result contents, documents, and medical details.
- Deterministic keys use the families `schedule:initial:<source>:<id>:<student>`, `schedule:event:<event-id>:<student>`, and `schedule:current:<student>:<fingerprint>`.
- First-ever verification queues at most one current-state message for the current authoritative state. Replacement verification does not queue historical catch-up mail.
- Delivery monitoring and retry controls are admin-only. Coordinators and students receive 403 and see no controls. Destinations are masked and failures sanitized.
- Retrying stale schedule mail returns `STALE_SCHEDULE_EMAIL`; expired or superseded verification mail is not retryable and directs the student to request a new link.
- Audit metadata is token-safe and stores masked address/hash metadata only.
- No production legacy backfill, merge, push, PR, or branch cleanup is part of implementation.

## Task 1: Database, encryption, and outbox foundation

Add `database/migrations/023_mandatory_student_email_verification_notifications.sql` and migration integration coverage. Enforce the partial normalized verified-email uniqueness invariant, including concurrent claims and inactive-account reactivation conflicts. Extend `email_outbox` with message kind, notification/source context, portal-notification reference, schedule fingerprint, encrypted verification body, last-attempt metadata, the `OBSOLETE` state, and an actionable-failure index.

Add environment validation/documentation for `EMAIL_OUTBOX_ENCRYPTION_KEY`. Implement a small AES-256-GCM versioned-envelope module with deterministic unit-test seams. Update the outbox repository/service/worker so verification mail persists only neutral plaintext plus encrypted body, decrypts only at send time, clears ciphertext after delivery/obsolescence, preserves schedule-email plaintext, records last-attempt state, and emits token-safe queue/retry/delivery/permanent-failure/obsolescence audits.

Use test-first cycles for migration behavior, key validation, tamper rejection, encrypted persistence, worker decryption/clearing, retry transitions, permanent failure, and obsolescence. Run the focused migration/encryption/outbox tests before committing.

## Task 2: Mandatory onboarding and secure verification

Add `requireVerifiedStudent()` with error code `STUDENT_EMAIL_VERIFICATION_REQUIRED` and HTTP 403. Apply it to Schedule, Notifications, Results, result downloads, uploads, edits, finalization, and other normal student APIs. Redirect unverified page requests to `/student/email-verification`. Keep only verification and logout navigation available while onboarding is incomplete, remove optional reminder/dismiss/skip/remove/opt-out behavior, and keep `StudentSession` unchanged.

Keep authenticated `POST /api/student/email/request-verification`, add authenticated `GET /api/student/email/status`, and make `POST /api/student/email/verify` token-only and sessionless. Add `/student/email-verification/confirm?token=...` with an explicit Verify button so link previews cannot consume tokens. Change verification completion to accept only the token, atomically lock the request and student, recheck normalized ownership, update the address, consume the token, translate uniqueness races to a friendly conflict, and never set a session cookie.

Implement the 30-minute expiry, 60-second cooldown, rolling five-in-15-minute limit, invalidation of earlier pending requests, response fields `expiresAt`, `resendAvailableAt`, and retry timing. Preserve the old verified address during replacement. Poll status every five seconds on onboarding and continue to `/student` after first verification. Audit request, replacement/resend, completion, address replacement, and ownership conflict with masked/hash metadata only. On first verification only, invoke the current-state catch-up interface from Task 3 when authoritative state exists; until Task 3 lands, expose a narrow injectable/service boundary that compiles without sending replacement catch-up history.

Use test-first cycles covering normalization, concurrent ownership, replacement safety, expiry, single use, invalidation, cooldown, throttling, sessionless confirmation, absent `Set-Cookie`, API/page authorization, navigation gating, status polling behavior, and audit secrecy. Run focused service, route, auth, and component tests before committing.

## Task 3: Authoritative schedule-state and typed notification engine

Add a focused schedule-state repository that loads, inside the caller's transaction, student identity, current Laboratory and Physical Examination appointments, authoritative status/date/location, and open Manual Resolution identity. Implement a stable SHA-256 fingerprint over the required state. Ensure First Year Laboratory uses Iloilo Mission Hospital and `AWAITING_RESCHEDULE` renders the prior date only as affected.

Add typed builders for initial publication, current-state catch-up, priority displacement, closure rescheduling, awaiting resolution, Manual Resolution completion, administrator rescheduling, restoration, and cancellation. Extend `StudentNotificationInput` with optional email subject/body, kind, source context, and fingerprint while keeping non-schedule callers backward compatible. Centralize the exact approved Schedule Notice constant and use it in builders and the student Schedule page.

Queue one idempotent current-state message after first-ever verification when state exists, and none for email replacement. Preserve portal history without replaying missed email history. Use deterministic key families from Global Constraints.

Use test-first cycles for stable fingerprints, correct locations, every builder, prohibited-data absence, catch-up idempotency, late verification after multiple changes, unresolved Manual Resolution state, non-schedule compatibility, and enqueue isolation. Run focused repository/service/template tests before committing.

## Task 4: Authoritative schedule transaction hooks

Hook the Task 3 engine exactly once at every authoritative mutation boundary: regular and grouped imports; consolidated First Year and OVPSA publication; regular and OVPSA displacement; OVPSA reschedule, restoration, and cancellation; clinic-closure automatic recovery; awaiting Manual Resolution; Manual Resolution completion; and direct administrator appointment rescheduling.

Generate the correct portal notification and verified-address outbox entry with deterministic event/source keys, previous/current dates, reason/status, and authoritative locations. Preserve transaction/savepoint isolation and never call SMTP from scheduling paths. Publication to an unverified student still commits and records portal history without an email row.

Use test-first integration cycles for every path, initial publication, idempotency, SMTP/enqueue failure isolation, closure savepoints, First Year location, displacement reasons, restoration/cancellation, and direct admin rescheduling. Run the focused scheduling/closure/OVPSA integration suites before committing.

## Task 5: Administrator delivery monitoring

Add admin-only `GET /api/admin/email-deliveries`, `POST /api/admin/email-deliveries/[id]/retry`, and `POST /api/admin/email-deliveries/[id]/queue-current`. Add `/settings/email-delivery`, an admin-only sidebar entry, and an admin-only dashboard actionable issue count.

Default to permanent actionable failures and support audit/history filtering. Return only masked destinations, mapped Pending/Sent/Retrying/Failed states, attempts, last attempt, notification context, and sanitized failure reasons. Retry a current schedule failure by resetting the row and auditing the administrator. Reject stale fingerprints with `STALE_SCHEDULE_EMAIL`, show the current state, and require the separate idempotent queue-current action. Reject expired/superseded verification retries and direct the student to request a fresh link. Expose no verification override or schedule-edit control.

Use test-first cycles for repository/service state mapping, masking/sanitization, admin-only APIs/pages/controls/counts, coordinator/student 403 behavior, retry audit/reset, stale rejection, current-state replacement idempotency, and verification-email retry rejection. Run focused admin route/service/component tests before committing.

## Task 6: Guarded acceptance fixture and complete regression coverage

Add `scripts/browser-student-email-notifications-fixture.ts` and package scripts for setup/status/cleanup. Require loopback and an explicit exclusive-database flag. Own all fixture students, verification attempts, schedules, failures, closures, Manual Resolution cases, notifications, outbox rows, audits, triggers, and state files. Cleanup must prove every fixture-owned residue count is zero.

Complete any cross-feature regression coverage that does not belong cleanly to Tasks 1-5, including representative end-to-end lifecycle setup for Browser acceptance. Keep fixture commands deterministic and safe to rerun.

Run fixture setup/status/cleanup tests and prove zero residue. Do not run the final authoritative suite until Browser acceptance and cleanup are complete.

## Final Verification

Use the in-app Browser for authenticated desktop, mobile, and keyboard acceptance of mandatory onboarding, redirects/API blocking, request cooldown/correction/replacement, sessionless explicit confirmation, verified portal unlock and persistent Schedule Notice, current-state catch-up, representative reschedule and awaiting-resolution communication, admin issue count/masked delivery view/retry/stale rejection/queue-current, and zero console warnings/errors.

After fixture cleanup reports zero residue, run:

```powershell
npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm.cmd run lint
npm.cmd run build
git diff --check
```

Also run scoped ESLint if needed for diagnostics. Perform a whole-branch code review, resolve blocking findings, then invoke Superpowers branch finishing. Stop before merge, push, PR creation, worktree deletion, or branch deletion.
