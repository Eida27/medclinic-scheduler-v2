# Staff Account Security, Onboarding, Recovery, and Deletion Design

**Date:** 2026-08-25  
**Status:** Approved design, ready for implementation planning  
**Repository:** `Eida27/medclinic-scheduler-v2`

## 1. Purpose

MedClinic currently allows an administrator to create Admin, Coordinator, and Clinic Staff users with a temporary password, but those accounts immediately behave like ordinary active accounts. The Users tab also exposes Activate/Deactivate rather than a permanent account-deletion lifecycle.

This design adds a complete staff-account security lifecycle for a fresh MedClinic installation:

- mandatory staff email verification;
- mandatory replacement of administrator-issued temporary passwords;
- server-enforced onboarding restrictions;
- ongoing password changes for all staff roles;
- self-service forgot-password recovery through verified email;
- administrator fallback temporary-password reset;
- immediate session revocation for security-sensitive changes;
- administrator-managed email correction with re-verification;
- permanent account deletion while preserving historical attribution;
- safe first-Administrator bootstrap for a fresh database;
- reuse of the existing email delivery worker without coupling staff identity logic to student identity logic.

The roles covered by this design are `ADMIN`, `COORDINATOR`, and `CLINIC_STAFF`.

## 2. Context and Existing Constraints

The current repository has several architectural constraints that shape the solution:

1. `users` is both the login identity table and the referenced historical actor table.
2. Appointments, result records, audit records, academic-year records, calendar records, and other historical entities reference `users(id)`, including some non-null foreign keys. A literal `DELETE FROM users` would therefore either fail or destroy attribution semantics.
3. Staff sessions are stateless JWTs with an eight-hour lifetime. The current token has no credential/session generation, so changing a password alone does not reliably revoke an already-issued token.
4. `requireUser()` already re-authorizes the JWT against the current database user, which provides a central place to enforce account state.
5. Student email verification already implements secure random tokens, SHA-256 token hashes, expirations, resend cooldowns, throttling, encrypted verification message bodies, an email outbox, retry handling, and audit events.
6. `email_outbox.student_number` is nullable, so the email transport itself can support staff messages without pretending staff are students.
7. The current production-style seed inserts ready-to-use System Admin, Clinic Staff, and Coordinator accounts with known development passwords. That conflicts with the mandatory onboarding model and must not remain the first-installation mechanism.

## 3. Goals

The implementation must satisfy all of the following:

- A newly created staff account can authenticate with the administrator-issued temporary password but cannot use normal MedClinic features until required onboarding is complete.
- Email verification must occur before the temporary password can be replaced.
- Once fully onboarded, any Admin, Coordinator, or Clinic Staff user can change their password at any time by providing the current password.
- A fully onboarded user who forgets their password can use a verified-email reset flow.
- An Administrator can issue a replacement temporary password as a fallback. This preserves existing email verification but forces password replacement again.
- An Administrator can correct a staff email address. The new address must be verified before full access is restored.
- Activate/Deactivate is removed from the Users experience and replaced with permanent account deletion.
- Deleting an account must immediately remove login capability, invalidate security tokens and sessions, remove the account from active user management, and release its email address for reuse.
- Historical records must continue to identify the deleted user's preserved name/role/clinic attribution.
- An Administrator cannot delete their own current account and cannot delete the final remaining Administrator.
- The first Administrator of a fresh installation must be bootstrapped securely without a pre-existing Administrator.
- Existing student email verification and schedule notification behavior must continue to work.

## 4. Non-Goals

This design intentionally does not add:

- user self-service email editing;
- user self-service role or clinic changes;
- password complexity rules beyond the approved length/difference requirements;
- multi-factor authentication;
- remembered-device management;
- a general-purpose session-management screen;
- account reactivation after deletion;
- temporary account suspension/deactivation;
- student authentication changes except where shared email-outbox infrastructure requires regression-safe generalization.

## 5. Chosen Architecture

Use a **dedicated staff-account lifecycle with shared email delivery**.

Staff verification, onboarding, credential reset, and deletion are implemented as staff-specific domain logic and staff-specific token tables. Student verification remains a separate subsystem. Both use the same `email_outbox` delivery worker.

This creates three clean boundaries:

