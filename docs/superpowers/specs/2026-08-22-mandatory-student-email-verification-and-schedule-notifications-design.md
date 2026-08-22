# Mandatory Student Email Verification and Schedule Notification Design

Date: 2026-08-22
Status: Approved design
Repository: `Eida27/medclinic-scheduler-v2`

## 1. Purpose

MedClinic already supports student email verification, portal notifications, and an email outbox, but the existing academic-year scheduling design treats email as optional. This design changes that rule.

Every active student must maintain one verified email address before using the normal student portal. The verified address is the mandatory email-notification destination for published schedules and meaningful schedule changes, including priority displacement, clinic closures, emergency closures, Manual Resolution, and other administrator-authorized rescheduling.

This design does not make SMTP delivery part of scheduling correctness. A valid schedule change must still commit even if email delivery is delayed or fails. The student portal remains the authoritative source of the current schedule, while email is the mandatory communication channel associated with the student account.

This specification supersedes Section 10, **Optional Student Email Verification**, of `docs/superpowers/specs/2026-07-18-automated-academic-year-scheduling-and-student-results-design.md` wherever the two designs conflict.

## 2. Goals

The implementation must:

- Require every active student to verify an email address on first portal login before accessing normal student-portal functionality.
- Allow coordinators to continue importing and publishing student schedules without collecting email addresses in the coordinator CSV.
- Send the current assigned schedule after successful verification when a schedule already exists.
- Send schedule-change notifications for displacement, closures, emergency closures, Manual Resolution, and administrator-authorized rescheduling.
- Avoid replaying obsolete historical emails when a student verifies late.
- Keep the portal notification history complete even when no verified email existed at the time an event occurred.
- Keep email delivery asynchronous and retryable so SMTP failures cannot corrupt scheduling transactions.
- Give administrators dashboard-only visibility into delivery failures without creating administrator inbox noise.
- Prevent administrators or coordinators from bypassing ownership verification of a student's email address.
- Enforce one verified email address per active student account.

## 3. Non-Goals

This change does not add:

- Browser push notifications.
- Mobile push notifications.
- SMS or text messaging.
- General appointment reminder campaigns unrelated to assignment or schedule changes.
- Email addresses to the approved nine-column coordinator CSV.
- Administrator or coordinator email-verification overrides.
- Replay of every historical email missed before first verification.
- Medical-result contents, uploaded documents, or other unnecessary health information in schedule emails.

The existing approved coordinator CSV remains:

```text
Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth
```

## 4. Core Policy

### 4.1 Mandatory verified email

Every active student must have one verified email before accessing the normal student portal.

A student may authenticate using the existing Student Number + Date of Birth flow, but an authenticated student whose `email_verified_at` is null is considered **authenticated but onboarding-incomplete**.

That student must be redirected to mandatory email verification until verification succeeds.

### 4.2 No verification bypass

A verified email means that control of the mailbox was proven through a valid verification link.

Administrators and coordinators may inspect verification status and assist with resending or troubleshooting, but they may not:

- Manually set `email_verified_at`.
- Mark an address as verified.
- Skip the onboarding gate.
- Verify an address on behalf of the student.

### 4.3 Verified email cannot be removed

A student cannot remove their verified email or opt out of schedule email notifications.

A verified address may only be replaced through a new verification flow. The existing verified address remains active until the replacement address is successfully verified.

### 4.4 One verified email per active student

The same normalized verified email address cannot belong to two active student accounts.

Email normalization continues to use trimmed lowercase addresses before comparison and persistence.

If an inactive student has a verified address that has since been claimed by another active student, reactivation must not silently create a duplicate active verified address. The conflict must be resolved before the old account can become active again.

## 5. Mandatory Onboarding and Portal Access

### 5.1 First-login flow

The approved flow is:

1. A coordinator imports a student batch using the existing nine-column CSV.
2. Scheduling and publication may proceed normally even though the imported students have no verified email yet.
3. A student logs in using Student Number + Date of Birth.
4. MedClinic loads the active student identity and checks `email_verified_at`.
5. If no verified email exists, the student is redirected to the mandatory Email Verification onboarding page.
6. Normal student pages remain inaccessible until verification succeeds.
7. After successful verification, the original logged-in session can refresh its student identity and continue into the portal.

### 5.2 Allowed pre-verification actions

