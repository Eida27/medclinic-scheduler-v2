# Staff Login Brute-Force Protection Implementation Plan

**For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Protect the staff email/password login endpoint from brute-force and credential-stuffing attacks with durable PostgreSQL-backed throttling that works correctly across application restarts and concurrent requests.

The staff login must enforce two independent rolling failure buckets:

- normalized email: **5 failed attempts in 15 minutes**;
- client IP: **25 failed attempts in 15 minutes**.

The threshold-triggering request must be recorded and return HTTP `429`. Once either bucket is actively throttled, even correct credentials must not bypass the throttle until enough failures age out of the 15-minute window.

Invalid credentials must continue to use the generic `INVALID_CREDENTIALS` response and must never reveal whether the submitted email exists. Throttling must behave the same way for existing and nonexistent emails.

## Architecture

Keep authentication policy in `auth.service.ts`, but move rate-limit persistence and PostgreSQL locking into a focused repository.

Use a dedicated append-only failure table instead of adding lockout state to `users`. Each failed authentication writes two failure events: one for the normalized-email bucket and one for the client-IP bucket. Successful authentication clears only the normalized-email bucket; it must **not** clear the shared IP bucket, because one valid account must not be able to erase attack history for other accounts coming from the same IP.

Serialize attempts that share either bucket with PostgreSQL transaction-scoped advisory locks. Acquire the email and IP advisory locks in deterministic sorted order before reading counts or checking the password. This closes the burst-race where multiple simultaneous requests could all pass a pre-check before any of them records its failure.

Run the credential lookup and password comparison inside the same transaction while those bucket locks are held. Extend `findUserByEmail(...)` to accept an optional `PoolClient`, matching the existing `findUserById(...)` pattern.

Use the same client-IP extraction convention already used by the student login route: first `x-forwarded-for`, then `x-real-ip`, then `unknown`, capped at 64 characters. The production reverse proxy must overwrite forwarding headers and the Next.js application port must not be exposed directly to untrusted clients. Reverse-proxy configuration itself is outside this code task.

## Technology

- Next.js 16.2.6 App Router
- TypeScript
- PostgreSQL through `pg`
- `bcryptjs`
- Vitest 4.1.8
- Existing `transaction(...)`, `AppError`, `dataResponse(...)`, and `errorResponse(...)` infrastructure

## Current Repository Evidence

At the time this plan is written:

- `src/app/api/auth/login/route.ts` parses email/password, calls `authenticate(email, password)`, creates the session token, and sets the staff session cookie. It does not pass client IP information.
- `src/server/services/auth.service.ts` normalizes the email, looks up the user, runs `bcrypt.compare(...)`, and returns `INVALID_CREDENTIALS` on failure. It has no throttling.
- `src/server/repositories/users.repository.ts` exposes `findUserByEmail(email)` without a transaction client, while `findUserById(id, client?)` already supports one.
- `src/app/api/student-auth/login/route.ts` extracts `x-forwarded-for`, then `x-real-ip`, then `unknown`, and caps the value at 64 characters.
- Current student throttling uses a row-locked `(student_number, ip_address)` counter. Do not reuse that schema for staff login because the staff requirement needs independent account-wide email and aggregate IP buckets.
- The latest migration is `026_remove_priority_groups_and_legacy_scheduling.sql`, so this task uses migration `027`.

## Global Constraints

- Staff `/api/auth/login` only.
- Do not change student authentication or `student_login_attempts` behavior.
- Do not add CAPTCHA, MFA, WebAuthn, or external rate-limit services in this task.
- Do not add permanent account-lock columns to `users`.
- Do not change password-reset or staff-onboarding behavior.
- Do not change session duration, cookie name, onboarding redirects, or credential-version semantics.
- Preserve `INVALID_CREDENTIALS` with HTTP `401` for ordinary invalid logins.
- Add `STAFF_LOGIN_THROTTLED` with HTTP `429` for active throttles.
- `STAFF_LOGIN_THROTTLED` must include `details.retryAfterSeconds` and the route must emit the same value in the HTTP `Retry-After` header.
- Email comparison/bucketing is `trim().toLowerCase()`.
- A nonexistent email consumes the same email/IP failure budgets as an existing account.
- Correct credentials do not bypass a bucket that is already throttled.
- A successful login below the threshold clears recent failures for that normalized-email bucket only.
- A successful login does not clear the IP bucket.
- The fifth recent failure for one normalized email returns `429`.
- The twenty-fifth recent failure from one IP returns `429`.
- A failure event ages out exactly after 15 minutes for throttling purposes.
- Old failure rows may be pruned after 24 hours; retention is not part of authentication semantics.
- Do not place `BEGIN` or `COMMIT` inside migration `027`; the existing migration runner owns the migration transaction.