- **Staff identity/security:** staff user state, verification, password changes, resets, deletion, bootstrap.
- **Student identity/security:** existing student verification and student portal behavior, unchanged in semantics.
- **Email transport:** shared queue, encryption/decryption support, retry, delivery status, and failure handling.

This is preferred over generalizing student identity verification into a universal identity subsystem because the current student implementation is strongly student-number-oriented and already working. It is also preferred over placing ad-hoc token fields directly on `users`, because token history, supersession, throttling, replay prevention, and auditing are clearer in dedicated tables.

## 6. Staff Account State Model

Account access is derived from database state, not from a UI-only status flag.

### 6.1 States

| State | `deleted_at` | `email_verified_at` | `must_change_password` | Login allowed? | Normal MedClinic access? |
|---|---|---|---|---|---|
| Pending email verification | `NULL` | `NULL` | `TRUE` | Yes, with temporary password | No |
| Email verified / password change required | `NULL` | Set | `TRUE` | Yes | No |
| Fully onboarded | `NULL` | Set | `FALSE` | Yes | Yes, subject to role/clinic authorization |
| Email changed / re-verification required | `NULL` | `NULL` | Usually `FALSE` unless already requiring password change | Yes, with current password | No |
| Admin reset / password change required | `NULL` | Preserved if already verified | `TRUE` | Yes, with new temporary password | No |
| Deleted identity tombstone | Set | Cleared | Irrelevant | No | No |

The central restriction is:

```text
onboarding_required = email_verified_at IS NULL OR must_change_password = TRUE
```

A non-deleted account may authenticate while `onboarding_required` is true, but it receives only restricted onboarding/account-security access.

### 6.2 Ordering

For first-time onboarding, the required order is fixed:

1. sign in with the administrator-issued temporary password;
2. verify the staff email address;
3. replace the temporary password;
4. receive full role-based access.

The temporary-password replacement action is unavailable until email verification succeeds.

### 6.3 Password Policy

For both temporary-password replacement and later password changes:

- minimum length: 8 characters;
- maximum length: 100 characters;
- new password must differ from the current password;
- confirmation must exactly match the new password;
- no forced uppercase, lowercase, number, or special-character composition rule.

Passwords continue to be stored with bcrypt using the repository's established cost.

## 7. `users` Schema Evolution

Because the application is assumed to start from a completely fresh operational database, there is no need to grandfather legacy staff users as already verified or onboarded.

The existing `users` table remains the stable historical identity table, but gains explicit account-security and tombstone fields.

Recommended fields:

```text
email_verified_at        TIMESTAMPTZ NULL
must_change_password     BOOLEAN NOT NULL DEFAULT TRUE
credential_version       INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0)
deleted_at               TIMESTAMPTZ NULL
deleted_by               UUID NULL REFERENCES users(id)
```

The existing `email` and `password_hash` columns must become nullable only for deleted tombstones. A database check should enforce that a non-deleted account has both an email and password hash, while a deleted identity does not retain usable login credentials.

Recommended invariant:

```text
if deleted_at IS NULL:
    email IS NOT NULL
    password_hash IS NOT NULL
else:
    email IS NULL
    password_hash IS NULL
```

`full_name`, `role`, and historical clinic attribution remain on a tombstone so historical records can still explain who performed an action.

### 7.1 Email Uniqueness

Active/non-deleted staff emails must be normalized and unique case-insensitively. The database should enforce uniqueness on normalized email for `deleted_at IS NULL` users. Once deletion clears the email, the former address can be reused by a newly created account.

### 7.2 Removal of Deactivation State

The staff-account lifecycle no longer has a user-facing Active/Inactive state. Application code must stop using `users.is_active` as the staff-account control mechanism, and the schema should remove that column once all staff code paths use `deleted_at` and onboarding state instead.

Deletion is permanent from the account-management perspective. A deleted identity cannot be reactivated.

## 8. Dedicated Staff Security Tables

### 8.1 Staff Email Verification Requests

Create a dedicated table similar in spirit to the student verification table:

```text
staff_email_verifications
- id UUID PRIMARY KEY
- user_id UUID NOT NULL REFERENCES users(id)
- pending_email VARCHAR(254) NOT NULL
- token_hash CHAR(64) NOT NULL UNIQUE
- expires_at TIMESTAMPTZ NOT NULL
- consumed_at TIMESTAMPTZ NULL
- invalidated_at TIMESTAMPTZ NULL
- created_at TIMESTAMPTZ NOT NULL
```