Before verification, an authenticated student may only access the minimum actions required to complete onboarding:

- View the mandatory verification page.
- Enter a valid email address.
- Request a verification link.
- Resend after cooldown.
- Correct or replace a mistyped pending address.
- Check verification status.
- Log out.

Normal student routes such as Schedule, Notifications, Results, and result-submission functionality must enforce the verified-email gate on the server, not merely hide navigation links.

Direct URL access to gated pages must redirect the authenticated unverified student back to Email Verification.

### 5.3 No dismissible optional reminder

The current optional/dismissible email reminder is replaced by a mandatory onboarding state for students without a verified email.

The UI must not offer:

- Skip.
- Not now.
- Dismiss permanently.
- Disable schedule emails.

## 6. Verification Request and Token Security

### 6.1 Accepted email addresses

Students may use any syntactically valid email address. Verification is not restricted to a CPU institutional domain.

### 6.2 Token behavior

Verification continues to use a high-entropy random token with only its cryptographic hash stored in the database.

The required behavior is:

- Verification token lifetime: **30 minutes**.
- Single successful use.
- A newer request invalidates prior unused verification requests for that student.
- Expired, already-used, or invalid tokens fail safely.
- Token values must not be logged.
- Successful verification consumes the pending request atomically with the email update.

### 6.3 Resend behavior

Students may request a new verification email after a **60-second cooldown**.

The service must also apply server-side anti-abuse throttling in addition to the client-visible cooldown. The throttling mechanism must prevent rapid spam without creating a fixed daily lockout that could permanently block a legitimate student from onboarding.

The UI should communicate when resend becomes available.

### 6.4 Any-device verification

The verification link may be opened from any browser or device. The verifying device does not need an existing MedClinic student session.

The token itself identifies the pending verification record securely.

Successful verification from another device must only complete email verification. It must **not** create or transfer a student portal session to that device.

The verification landing page may display a simple success state such as:

> Email verified successfully. You may return to the MedClinic student portal.

The student's original logged-in onboarding page may periodically re-check verification status and automatically continue when verification becomes complete. This polling is only a UI convenience; server-side authorization remains authoritative.

## 7. Email Replacement

A student with an existing verified email may request a replacement.

The replacement workflow is:

1. Student enters a new candidate email.
2. MedClinic creates a pending verification request for the candidate address.
3. The existing verified address remains active.
4. Schedule emails continue going to the existing verified address while replacement is pending.
5. The student verifies the new address through the normal link flow.
6. The new address becomes current only after successful verification and uniqueness validation.
7. The previous verified address is replaced at the same atomic completion point.

If replacement verification expires or is abandoned, the old verified email remains valid.

## 8. Verified Email Uniqueness and Concurrency

### 8.1 Service-level checks

A verification request should be rejected when the candidate address already belongs to another active, verified student.

Pending requests from different students may race for an address that is not yet verified. Therefore request-time checking is not sufficient.

### 8.2 Verification-time enforcement

Successful verification must re-check uniqueness in the same controlled operation that updates the student.

A database uniqueness constraint/index must be the final authority so concurrent verification attempts cannot produce two active students with the same verified email.

The intended rule is equivalent to uniqueness over normalized student email when:

```text
email_verified_at IS NOT NULL
AND is_active = TRUE
```

If the uniqueness rule rejects the verification because another active student claimed the email first, the request must fail with a student-friendly message asking the student to use another email address.

### 8.3 Reactivation

Because uniqueness applies to active accounts, reactivating an inactive student can surface a conflict. Reactivation must perform the same invariant check before the account becomes active.

The system must not silently clear another student's email, automatically share the address, or bypass verification to resolve the conflict.

## 9. Schedule Notification Lifecycle

Every meaningful schedule state change creates a portal notification. If a verified email exists at that time, a corresponding email is queued.

If no verified email exists, the portal notification is still recorded, but no historical email is queued for later replay.

### 9.1 Initial assignment publication

When a student's first authoritative Laboratory/Physical Examination schedule is published:

- Create the normal portal notification/history event.
- If the student already has a verified email, queue an **Initial Schedule** email containing the current authoritative schedule.
- If the student is still unverified, do not block publication and do not queue an email to an unverified address.

### 9.2 First verification after schedule publication

When a student successfully verifies an email after one or more schedule events have already occurred, MedClinic sends a single **current-state catch-up notification**.