## File Map

Create:

- `database/migrations/027_staff_login_brute_force_protection.sql`
- `src/server/repositories/staff-login-throttle.repository.ts`
- `src/server/repositories/staff-login-throttle.repository.integration.test.ts`
- `src/server/security/request-ip.ts`
- `src/server/security/request-ip.test.ts`

Modify:

- `src/server/repositories/users.repository.ts`
- `src/server/services/auth.service.ts`
- `src/server/services/auth.service.integration.test.ts`
- `src/app/api/auth/login/route.ts`
- `src/app/api/staff-security-routes.test.ts`

Do not modify:

- `src/server/services/student-auth.service.ts`
- `src/server/repositories/student-auth.repository.ts`
- `database/migrations/008_automated_scheduling_and_student_portal.sql`

---

# Task 1: Add durable dual-bucket failure persistence

## 1.1 Write the repository integration tests first

- [ ] Create `src/server/repositories/staff-login-throttle.repository.integration.test.ts`.

Cover these repository contracts:

1. normalized email variants map to one email bucket;
2. failures are counted independently for `EMAIL` and `IP` scopes;
3. the fifth email failure becomes throttled;
4. the twenty-fifth IP failure becomes throttled even when every attempt uses a different email;
5. failures older than 15 minutes no longer count;
6. clearing an email bucket removes only `EMAIL` failures for that account and leaves `IP` failures intact;
7. pruning removes rows older than 24 hours without affecting recent rows;
8. two concurrent transactions targeting the same email/IP cannot both enter the protected section at once.

Use reserved test-only addresses and documentation IP ranges such as:

```ts
const email = "staff-throttle@security.test";
const ipAddress = "198.51.100.20";
```

Clean up only rows belonging to test bucket keys. Do not truncate the whole security table from a test.

The concurrency test should demonstrate blocking, not merely call the functions sequentially. One transaction should acquire both bucket advisory locks, a second transaction should begin acquiring the same buckets, and the test should verify that the second remains blocked until the first commits/rolls back.

- [ ] Run the focused test before implementation and confirm it fails because the migration/repository does not exist yet:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/repositories/staff-login-throttle.repository.integration.test.ts
```

Do not proceed from a green test caused by accidentally importing unrelated behavior.

## 1.2 Create migration 027

- [ ] Create `database/migrations/027_staff_login_brute_force_protection.sql`.

Use this schema shape:

```sql
CREATE TABLE staff_login_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(10) NOT NULL
    CHECK (scope IN ('EMAIL', 'IP')),
  bucket_key VARCHAR(320) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX staff_login_failures_bucket_time_idx
  ON staff_login_failures (scope, bucket_key, occurred_at DESC);

CREATE INDEX staff_login_failures_occurred_at_idx
  ON staff_login_failures (occurred_at);