Rules:

- generate 32 cryptographically random bytes and encode as URL-safe text;
- store only SHA-256(token), never the plaintext token;
- token lifetime: 30 minutes, matching the established student pattern;
- resend cooldown: 60 seconds;
- throttle: at most 5 verification requests per 15-minute window per staff account;
- a successful request supersedes any older still-valid request for the same account;
- email correction invalidates all older verification requests and obsoletes their queued outbox messages;
- successful verification consumes the matching request and invalidates remaining outstanding requests;
- deleted accounts cannot be verified.

### 8.2 Staff Password Reset Requests

Create a separate table so password-reset purpose cannot be confused with email-verification purpose:

```text
staff_password_resets
- id UUID PRIMARY KEY
- user_id UUID NOT NULL REFERENCES users(id)
- token_hash CHAR(64) NOT NULL UNIQUE
- expires_at TIMESTAMPTZ NOT NULL
- consumed_at TIMESTAMPTZ NULL
- invalidated_at TIMESTAMPTZ NULL
- created_at TIMESTAMPTZ NOT NULL
```

Rules:

- use the same random-token and token-hash approach;
- reset token lifetime: 30 minutes;
- only fully onboarded, non-deleted users with a verified email are eligible for self-service reset;
- public request responses never reveal whether an eligible account exists;
- repeated requests are cooldown/throttle controlled to avoid email flooding;
- successful reset consumes the current token, invalidates all other reset tokens for the user, and increments `credential_version`;
- Admin temporary-password reset invalidates outstanding self-service reset tokens;
- deletion invalidates all outstanding reset tokens and obsoletes queued reset messages.

Pending-onboarding users who lose their temporary password do not use self-service Forgot Password. Their recovery path is the approved Administrator temporary-password reset.

## 9. Shared Email Outbox Changes

Continue using the existing `email_outbox` and worker rather than creating a second staff mail queue.

`student_number` already being nullable makes this transport-compatible with staff messages. Staff security messages should instead identify their source through the existing source metadata fields and dedicated staff request IDs.

### 9.1 Message Classification

Retain existing student/general behavior and add a staff-security message classification, for example:

```text
message_kind = 'STAFF_SECURITY'
source_type  = 'STAFF_EMAIL_VERIFICATION' | 'STAFF_PASSWORD_RESET'
source_id    = staff request UUID
```

Do not reuse the current student-specific `VERIFICATION` subject/body constraint for staff.

### 9.2 Sensitive Message Body Storage

Verification and reset links contain bearer tokens and must not be stored in plaintext outbox bodies. Add a staff security encrypted-body field or generalize the current verification-body encryption helper so staff security messages can use encrypted content without changing student semantics.

A staff-security outbox row should store a safe placeholder in ordinary body columns and the actual message in encrypted form until delivery. After successful delivery or obsolescence, sensitive encrypted content may be cleared using the same security principle already applied to student verification mail.

### 9.3 Delivery Failure

Failure to deliver a verification email does not roll back account creation. The account remains in Pending email verification state, the delivery remains retryable/actionable through the existing delivery pipeline, and both the affected user and an Administrator can request a new verification message.

Temporary passwords must never be placed in verification or password-reset emails.

## 10. Session and Credential Revocation

Add `credential_version` to staff JWT claims.

At login:

1. authenticate email/password against the current non-deleted user;
2. issue a JWT containing the current `credential_version`;
3. include normal identity/role/clinic claims as today.

On every protected server authorization, compare JWT `credential_version` with the current database value. A mismatch is treated as an unauthenticated/stale session.

Increment `credential_version` when a security event must revoke existing sessions, including:

- first temporary-password replacement;
- ordinary password change;
- successful self-service password reset;
- Administrator temporary-password reset;
- administrator-managed email change;
- account deletion.

### 10.1 Current-Browser Behavior

For an ordinary password change performed by the signed-in user:

- increment `credential_version`;
- issue a replacement JWT for the current browser using the new version;
- all other previously issued sessions become invalid.

For self-service Forgot Password:

- increment `credential_version` after successful reset;
- do not automatically sign the browser in;
- send the user to Login with the new password.

For Admin reset, email change, and deletion, the target user's existing sessions are invalid immediately.

## 11. Authorization and Onboarding Enforcement

The onboarding restriction must be enforced server-side. Hiding the sidebar is insufficient.