The catch-up notification must use the latest authoritative scheduling state at verification time.

It must not replay stale emails for every historical assignment or displacement.

Examples:

- Initial schedule September 10, later displaced to September 15, verified afterward -> email only the current September 15 schedule.
- Several previous changes exist -> email only the latest current state; portal history retains the earlier events.

The catch-up operation must be idempotent so repeated requests, page refreshes, or retries cannot generate duplicate current-state notifications for the same authoritative state.

### 9.3 Priority displacement

When a schedule is displaced by approved priority scheduling:

- Create/update the authoritative appointments according to the scheduling rules.
- Create the portal notification.
- Queue an email for the verified student.
- Include previous and replacement date(s) when available.
- Include a student-friendly reason.

Reasons may identify the actual approved scheduling cause, including OJT, Tour, Specialized, First Year/OVPSA priority scheduling, or another authorized priority rule.

### 9.4 Planned closure with automatic rescheduling

When an approved future closure automatically reschedules an eligible appointment:

- Commit the closure and resulting replacement schedule according to the clinic-calendar policy.
- Create the portal notification.
- Queue an email containing the affected old date(s) and the new authoritative replacement date(s).

### 9.5 Emergency closure / Manual Resolution pending

The approved clinic-closure recovery policy treats emergency closures and other qualifying Manual Resolution cases differently from ordinary automatic rescheduling.

When the current schedule becomes affected and no safe replacement is yet authorized:

- Do not invent a tentative date.
- Do not silently auto-advance the student simply for notification purposes.
- Mark/use the existing authoritative Manual Resolution state such as `AWAITING_RESCHEDULE`.
- Create a portal notification immediately.
- Queue an email stating that the prior schedule was affected and that a replacement schedule is pending administrator resolution.

If the student first verifies while the current authoritative state is `AWAITING_RESCHEDULE`, the catch-up email must describe that unresolved state rather than presenting the old affected appointment as active.

### 9.6 Manual Resolution completed

When an administrator completes Manual Resolution:

- Commit the final replacement schedule.
- Create the corresponding portal notification.
- Queue a second email containing the newly authoritative date(s) and location(s).

This message is distinct from the earlier awaiting-resolution notice.

### 9.7 Administrator-authorized manual rescheduling

Any other administrator-authorized manual rescheduling that changes the authoritative student schedule must create a portal notification and queue an email to the verified address.

The notification should include the previous and replacement date(s) plus the recorded reason when appropriate.

## 10. Notification Idempotency and Stale-State Protection

### 10.1 Event keys

Schedule notifications and email-outbox entries must use deterministic idempotency/event keys so retries or repeated service calls cannot create duplicate emails for one logical scheduling event.

Keys should identify both the notification type and the authoritative schedule event/state, for example by referencing the source import/rescheduling event and relevant appointment identifiers or a stable current-state fingerprint.

### 10.2 Late verification catch-up

The catch-up notification after first verification must have its own deterministic key tied to the current authoritative state.

Verifying, refreshing, or re-checking status multiple times must not repeatedly send the same catch-up email.

### 10.3 Retry of old failed mail

An administrator-triggered retry must not resend an obsolete schedule as though it were current.

Before retrying a failed schedule email, MedClinic must determine whether the notification is still relevant to the student's current authoritative schedule.

If the failed email is stale because the schedule has changed again, the old message must not be resent. The administrator should instead be offered or directed to queue a current-state notification.

## 11. Email Content

### 11.1 Required actionable information

Schedule-related email templates may include:

- Student name.
- Student Number.
- Notification type.
- Laboratory date and location when applicable.
- Physical Examination date and location when applicable.
- Previous date(s) for a rescheduling event.
- Replacement/current date(s).
- Student-friendly reason/status.
- Current schedule state.
- Link to the MedClinic student portal.

For First Year students, Laboratory notifications must use the correct approved Laboratory location, including **Iloilo Mission Hospital** where applicable.

### 11.2 Prohibited unnecessary information

Schedule emails must not include:

- Date of Birth.
- Laboratory result contents.
- Physical Examination result contents.
- Uploaded medical/result documents.
- Other unnecessary health or sensitive record details.

### 11.3 Schedule disclaimer

The following approved disclaimer appears persistently on the student Schedule page and at the bottom of every initial-assignment and schedule-change email:

> **Schedule Notice:** Your Laboratory and Physical Examination schedule may change due to priority scheduling requirements, including OJT, Tour, First Year/OVPSA scheduling, clinic closures, emergency closures, capacity adjustments, or other authorized rescheduling. Please check your verified email and the MedClinic student portal for the latest schedule.

The actual notification reason may additionally identify Specialized scheduling when Specialized caused the change. The approved disclaimer wording above remains unchanged.

## 12. Portal as Authoritative Schedule Source

The source-of-truth hierarchy is:

```text
Published/current MedClinic schedule
        -> portal schedule + notification/history
        -> mandatory email communication
```

Email is mandatory for the student account and schedule communication, but an email is not itself the scheduling record.

If an email is delayed, rejected, retried, or permanently fails:

- The committed schedule remains valid.
- The portal remains authoritative.
- Scheduling transactions are not rolled back.
- No replacement date is invented to make the email sendable.

## 13. Delivery Architecture and Failure Semantics

### 13.1 Outbox pattern

Schedule services must not send SMTP email inline as part of the scheduling transaction.

The required sequence is:

1. Validate and commit the schedule/schedule-change operation.
2. Create the portal notification.
3. Queue the corresponding email-outbox record when a verified destination exists.
4. Deliver asynchronously through the email outbox worker.
5. Retry transient failures using the existing retry mechanism.
6. Mark the email permanently failed only after the configured retry limit is exhausted.

The current outbox behavior, including retries and permanent failure after the configured attempt limit, should be extended rather than replaced.

### 13.2 Isolation

A notification-delivery failure must not roll back a valid scheduling change.

Where existing schedule/closure code isolates notification enqueue failures using savepoints or equivalent transactional boundaries, that resilience should be preserved.

Failures should create an auditable warning/error condition for operational review.

## 14. Administrator Delivery Monitoring

### 14.1 Dashboard-only visibility

Email delivery failures must not generate routine email alerts to administrators.

Instead, the administrator dashboard will show a compact **Email Delivery Issues** indicator/count for items that need attention.

The default count should focus on actionable failures, especially permanently failed messages, rather than cluttering the dashboard with all successful deliveries.

### 14.2 Delivery Status view

Administrators may open a dedicated delivery-status page containing operational details such as:

- Student name.
- Student Number.
- Masked destination email.
- Notification type.
- Related schedule event/context.
- Delivery state (`Pending`, `Sent`, `Retrying`, `Failed` or equivalent).
- Attempt count.
- Last delivery attempt.
- Simplified failure reason.

Successful messages may remain available for audit/history but should not dominate the default issue queue.

### 14.3 Controlled retry

Administrators may retry a permanently failed notification when appropriate.

Retry does not bypass verification. If the student's address is invalid, the student must replace and verify the new address through the normal student flow.

Before resending schedule content, stale-state protection in Section 10.3 applies.

### 14.4 No verification controls in delivery monitoring

The delivery-status page must not allow administrators to:

- Mark an address verified.
- Edit `email_verified_at`.
- Bypass mandatory onboarding.
- Change the student's schedule merely to resolve email delivery.

## 15. Audit Trail

The system must record enough audit information to reconstruct important verification and notification events without storing verification secrets.

Auditable events include, at minimum:

- Verification requested.
- Verification request resent/replaced.
- Verification completed.
- Verified email replaced.
- Verification rejected because of an email-ownership conflict.
- Schedule notification created.
- Schedule email queued.
- Schedule email delivered.
- Delivery retries.
- Permanent delivery failure.
- Administrator retry request.
- Stale failed-email retry rejected or replaced by a current-state notification.

Audit records must never contain raw verification tokens.

## 16. Data Model Direction

Implementation planning should extend the existing email-verification, student-notification, and `email_outbox` schema rather than introducing a second parallel notification system.

Expected data-model work includes:

- A database-enforced uniqueness rule for verified emails among active students.
- Any additional timestamps/metadata required for resend throttling and status presentation.
- Any additional outbox/delivery metadata required by the administrator delivery-status view, if not already available.
- Stable notification/event keys for initial assignment, current-state catch-up, displacement, closure, Manual Resolution, and manual rescheduling events.

The existing `students.email` and `students.email_verified_at` fields remain the authoritative verified-address fields.

The existing verification table remains the pending-verification mechanism unless implementation planning identifies a narrowly scoped schema change needed for security, replacement, or throttling.