```

Do not reference `users(email)` with a foreign key. Unknown email addresses must be rate-limited identically to real accounts, and deleted accounts must not invalidate security history.

Do not store submitted passwords, password hashes, session tokens, or request bodies in this table.

- [ ] Apply the migration locally:

```bash
npm run db:migrate
```

## 1.3 Implement the repository

- [ ] Create `src/server/repositories/staff-login-throttle.repository.ts`.

Define explicit policy constants in one place:

```ts
export const STAFF_LOGIN_WINDOW_SECONDS = 15 * 60;
export const STAFF_LOGIN_EMAIL_FAILURE_LIMIT = 5;
export const STAFF_LOGIN_IP_FAILURE_LIMIT = 25;
export const STAFF_LOGIN_RETENTION_HOURS = 24;
```

Add:

```ts
export function normalizeStaffLoginEmail(value: string) {
  return value.trim().toLowerCase();
}
```

Add a deterministic lock helper. Build the two logical lock names, sort them, and acquire them in sorted order:

```ts
export async function lockStaffLoginBuckets(
  client: PoolClient,
  normalizedEmail: string,
  ipAddress: string,
) {
  const lockNames = [
    `medclinic:staff-login:email:v1:${normalizedEmail}`,
    `medclinic:staff-login:ip:v1:${ipAddress}`,
  ].sort();

  for (const lockName of lockNames) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [lockName],
    );
  }
}
```

These locks are transaction-scoped; do not manually unlock them.

Add a throttle reader that counts failures in the last 15 minutes for both scopes and returns:

```ts
type StaffLoginThrottle = {
  throttled: boolean;
  emailFailureCount: number;
  ipFailureCount: number;
  retryAfterSeconds: number;
};
```

The SQL must use PostgreSQL `clock_timestamp()` for the window. Avoid mixing the database clock with application `Date.now()` for the authoritative throttle decision.

`retryAfterSeconds` must be the number of seconds until **all currently exceeded buckets** fall below their threshold, clamped to at least `1` and at most `900` while throttled. Because no new failures are recorded once a request is pre-throttled, each bucket cannot continue growing after it reaches its limit under the serialized flow.

Add:

```ts
export async function recordStaffLoginFailure(
  client: PoolClient,
  normalizedEmail: string,
  ipAddress: string,
)
```

It must insert exactly two rows in one statement/transaction:

- `EMAIL + normalizedEmail`
- `IP + ipAddress`

Add:

```ts
export async function clearStaffEmailFailures(
  client: PoolClient,
  normalizedEmail: string,
)
```

Delete only `scope='EMAIL' AND bucket_key=$1`.

Add:

```ts
export async function pruneExpiredStaffLoginFailures(client: PoolClient)
```

Delete rows older than 24 hours. This cleanup is storage hygiene only; never use 24 hours as the throttle window.

Do not expose a function that globally clears IP failures during successful authentication.

## 1.4 Verify Task 1

- [ ] Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/repositories/staff-login-throttle.repository.integration.test.ts
```

Expected result: all repository tests pass, including the real PostgreSQL concurrency test.

- [ ] Commit Task 1 implementation if working in incremental commits:

```bash
git add \
  database/migrations/027_staff_login_brute_force_protection.sql \
  src/server/repositories/staff-login-throttle.repository.ts \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts

git commit -m "feat: add staff login throttle persistence"
```

---

# Task 2: Make staff authentication enforce the throttle atomically

## 2.1 Extend user lookup to support the authentication transaction

- [ ] Modify `src/server/repositories/users.repository.ts` so `findUserByEmail` mirrors `findUserById` and accepts an optional client:

```ts
export async function findUserByEmail(
  email: string,
  client?: PoolClient,
): Promise<UserRecord | null> {
  const sql = `SELECT ...`;
  const result = client
    ? await client.query<UserRow>(sql, [email])
    : await query<UserRow>(sql, [email]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}
```

Keep the existing SQL predicate that ignores soft-deleted users.

Do not change public behavior for callers that omit `client`.

## 2.2 Add failing service-level security tests

- [ ] Extend `src/server/services/auth.service.integration.test.ts`.

Update calls from:

```ts
authenticate(email, password)
```

to the new contract:

```ts
authenticate(email, password, ipAddress)
```

Use stable documentation/test IPs. Ensure each test cleans its own throttle rows so test ordering does not affect authentication.

Add these regression cases:

### Email threshold

For one existing staff account and one IP:

- failures 1-4 reject with `{ code: "INVALID_CREDENTIALS", status: 401 }`;
- failure 5 rejects with `{ code: "STAFF_LOGIN_THROTTLED", status: 429 }`;
- the error details contain `retryAfterSeconds` between 1 and 900;
- an immediate correct-password attempt also rejects with `STAFF_LOGIN_THROTTLED`.

### Unknown email parity

Repeat the five-failure behavior with an email that is not present in `users`. The externally observable codes/statuses must be the same as for a real email under equivalent failure state.

### Normalization

Use casing variants of the same email across failures and verify they share the same five-attempt bucket.

### Global IP threshold

Use 25 different nonexistent emails from one IP so no email bucket reaches 5. Verify:

- attempts 1-24 return `INVALID_CREDENTIALS`;
- attempt 25 returns `STAFF_LOGIN_THROTTLED`;
- a 26th attempt with a brand-new email is pre-throttled by the IP bucket.

### Success clears email only