### 11.1 Authentication vs Operational Authorization

Introduce a distinction between:

- **authenticated staff session:** valid password/JWT, non-deleted user, matching credential version;
- **operational user:** authenticated staff session with verified email and `must_change_password = FALSE`.

Existing `requireUser()` semantics should become operational authorization so existing MedClinic APIs automatically reject restricted onboarding users.

Add a narrowly scoped restricted-session helper for onboarding/security endpoints. Only those endpoints may accept an authenticated user who is not yet operational.

### 11.2 Route Behavior

`src/proxy.ts` may continue to perform inexpensive cookie/JWT cryptographic checks, but database-backed account-state enforcement belongs in the server authorization layer and protected layouts/actions.

Protected dashboard layouts must redirect an authenticated restricted user to:

```text
/account/onboarding
```

Normal write APIs must return a stable onboarding-required error rather than execute business logic.

The onboarding page and Logout remain available while restricted.

## 12. First Administrator Bootstrap

A fresh installation cannot depend on an existing Administrator to create the first Administrator.

Remove ready-to-use staff accounts from the normal database seed. The seed should populate reference/catalog data only.

Add a one-time bootstrap command, exposed as an npm script such as:

```text
npm run admin:bootstrap
```

The command reads deployment configuration for:

- bootstrap Administrator full name;
- bootstrap Administrator email;
- bootstrap temporary password.

It must:

1. run only when no non-deleted Administrator exists;
2. validate email and password using the same production rules;
3. bcrypt-hash the temporary password;
4. create the Administrator with `email_verified_at = NULL` and `must_change_password = TRUE`;
5. initialize `credential_version`;
6. create and queue the first staff email-verification request;
7. audit the bootstrap event without storing the password/token;
8. refuse subsequent bootstrap attempts once a non-deleted Administrator exists.

The first Administrator then follows the same lifecycle as every other newly created staff account:

```text
bootstrap -> login with temporary password -> verify email -> replace temporary password -> full Admin access
```

Test and browser fixture users may still be created explicitly by test fixtures. They must not be represented as production bootstrap credentials in the normal reference-data seed.

## 13. Administrator-Created User Flow

When an onboarded Administrator creates an `ADMIN`, `COORDINATOR`, or `CLINIC_STAFF` account:

1. validate full name, normalized email, role, clinic-scope rules, and temporary password;
2. reject a duplicate non-deleted staff email;
3. bcrypt-hash the temporary password;
4. insert the user with unverified email and `must_change_password = TRUE`;
5. create a staff verification request in the same database transaction;
6. queue the verification email;
7. write the account-created and verification-requested audit records;
8. return the account in Pending verification state.

The temporary password is provided by the Administrator outside the verification email.

## 14. Onboarding User Experience

### 14.1 Login

A pending staff account may log in with the correct temporary password. Authentication succeeds, but the user is redirected immediately to `/account/onboarding`.

The restricted shell displays a prominent warning such as:

> **Secure your account before continuing.** This account is using a temporary password or has an email address that still requires verification. Complete the security steps below before accessing MedClinic.

Normal dashboard navigation is suppressed. The user has access only to the onboarding/security actions and Logout.

### 14.2 Onboarding Steps

The page displays state-driven steps:

**Step 1 — Verify email**

- show the masked account email;
- show Pending/Verified status;
- allow Resend when cooldown permits;
- show retry timing when throttled.

**Step 2 — Replace temporary password**

- disabled until email is verified;
- fields: Current temporary password, New password, Confirm new password;
- successful replacement increments `credential_version`, sets `must_change_password = FALSE`, and issues a fresh current-browser session.

If the email is verified but password replacement is still required, the user returns directly to Step 2 on subsequent logins.

If only email re-verification is required after an Administrator email change and `must_change_password` is already false, successful verification restores normal access without forcing an unrelated password change.

## 15. Staff Email Verification Confirmation

Use a public staff confirmation page, separate from the student route, for example:

```text
/staff/email-verification/confirm?token=...
```

The page should consume the token through a server-side POST/action rather than exposing verification mutation logic to arbitrary client code.

On successful confirmation:

1. hash the presented token;
2. lock and load the matching request/user;
3. reject expired, consumed, invalidated, deleted-user, or email-mismatch requests;
4. set `users.email_verified_at`;
5. consume the request;
6. invalidate/obsolete remaining staff verification requests/messages for that account;
7. audit completion.