## 17. Service and Route Direction

Implementation planning should preserve existing service boundaries where practical.

Likely areas of change include:

- Student authentication/authorization helper to expose/enforce onboarding completion.
- Student layout/router protection for unverified accounts.
- Email verification request service for cooldown, duplicate-address checks, and mandatory-flow messaging.
- Email verification completion service so token completion can work without an existing student session while still granting no login session.
- Verification API route/landing page to support any-device completion.
- Student email UI to remove optional/dismissible semantics and support mandatory onboarding/replacement.
- Schedule publication flow for initial-assignment email events.
- Priority displacement notification content.
- Clinic closure and Manual Resolution notification content.
- Administrator manual-rescheduling notification hooks.
- Student schedule page for the persistent disclaimer.
- Email outbox/admin repository/service for delivery-status monitoring and safe retries.

Implementation planning must inspect each current call path before changing behavior so notifications are generated once at the correct transaction boundary.

## 18. Important State Scenarios

### Scenario A: Student verifies before schedule publication

1. Student logs in.
2. Student is gated into Email Verification.
3. Student verifies successfully.
4. Portal unlocks.
5. No schedule exists yet, so no schedule catch-up email is needed.
6. Coordinator later publishes the schedule.
7. Initial Schedule portal notification and email are created.

### Scenario B: Schedule published before first login

1. Coordinator imports and publishes the student's schedule.
2. Portal schedule/history exists; no email is sent because the student is unverified.
3. Student later logs in and is forced to verify.
4. Verification succeeds.
5. MedClinic reads the latest authoritative schedule.
6. One current-state catch-up email is queued.

### Scenario C: Multiple changes before verification

1. Initial schedule is published.
2. Priority displacement changes it.
3. Another authorized change changes it again.
4. Student verifies afterward.
5. MedClinic sends only the latest authoritative schedule/status.
6. Historical changes remain visible in portal history.

### Scenario D: Student verifies while awaiting Manual Resolution

1. Emergency closure affects the current appointment.
2. Schedule enters `AWAITING_RESCHEDULE`/manual-resolution state.
3. Student verifies email before a replacement exists.
4. Catch-up email states that the prior schedule is affected and replacement is pending.
5. No old affected date is presented as active.
6. Administrator later completes Manual Resolution.
7. New authoritative replacement email is queued.

### Scenario E: Replacement email is pending

1. Student already has verified email A.
2. Student requests replacement email B.
3. Email B is pending verification.
4. A schedule displacement occurs.
5. Notification goes to verified email A.
6. Student verifies email B.
7. Email B becomes current for future notifications.

### Scenario F: Failed email becomes stale

1. Schedule-change email for September 10 fails permanently.
2. Student is later moved to September 18.
3. Administrator opens Email Delivery Issues.
4. Administrator attempts to retry the old failure.
5. MedClinic detects that the September 10 content is stale.
6. The obsolete message is not resent.
7. A current-state September 18 notification can be queued instead.

## 19. Testing Requirements

Implementation must include automated coverage for the mandatory behavior.

### 19.1 Mandatory access gate

Test that:

- New active students are unverified after import.
- Student Number + DOB authentication may succeed while portal onboarding remains incomplete.
- Unverified students are redirected from Schedule, Notifications, Results, and upload functionality.
- Verification-related routes and logout remain accessible.
- Verified students regain normal access.

### 19.2 Verification security

Test:

- Valid verification.
- Verification from a different browser/device with no student session.
- Successful verification does not create a student login session on the verifying device.
- Expired token rejection.
- Already-used token rejection.
- New request invalidates previous pending token.
- 60-second resend cooldown.
- Server-side throttling.
- No raw tokens in persisted/audit data.

### 19.3 Email ownership

Test:

- Candidate email normalization.
- Request rejected when address already belongs to another active verified student.
- Concurrent verification race permits only one active owner.
- Replacement keeps old address active until success.
- Failed/expired replacement does not remove old verified address.
- Reactivation detects active-address conflicts.

### 19.4 Schedule notification behavior

Test:

- Initial schedule publication to an already verified student.
- Publication to an unverified student does not fail scheduling.
- Late first verification sends one current-state catch-up email.
- Multiple historical changes do not replay stale emails.
- Priority displacement email uses old/new dates and correct reason.
- Planned closure automatic rescheduling email.
- Emergency closure awaiting-reschedule email.
- Verification while `AWAITING_RESCHEDULE` sends unresolved current state.
- Manual Resolution completion sends the final replacement schedule.
- Administrator-authorized manual rescheduling notification.
- First Year Laboratory location is correct where applicable.

### 19.5 Delivery reliability

Test:

- SMTP failure cannot roll back a schedule change.
- Portal notification persists even when email enqueue/delivery warns or fails according to the existing isolation policy.
- Outbox retries transient failures.
- Permanent failure becomes visible to administrators.
- Administrator retry is authorized correctly.
- A stale failed notification is not resent as current.
- Current-state replacement notification is idempotent.

### 19.6 Authorization

Test that:

- Students cannot access admin delivery monitoring.
- Coordinators cannot access administrator-only retry controls unless a future policy explicitly grants it.
- Administrators cannot use any API to mark a student email verified manually.

## 20. Rollout Assumption

The system is not yet deployed and this design assumes there are no production student records that require legacy backfill.

Therefore mandatory verification becomes the default behavior from the first deployment containing this change.

No temporary grandfathering period, mass verification migration, or optional-email compatibility mode is required.

Development/test data may require migration-safe handling, but it must not weaken the final invariant for active production students.

## 21. Acceptance Criteria

The design is satisfied when all of the following are true:

1. A newly imported active student can authenticate but cannot enter the normal portal until an email is verified.
2. Verification works from any device using a secure, single-use, 30-minute token without logging that device into MedClinic.
3. Verification resends are subject to a 60-second cooldown and server-side throttling.
4. One normalized verified email cannot belong to two active students.
5. Students cannot remove or disable their verified notification email; replacement requires verification while the old address remains active.
6. Coordinators can still import/publish using the unchanged nine-column CSV.
7. Initial schedule publication sends an email when the student is already verified.
8. First verification after publication sends only the latest authoritative schedule/status.
9. Priority displacement, closures, emergency closures, Manual Resolution completion, and authorized manual rescheduling create appropriate portal and email notifications.
10. `AWAITING_RESCHEDULE` is communicated as unresolved; no obsolete date is presented as active and no tentative replacement is invented.
11. Schedule emails contain actionable scheduling details and the approved disclaimer but no DOB or medical-result contents.
12. SMTP/email failure cannot roll back a valid schedule change.
13. Administrators see actionable delivery problems inside the dashboard without receiving routine failure emails.
14. Administrator retries cannot resend stale scheduling information as though it were current.
15. No administrator or coordinator can bypass mailbox ownership verification.
16. Important verification, notification, retry, and delivery outcomes are auditable without persisting raw verification tokens.

## 22. Approved Design Decisions

The following decisions were explicitly approved during design clarification:

- Mandatory email verification is enforced on student first login; coordinator import and scheduling are not blocked by missing email.
- Every active unverified student must complete verification before normal portal access.
- The schedule disclaimer appears on the Schedule page and in schedule emails.
- Every meaningful schedule state change creates portal/email communication as applicable.
- Scheduling never rolls back because SMTP/email delivery fails.
- Any valid email provider is allowed; verification is not restricted to institutional addresses.
- Old verified email remains active during replacement.
- One verified email may belong to only one active student account.
- First verification sends only the latest authoritative state, not stale missed-email history.
- If current status is `AWAITING_RESCHEDULE`, the catch-up email communicates that unresolved state.
- Schedule emails contain useful scheduling details while excluding unnecessary sensitive information.
- Only mailbox possession through the verification link can verify an address; there is no administrator bypass.
- Verification links expire after 30 minutes; resend cooldown is 60 seconds with server-side anti-spam throttling.
- Students cannot remove or disable their verified email without replacing it.
- Administrator delivery monitoring is dashboard-only; routine failures do not email administrators.
- Verification links can be completed from another device/browser without granting portal access on that device.

## 23. Implementation Planning Gate

This document is the approved **design specification only**. It intentionally does not contain the task-by-task implementation plan and does not authorize code changes by itself.

After this design specification is reviewed, implementation planning should inspect the repository's current migrations, student authentication, email-verification service/routes, student layout, schedule publication path, priority displacement service, clinic-calendar/Manual Resolution paths, notification repository, and email outbox/admin UI before defining exact file-by-file implementation tasks.