Create fewer than five failures for a valid account, then authenticate successfully. Verify the email-scope failures are cleared while the IP-scope failures remain.

### Window expiry

Create five failures, move their `occurred_at` values to more than 15 minutes ago with test SQL, then verify correct credentials can authenticate again.

### Concurrent burst

Launch ten wrong-password attempts concurrently for the same normalized email and IP:

```ts
const outcomes = await Promise.allSettled(
  Array.from({ length: 10 }, () => authenticate(email, "wrong-password", ipAddress)),
);
```

With transaction-scoped bucket locking, the expected aggregate outcome is:

- exactly 4 `INVALID_CREDENTIALS` failures;
- exactly 6 `STAFF_LOGIN_THROTTLED` failures;
- exactly 5 email failure events stored;
- exactly 5 IP failure events stored for that test attempt stream.

This regression is critical. Without serialization, a burst can exceed the intended threshold before requests observe each other's writes.

- [ ] Run the service test now and confirm it fails against the old `authenticate(email, password)` implementation:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/services/auth.service.integration.test.ts
```

## 2.3 Implement transactionally throttled authentication

- [ ] Modify `src/server/services/auth.service.ts`.

Change the login contract to:

```ts
export async function authenticate(
  email: string,
  password: string,
  ipAddress: string,
): Promise<AuthenticatedStaff>
```

Validate/cap the IP at the route boundary, but defensively reject an empty value in the service rather than silently creating an empty bucket key.

The authoritative flow must be:

```text
normalize email
  -> begin transaction
  -> acquire EMAIL and IP advisory locks in sorted order
  -> optionally prune rows older than 24h
  -> read current 15-minute throttle state
  -> if throttled: return throttle outcome without bcrypt
  -> find user with the same PoolClient
  -> compare submitted password
  -> if invalid/nonexistent:
       record EMAIL + IP failure events
       re-read throttle state
       return INVALID or THROTTLED
  -> if valid:
       clear EMAIL failures only
       return authenticated user
  -> commit
```

Do not throw the `AppError` from inside the transaction for expected invalid/throttled outcomes if doing so would roll back the newly inserted failure event. Return an internal discriminated outcome from the transaction and throw **after** the transaction commits.

For example:

```ts
type AuthenticationOutcome =
  | { type: "success"; user: UserRecord }
  | { type: "invalid" }
  | { type: "throttled"; retryAfterSeconds: number };
```

Then outside `transaction(...)`:

```ts
if (outcome.type === "throttled") {
  throw new AppError(
    "STAFF_LOGIN_THROTTLED",
    "Too many sign-in attempts. Try again later.",
    429,
    undefined,
    { retryAfterSeconds: outcome.retryAfterSeconds },
  );
}
if (outcome.type === "invalid") {
  throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
}
return sessionUser(outcome.user);
```

### Enumeration-resistant password work

Do not skip password hashing work merely because the email does not exist.

Use one pre-generated, valid bcrypt hash constant with a production-equivalent cost and run:

```ts
const valid = await bcrypt.compare(
  password,
  user?.passwordHash ?? DUMMY_PASSWORD_HASH,
);
```

Generate the dummy hash once during implementation and commit only the hash string. **Do not call `bcrypt.hash(...)` per login request.** The dummy hash must not correspond to a real account.

The result for a missing account is still invalid even if the submitted password happens to match the dummy hash:

```ts
if (!user || !valid) {
  // record failure
}
```

This keeps the normal error response generic and reduces the email-existence timing signal.

### Successful login semantics

Successful authentication below an active threshold must preserve the existing returned staff shape:

- `userId`
- `fullName`
- `email`
- `role`
- clinic fields
- `credentialVersion`
- `emailVerifiedAt`
- `mustChangePassword`
- `status`
- `onboardingRequired`

Do not alter `authorizeAuthenticatedStaff(...)` or `authorizeSession(...)` beyond any type fallout caused by the changed `authenticate(...)` signature.

## 2.4 Verify Task 2

- [ ] Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts \
  src/server/services/auth.service.integration.test.ts
```

Expected result: all rate-limit, concurrency, existing login, onboarding, stale-session, and deleted-account tests pass.

- [ ] Commit Task 2 implementation if using incremental commits:

```bash
git add \
  src/server/repositories/users.repository.ts \
  src/server/services/auth.service.ts \
  src/server/services/auth.service.integration.test.ts

git commit -m "fix: throttle staff authentication attempts"
```