If `must_change_password = TRUE`, the next authenticated destination is `/account/onboarding` Step 2. If no password change is required, the user may resume normal access.

Expired, invalid, superseded, or already-used links show a safe failure state and do not expose internal account details.

## 16. Ongoing Account Page

Add an `/account` page available to all fully onboarded Admin, Coordinator, and Clinic Staff users.

Display read-only identity/security information:

- full name;
- email;
- role;
- clinic scope where applicable;
- email verification status.

Primary action: **Change Password**.

Fields:

- Current password;
- New password;
- Confirm new password.

Successful change:

1. verify current password;
2. enforce approved password policy;
3. hash/store the new password;
4. increment `credential_version`;
5. invalidate outstanding self-service reset requests;
6. audit the change;
7. issue a replacement current-browser JWT.

The email does not need to be reverified for a normal password change.

## 17. Forgot Password — Self-Service Recovery

Add **Forgot password?** to the staff Login page.

### 17.1 Request

The user enters an email. The public response is always equivalent to:

> If an eligible account exists for that email, a password reset message has been sent.

Never reveal whether the email is unknown, deleted, unverified, or still in temporary-password onboarding.

For an eligible account (`deleted_at IS NULL`, email verified, `must_change_password = FALSE`):

1. invalidate/supersede older reset requests as appropriate;
2. create a new hashed reset token with expiry;
3. queue an encrypted staff-security reset email;
4. audit the request using masked/hashed address metadata rather than plaintext token data.

### 17.2 Completion

The reset page accepts New password + Confirm new password. It does not need the old password because possession of the valid one-time email token is the recovery proof.

Successful reset:

1. atomically validate and consume the token;
2. hash/store the new password;
3. leave verified-email state unchanged;
4. leave `must_change_password = FALSE`;
5. increment `credential_version`;
6. invalidate all other reset requests;
7. obsolete pending reset emails tied to superseded requests;
8. audit completion;
9. redirect to Login.

## 18. Administrator Temporary-Password Reset

The Users tab exposes **Reset Temporary Password**.

The Administrator enters a new temporary password and confirms the action.

For any non-deleted target account:

1. validate the temporary password;
2. bcrypt-hash/store it;
3. set `must_change_password = TRUE`;
4. preserve `email_verified_at` if already verified;
5. increment `credential_version` to revoke all current sessions;
6. invalidate outstanding self-service password-reset requests;
7. audit the Admin reset.

The target then logs in with the new temporary password. If the email is already verified, onboarding opens directly at Replace Temporary Password. The user does not have to verify the same email again.

For a user still pending email verification, the verified state remains pending and onboarding continues in the normal order.

## 19. Administrator Email Correction

The Users tab exposes **Edit Email** for staff-account management.

When the Administrator changes a target user's email:

1. normalize and validate the new address;
2. reject conflicts with another non-deleted user's email;
3. update the login email;
4. clear `email_verified_at`;
5. preserve `must_change_password` exactly as it was;
6. invalidate all old staff email-verification requests and obsolete their queued messages;
7. create and queue a verification request for the new email;
8. increment `credential_version` to revoke existing sessions;
9. audit the email change using masked/hashed old/new address metadata.

The old email stops working for login immediately. The new email can authenticate with the current password but remains restricted until verified.

Changing email alone does not change the password.

## 20. Users Tab Redesign

Remove the current Activate/Deactivate control and Active/Inactive account state from staff management.

Each row should expose:

- Name;
- Email;
- Role;
- Clinic scope;
- Account status;
- context-appropriate actions.

Statuses:

- **Pending verification** — `email_verified_at IS NULL`;
- **Password change required** — email verified and `must_change_password = TRUE`;
- **Active** — email verified and `must_change_password = FALSE`.

Actions may include:

- Edit Email;
- Resend Verification when verification is pending;
- Reset Temporary Password;
- Delete.

Deleted identities do not appear in this active Users table.

## 21. Permanent Account Deletion With Historical Attribution

Because many historical records reference `users(id)`, deletion is implemented as **credential destruction plus an immutable historical identity tombstone**, not as a reversible deactivation and not as a physical row delete.

To the account-management/authentication system, the account is permanently deleted.

### 21.1 Delete Confirmation

Clicking Delete opens a destructive confirmation dialog that shows the target's name, email, and role and explains that:

- MedClinic access will be permanently removed;
- the account cannot be reactivated;
- historical records remain for audit/attribution;
- the email address becomes reusable.

The Administrator must explicitly click **Delete account** to continue.

### 21.2 Transactional Delete Operation

Inside one database transaction:

1. lock the target user;
2. reject self-deletion of the currently signed-in Administrator;
3. if the target is an Administrator, lock/check the active Administrator set and reject deletion when it would leave zero non-deleted Administrators;
4. write the deletion audit event with the deleting actor and non-sensitive target metadata;
5. invalidate all verification/reset token requests;
6. obsolete any still-pending staff security emails for the target;
7. increment `credential_version`;
8. clear `password_hash`;
9. clear the login email so it can be reused;
10. clear `email_verified_at`;
11. set `deleted_at` and `deleted_by`;
12. preserve `id`, `full_name`, `role`, and historical clinic attribution.

There is no Undelete/Reactivate operation.

If the same person later needs access, an Administrator creates a completely new account with a new user ID.

### 21.3 Concurrency Safety

Last-Administrator protection must be enforced in the deletion transaction, not only in the UI. Concurrent attempts to delete different Administrators must not both observe an outdated count and remove the final Administrator set.

The implementation should use row/advisory locking or an equivalent transactional serialization strategy around the Administrator-set check.

### 21.4 Historical Display

Historical joins continue resolving the tombstone user ID. UIs that display actor attribution should be able to show the preserved name/role plus a Deleted indicator rather than failing or displaying an unrelated replacement account.

## 22. Service and API Boundaries

Avoid expanding the current generic `/api/users` PATCH behavior into a catch-all security endpoint. Keep sensitive operations explicit.

Recommended route/service responsibilities:

```text
POST   /api/users
       Admin creates a staff account

PATCH  /api/users/[id]/email
       Admin changes target email and triggers re-verification

POST   /api/users/[id]/resend-verification
       Admin resends target verification

POST   /api/users/[id]/temporary-password-reset
       Admin sets a new temporary password

DELETE /api/users/[id]
       Admin permanently deletes account credentials / tombstones identity

GET    /api/account
       Current operational user's account summary

POST   /api/account/change-password
       Current operational user changes password

GET    /api/account/onboarding
       Restricted authenticated user's current onboarding state

POST   /api/account/onboarding/resend-verification
       Restricted authenticated user resends own verification

POST   /api/account/onboarding/replace-temporary-password
       Restricted authenticated user replaces temporary password

POST   /api/auth/forgot-password
       Generic public reset request

POST   /api/auth/reset-password
       Consume reset token and set new password
```

The public staff email-confirmation page may use a dedicated server action/service rather than exposing mutation as a GET endpoint.

Domain services should own transactions and invariants. Repositories should remain persistence-oriented.

## 23. Audit Events

Add explicit audit actions for staff-security changes. Suggested event names:

```text
STAFF_USER_CREATED
STAFF_EMAIL_VERIFICATION_REQUESTED
STAFF_EMAIL_VERIFICATION_RESENT
STAFF_EMAIL_VERIFIED
STAFF_EMAIL_CHANGED
STAFF_TEMP_PASSWORD_REPLACED
STAFF_PASSWORD_CHANGED
STAFF_PASSWORD_RESET_REQUESTED
STAFF_PASSWORD_RESET_COMPLETED
STAFF_TEMP_PASSWORD_RESET_BY_ADMIN
STAFF_USER_DELETED
STAFF_BOOTSTRAP_ADMIN_CREATED
```

Invalid/expired/replayed security-token attempts may also be audited where useful, but audit volume must not expose token material.

Audit metadata must never contain:

- plaintext passwords;
- password hashes;
- plaintext verification tokens;
- plaintext password-reset tokens;
- full sensitive encrypted email bodies.

Email addresses in security audit metadata should follow the established masked-address + SHA-256-address-hash pattern where possible.

## 24. Error Handling and Information Disclosure

### 24.1 Login

Continue using a generic login failure such as:

> Invalid email or password.

Do not distinguish unknown, deleted, or wrong-password accounts.

### 24.2 Forgot Password

Always return the same success-style public response regardless of account existence or eligibility.

### 24.3 Token Errors