---

# Task 3: Pass a trustworthy request IP and expose Retry-After

## 3.1 Add a focused request-IP helper

- [ ] Create `src/server/security/request-ip.ts`:

```ts
export function requestIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown"
  ).slice(0, 64);
}
```

This deliberately matches the current student-login extraction convention.

Security deployment requirement: Nginx/Caddy must overwrite `X-Forwarded-For` / `X-Real-IP` and the Node port must not be directly reachable by untrusted clients. Do not attempt to solve proxy trust with a new application-level environment-variable framework in this task.

- [ ] Create `src/server/security/request-ip.test.ts` covering:

1. first address from a comma-separated `x-forwarded-for` value;
2. fallback to `x-real-ip`;
3. fallback to `unknown`;
4. trimming;
5. maximum length 64.

Run and make it green:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/server/security/request-ip.test.ts
```

Do not modify the student route in this task. The helper can be adopted there separately after this security blocker is complete.

## 3.2 Add route-level regression tests

- [ ] Modify `src/app/api/staff-security-routes.test.ts` rather than creating another broad route-test harness.

Add the login service mock to the existing hoisted mocks and import:

```ts
import { POST as staffLogin } from "./auth/login/route";
```

Add a success contract test that verifies:

- the route passes normalized input plus the resolved client IP to `authenticate` according to its signature;
- successful login still returns the existing data shape/`nextPath`;
- the existing `medclinic_session` cookie is still issued with the same security options.

Add a throttle contract test where `authenticate` rejects with:

```ts
new AppError(
  "STAFF_LOGIN_THROTTLED",
  "Too many sign-in attempts. Try again later.",
  429,
  undefined,
  { retryAfterSeconds: 417 },
)
```

The route response must have:

```text
status: 429
Retry-After: 417
body.error.code: STAFF_LOGIN_THROTTLED
body.error.details.retryAfterSeconds: 417
```

Also verify that the route does **not** set a session cookie when login is throttled.

- [ ] Run the route tests before changing the route and confirm the new expectations fail:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run src/app/api/staff-security-routes.test.ts
```

## 3.3 Modify the staff login route

- [ ] Modify `src/app/api/auth/login/route.ts`.

Import `requestIp` and pass it into the service:

```ts
const user = await authenticate(
  input.email,
  input.password,
  requestIp(request),
);
```

Preserve the current token creation, cookie options, and `nextPath` behavior exactly.

On errors, continue using the shared `errorResponse(error)` body contract. For a staff throttle only, add `Retry-After` to the resulting response:

```ts
const response = errorResponse(error);
if (
  error instanceof AppError
  && error.code === "STAFF_LOGIN_THROTTLED"
  && typeof error.details === "object"
  && error.details !== null
  && "retryAfterSeconds" in error.details
  && typeof error.details.retryAfterSeconds === "number"
) {
  response.headers.set("Retry-After", String(error.details.retryAfterSeconds));
}
return response;
```

Do not globally modify `errorResponse(...)` merely to support this one endpoint unless implementation proves a reusable response-header contract is necessary. Keeping this local minimizes unrelated API behavior changes.

## 3.4 Verify Task 3

- [ ] Run:

```bash
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run \
  src/server/security/request-ip.test.ts \
  src/app/api/staff-security-routes.test.ts \
  src/server/services/auth.service.integration.test.ts \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts
```

- [ ] Commit Task 3 if using incremental commits:

```bash
git add \
  src/server/security/request-ip.ts \
  src/server/security/request-ip.test.ts \
  src/app/api/auth/login/route.ts \
  src/app/api/staff-security-routes.test.ts

git commit -m "fix: enforce staff login rate limits at api boundary"
```

---

# Task 4: Final security and regression verification

## 4.1 Search for bypass paths

- [ ] Find all production callers of `authenticate(` and update only the staff email/password login callers that now need an IP argument.

Suggested searches:

```bash
rg 'authenticate\(' src scripts
rg '/api/auth/login|auth/login' src scripts
```

Any alternate route that authenticates a staff email/password without passing through the throttle is a blocker.

Do not confuse these with:

- `authorizeAuthenticatedStaff(...)`;
- `authorizeSession(...)`;
- password-reset token verification;
- student authentication.

## 4.2 Database assertions

- [ ] Inspect the applied migration:

```bash
npm run db:migrate
```

Confirm migration `027_staff_login_brute_force_protection.sql` is recorded by the migration runner.

- [ ] Verify no plaintext passwords or request bodies are persisted in `staff_login_failures`.

- [ ] Verify no foreign key from failure bucket keys to `users.email` was introduced.

## 4.3 Full automated verification

- [ ] Run the complete suite:

```bash
npm test
```

- [ ] Run lint:

```bash
npm run lint
```

- [ ] Run the production build:

```bash
npm run build
```

Do not declare the task complete unless all three commands exit successfully.

## 4.4 Review the final diff

- [ ] Review only the intended scope:

```bash
git diff HEAD^ -- \
  database/migrations/027_staff_login_brute_force_protection.sql \
  src/server/repositories/staff-login-throttle.repository.ts \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts \
  src/server/repositories/users.repository.ts \
  src/server/services/auth.service.ts \
  src/server/services/auth.service.integration.test.ts \
  src/server/security/request-ip.ts \
  src/server/security/request-ip.test.ts \
  src/app/api/auth/login/route.ts \
  src/app/api/staff-security-routes.test.ts
```

If implementation used multiple incremental commits, use the appropriate base commit instead of `HEAD^` so the complete feature diff is reviewed.

---

# Acceptance Criteria

1. Staff login is protected by a 15-minute normalized-email failure bucket with a limit of 5.
2. Staff login is independently protected by a 15-minute client-IP failure bucket with a limit of 25.
3. The fifth email failure is recorded and returns `429`.
4. The twenty-fifth IP failure is recorded and returns `429`.
5. Once throttled, correct credentials do not bypass the active throttle.
6. Email case/outer whitespace variations cannot obtain separate buckets.
7. Unknown emails consume the same failure budgets and receive the same ordinary invalid/throttled response classes as real emails.
8. Concurrent failed requests sharing the same bucket cannot burst past the intended threshold before throttling takes effect.
9. Authentication failure events persist in PostgreSQL and survive application restarts.
10. A successful login below threshold clears only that account's email failures, not aggregate IP failures.
11. Failures older than 15 minutes do not affect the throttle decision.
12. Rows older than 24 hours can be pruned without changing the 15-minute policy.
13. Throttle responses use `STAFF_LOGIN_THROTTLED`, HTTP `429`, `details.retryAfterSeconds`, and an HTTP `Retry-After` header with the same value.
14. Ordinary wrong credentials continue to use `INVALID_CREDENTIALS`, HTTP `401`, and the generic `Invalid email or password.` message.
15. Existing session creation, cookie settings, staff onboarding redirect, role data, and credential-version behavior remain unchanged after successful authentication.
16. No alternate staff email/password login path bypasses the throttle.
17. Student authentication behavior is unchanged.
18. Password reset/recovery behavior is unchanged.
19. No permanent account lock, CAPTCHA, MFA, or external rate-limit dependency is introduced.
20. Focused repository/service/route tests pass.
21. `npm test`, `npm run lint`, and `npm run build` pass before any production-readiness claim.

# Codex Scope Guard

Do **not** opportunistically fix other production-readiness findings while implementing this plan. In particular, do not combine this task with:

- academic-year closing-date retroactive validation;
- First-Year Laboratory → Physical Examination timing changes;
- migration-runner transaction ownership cleanup;
- student-login throttle redesign;
- result-upload streaming/transaction-lock changes;
- HTTPS/secure-cookie startup validation;
- database pool tuning;
- background-worker topology changes;
- CI/CD setup;
- large architecture refactors.

The First-Year `Laboratory + 7 calendar days` policy is intentional and must remain unchanged.

# Recommended Final Implementation Commit

After all verification succeeds, if the work has not already been committed incrementally:

```bash
git add \
  database/migrations/027_staff_login_brute_force_protection.sql \
  src/server/repositories/staff-login-throttle.repository.ts \
  src/server/repositories/staff-login-throttle.repository.integration.test.ts \
  src/server/repositories/users.repository.ts \
  src/server/services/auth.service.ts \
  src/server/services/auth.service.integration.test.ts \
  src/server/security/request-ip.ts \
  src/server/security/request-ip.test.ts \
  src/app/api/auth/login/route.ts \
  src/app/api/staff-security-routes.test.ts

git commit -m "fix: protect staff login from brute force"
```