Invalid, expired, consumed, invalidated, superseded, email-mismatched, or deleted-account tokens must fail safely. The UI may explain that the link is no longer valid and provide a safe resend/restart path, but must not reveal internal user state.

### 24.4 Email Delivery Failure

Email delivery failure does not create an inconsistent account state. Security state remains committed, the outbox owns retry/failure handling, and the user remains restricted until verification actually succeeds.

### 24.5 Administrator Validation

Admin actions return clear domain errors for:

- duplicate email;
- target not found/deleted;
- invalid password policy;
- self-deletion;
- last-Administrator deletion;
- verification cooldown/throttle;
- invalid clinic-scope/role combinations.

## 25. UI Navigation and Shell Behavior

### 25.1 Normal Operational User

The main shell adds an **Account** destination accessible to Admin, Coordinator, and Clinic Staff. It remains available after onboarding so users can change passwords at any time.

### 25.2 Restricted Onboarding User

The normal primary/sidebar navigation is not shown. The user sees only:

- onboarding/security content;
- account status/security warning;
- Logout.

Direct navigation to normal MedClinic routes is still rejected by server authorization.

## 26. Fresh Database and Seed Behavior

There is no legacy migration policy because the intended first real deployment starts from a fresh database.

The normal reference-data seed must not create ready-to-use human staff accounts. The existing seeded `System Admin`, `Clinic Staff`, and `Schedule Coordinator` credentials are development conveniences and must be removed from the production/reference seed path.

Test fixtures may create dedicated users explicitly and may bypass onboarding only through test-only setup helpers where the test is not about onboarding itself. Production runtime must never contain a hidden bypass that marks arbitrary new staff as verified/onboarded.

## 27. Testing Strategy

### 27.1 Database/Migration Tests

Verify:

- fresh migration chain succeeds;
- `users` security/tombstone invariants are enforced;
- normalized active email uniqueness works;
- deleted email addresses are reusable;
- verification/reset token constraints work;
- tombstoned users continue satisfying historical foreign keys;
- the final Administrator cannot be deleted;
- concurrent Administrator deletions cannot remove the final Administrator set;
- no normal seed produces ready-to-use human staff credentials.

### 27.2 Service/Integration Tests

Verify:

- Admin creation queues verification automatically;
- created staff starts Pending verification;
- restricted accounts can authenticate but cannot call normal MedClinic operations;
- verification succeeds once and replay fails;
- expired/superseded verification tokens fail;
- resend cooldown and 5-per-15-minute throttle work;
- replacing a temporary password is impossible before email verification;
- temporary-password replacement requires the current temporary password;
- successful onboarding yields normal role-based access;
- ordinary password change requires current password and revokes other sessions;
- Admin reset preserves verified email but forces password replacement;
- Admin reset invalidates old sessions and reset tokens;
- Forgot Password is generic for existing/non-existing/ineligible emails;
- fully onboarded users can complete self-service reset;
- pending onboarding users are not silently converted through self-service reset;
- reset token expiration/replay/supersession work;
- Admin email change clears verification, preserves password-change flag, revokes sessions, invalidates old verification links, and queues a new verification;
- Delete removes authentication, invalidates tokens/sessions, releases email, removes the account from active user listing, and preserves history;
- self-delete and last-Administrator delete fail;
- existing role/clinic-scope rules still apply.

### 27.3 Session Tests

Verify:

- matching JWT/database credential version authorizes;
- mismatched version rejects;
- password change issues a fresh current-browser version;
- old tokens from other browsers fail after password change/reset;
- deleted-user tokens fail even if cryptographically valid;
- onboarding restriction is derived from current database state rather than stale JWT flags.

### 27.4 Email Worker Regression Tests

Verify:

- existing student verification messages still encrypt/decrypt/send correctly;
- existing student schedule/general messages still send correctly;
- staff verification messages use the shared queue without a student number;
- staff reset messages use encrypted sensitive content;
- obsolete security messages are not sent;
- retry/permanent-failure behavior remains correct.

### 27.5 UI/Component Tests

Verify:

- Users no longer exposes Activate/Deactivate;
- Pending verification, Password change required, and Active badges render correctly;
- Edit Email works through the approved flow;
- Resend Verification appears only when applicable;
- Reset Temporary Password confirmation/form behaves correctly;
- Delete opens a destructive confirmation and surfaces safeguards;
- Account page is accessible to all three staff roles;
- restricted users see onboarding-only navigation;
- password forms show domain validation without leaking sensitive values.

### 27.6 Browser Acceptance Flow

Provide an end-to-end acceptance fixture covering:

1. fresh database/reference seed;
2. bootstrap first Administrator;
3. Admin login with temporary password;
4. Admin email verification;
5. Admin temporary-password replacement;
6. create Coordinator and Clinic Staff accounts;
7. complete their verification/onboarding;
8. normal Account password change;
9. self-service Forgot Password reset;
10. Admin fallback temporary-password reset;
11. Admin email correction and re-verification;
12. account deletion;
13. confirmation that deleted user cannot log in;
14. confirmation that the deleted email can be reused;
15. confirmation that historical records still resolve attribution.

## 28. Security Requirements

The implementation is not complete unless it preserves these security properties:

- all passwords are bcrypt-hashed;
- all verification/reset tokens are cryptographically random and stored only as hashes;
- security tokens are single-use and time-limited;
- queued token-bearing staff emails are encrypted at rest;
- temporary passwords are never emailed;
- Forgot Password does not disclose account existence;
- onboarding restrictions are enforced server-side;
- normal APIs cannot be used by restricted onboarding accounts;
- credential-version changes revoke stale sessions;
- deletion permanently removes authenticatable credentials;
- last-Administrator and self-delete safeguards are transactional;
- audit events contain no secret material;
- student email/security behavior is regression-tested after shared-outbox changes.

## 29. Expected Code Areas

The implementation plan should inspect and likely modify/add code around these existing areas:

```text
src/components/settings/UsersManager.tsx
src/components/layout/DashboardShell.tsx
src/components/layout/Sidebar.tsx
src/server/services/users.service.ts
src/server/repositories/users.repository.ts
src/server/services/auth.service.ts
src/server/auth/session.ts
src/server/auth/current-user.ts
src/proxy.ts
src/types/roles.ts
src/server/repositories/email-outbox.repository.ts
src/server/workers/email-outbox.worker.ts
src/server/services/student-email.service.ts       # regression/shared transport compatibility only
src/app/... login/account/settings/auth routes
scripts/db-seed.ts
database/seeds/001_reference_and_users.sql
```

New focused modules should be preferred over growing `users.service.ts` into a large mixed-responsibility security service. Likely new units include staff email verification, staff password recovery, staff account security, and first-Administrator bootstrap.

The detailed implementation plan will determine exact file names and test placement after re-inspecting current main at planning time.

## 30. Acceptance Criteria

The feature is accepted when all of the following are true:

1. A fresh installation contains no ready-to-use seeded human staff credentials.
2. The first Administrator can be created only through the one-time secure bootstrap path.
3. Every newly created real staff account starts with unverified email and a temporary-password requirement.
4. A pending account can log in but cannot access normal MedClinic functionality.
5. Email must be verified before temporary-password replacement.
6. Completing both required onboarding steps grants normal role-based access.
7. All staff roles can change their own password at any time after onboarding.
8. Regular password changes revoke other sessions while keeping the current browser signed in through a fresh token.
9. Fully onboarded users can use verified-email Forgot Password recovery.
10. Administrators can issue a new temporary password as a fallback without requiring repeat verification of an already verified email.
11. Administrators can correct an email; the new address must be verified and old verification links become unusable.
12. Users management shows Pending verification / Password change required / Active rather than Activate/Deactivate.
13. Account deletion permanently prevents login, revokes sessions/tokens, removes the account from active Users, and releases the email.
14. Historical actor references survive deletion and can identify the deleted actor as historical/deleted.
15. Administrators cannot delete themselves or the final remaining Administrator.
16. Student verification and notification delivery continue to pass regression tests.
17. Security-sensitive operations are audited without secret material.
18. Database, service, session, email worker, UI, and browser acceptance tests cover the approved lifecycle.

## 31. Final Design Decision

Implement **Approach 1: dedicated staff-account lifecycle plus shared email delivery**, using database-backed onboarding state, credential-version session revocation, separate staff verification/reset token tables, a one-time Administrator bootstrap, and permanent credential deletion with a historical identity tombstone.

This design intentionally treats account deletion as permanent even though the historical `users` row remains to satisfy referential integrity and audit attribution. The tombstone is not an inactive account and cannot be reactivated.
