// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { serverEnv } from "@/lib/env";
import { decryptEmailOutboxSensitiveBody } from "@/server/email/verification-body-encryption";
import { authenticate, authorizeAuthenticatedStaff } from "./auth.service";
import {
  changeStaffEmail,
  createStaffUser,
  deleteStaffUser,
  listStaffUsers,
  resetStaffTemporaryPassword,
  resendStaffVerification,
} from "./staff-administration.service";
import {
  changeStaffPassword,
  getStaffAccountSummary,
  getStaffOnboardingState,
  replaceStaffTemporaryPassword,
} from "./staff-account-security.service";
import {
  requestStaffPasswordReset,
  resetStaffPassword,
} from "./staff-password-recovery.service";
import { confirmStaffEmail } from "./staff-email-verification.service";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

const fixtureDomain = "@staff-lifecycle.test";
const adminId = TEST_REFERENCE_IDS.adminUser;
const authenticationIpAddresses = {
  temporaryPassword: "198.51.100.201",
  changedPassword: "198.51.100.202",
  recoveredPassword: "198.51.100.203",
  administratorActions: "198.51.100.204",
  deletedAccount: "198.51.100.205",
} as const;

async function fixtureUserIds() {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE full_name LIKE 'TEST Staff Lifecycle%' OR email LIKE $1",
    [`%${fixtureDomain}`],
  );
  return result.rows.map((row) => row.id);
}

async function cleanup() {
  await pool.query(
    `DELETE FROM staff_login_failures
      WHERE (scope='EMAIL' AND bucket_key LIKE $1)
         OR (scope='IP' AND bucket_key=ANY($2::varchar[]))`,
    [`%${fixtureDomain}`, Object.values(authenticationIpAddresses)],
  );
  const ids = await fixtureUserIds();
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])
       OR (entity_type='user' AND entity_id=ANY($1::text[]))
       OR (entity_type IN ('staff_email_verification','staff_password_reset') AND entity_id IN (
         SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
         UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[])
       ))
       OR (entity_type='email_outbox' AND entity_id IN (
         SELECT id::text FROM email_outbox WHERE source_id IN (
           SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
           UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[])
         )
       ))`,
    [ids],
  );
  await pool.query(
    `DELETE FROM email_outbox WHERE source_id IN (
       SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[])
     )`,
    [ids],
  );
  await pool.query("DELETE FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM staff_password_resets WHERE user_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
}

async function securityToken(userId: string, sourceType: "STAFF_EMAIL_VERIFICATION" | "STAFF_PASSWORD_RESET") {
  const result = await pool.query<{ encrypted: string }>(
    `SELECT verification_body_encrypted AS encrypted FROM email_outbox
      WHERE source_type=$2 AND source_id IN (
        SELECT id::text FROM staff_email_verifications WHERE user_id=$1
        UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=$1
      ) AND verification_body_encrypted IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId, sourceType],
  );
  const body = decryptEmailOutboxSensitiveBody(
    result.rows[0].encrypted,
    serverEnv().EMAIL_OUTBOX_ENCRYPTION_KEY,
  );
  const token = new URL(body.match(/https?:\/\/\S+/)![0]).searchParams.get("token");
  if (!token) throw new Error("Fixture security token missing");
  return token;
}

async function newCoordinator(suffix: string, password = "Temporary123!") {
  return createStaffUser({
    fullName: `TEST Staff Lifecycle ${suffix}`,
    email: `${suffix.toLowerCase()}${fixtureDomain}`,
    temporaryPassword: password,
    confirmTemporaryPassword: password,
    role: "COORDINATOR",
    clinicCode: null,
  }, adminId);
}

async function onboard(suffix: string) {
  const user = await newCoordinator(suffix);
  await confirmStaffEmail(await securityToken(user.id, "STAFF_EMAIL_VERIFICATION"));
  const replaced = await replaceStaffTemporaryPassword(user.id, {
    currentPassword: "Temporary123!",
    newPassword: "Operational123!",
    confirmPassword: "Operational123!",
  });
  return { user, replaced };
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("staff account security lifecycle", () => {
  it("creates an unverified user, queues verification, and confirms the token exactly once", async () => {
    const created = await newCoordinator("Create");
    expect(created).toMatchObject({ status: "PENDING_VERIFICATION", credentialVersion: 1 });
    expect(await getStaffOnboardingState(created.id)).toMatchObject({
      status: "PENDING_VERIFICATION",
      emailVerified: false,
      mustChangePassword: true,
      emailMasked: expect.stringContaining(fixtureDomain),
    });
    const token = await securityToken(created.id, "STAFF_EMAIL_VERIFICATION");
    await expect(confirmStaffEmail(token)).resolves.toMatchObject({
      status: "PASSWORD_CHANGE_REQUIRED",
      emailVerified: true,
      mustChangePassword: true,
    });
    await expect(confirmStaffEmail(token)).rejects.toMatchObject({
      code: "STAFF_EMAIL_VERIFICATION_INVALID",
      status: 422,
    });
  });

  it("enforces verification resend cooldown and five-per-fifteen-minute throttle", async () => {
    const created = await newCoordinator("Throttle");
    await expect(resendStaffVerification(created.id, adminId)).rejects.toMatchObject({
      code: "STAFF_EMAIL_VERIFICATION_COOLDOWN",
      status: 429,
    });
    for (let request = 1; request < 5; request += 1) {
      await pool.query(
        "UPDATE staff_email_verifications SET created_at=created_at-INTERVAL '61 seconds' WHERE user_id=$1",
        [created.id],
      );
      await resendStaffVerification(created.id, adminId);
    }
    await pool.query(
      "UPDATE staff_email_verifications SET created_at=created_at-INTERVAL '61 seconds' WHERE user_id=$1",
      [created.id],
    );
    await expect(resendStaffVerification(created.id, adminId)).rejects.toMatchObject({
      code: "STAFF_EMAIL_VERIFICATION_THROTTLED",
      status: 429,
    });
  });

  it("requires verified email and current temporary password, then revokes the old session", async () => {
    const created = await newCoordinator("Replace");
    const restrictedSession = await authenticate(
      created.email,
      "Temporary123!",
      authenticationIpAddresses.temporaryPassword,
    );
    await expect(replaceStaffTemporaryPassword(created.id, {
      currentPassword: "Temporary123!",
      newPassword: "Operational123!",
      confirmPassword: "Operational123!",
    })).rejects.toMatchObject({ code: "STAFF_EMAIL_NOT_VERIFIED", status: 409 });
    await confirmStaffEmail(await securityToken(created.id, "STAFF_EMAIL_VERIFICATION"));
    const replaced = await replaceStaffTemporaryPassword(created.id, {
      currentPassword: "Temporary123!",
      newPassword: "Operational123!",
      confirmPassword: "Operational123!",
    });
    expect(replaced).toMatchObject({ status: "ACTIVE", credentialVersion: 2 });
    await expect(authorizeAuthenticatedStaff(restrictedSession)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(
      authenticate(
        created.email,
        "Operational123!",
        authenticationIpAddresses.temporaryPassword,
      ),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("changes an operational password while returning a fresh credential version", async () => {
    const { user, replaced } = await onboard("Change");
    const changed = await changeStaffPassword(user.id, {
      currentPassword: "Operational123!",
      newPassword: "ChangedPassword123!",
      confirmPassword: "ChangedPassword123!",
    });
    expect(changed.credentialVersion).toBe(replaced.credentialVersion + 1);
    await expect(
      authenticate(
        user.email,
        "ChangedPassword123!",
        authenticationIpAddresses.changedPassword,
      ),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(getStaffAccountSummary(user.id)).resolves.toMatchObject({
      email: user.email,
      role: "COORDINATOR",
      emailVerified: true,
      status: "ACTIVE",
    });
  });

  it("keeps Forgot Password generic and completes a single-use reset only for eligible staff", async () => {
    const { user, replaced } = await onboard("Recovery");
    await expect(requestStaffPasswordReset("unknown@staff-lifecycle.test")).resolves.toEqual({ accepted: true });
    await expect(requestStaffPasswordReset(user.email)).resolves.toEqual({ accepted: true });
    const token = await securityToken(user.id, "STAFF_PASSWORD_RESET");
    const reset = await resetStaffPassword({
      token,
      newPassword: "RecoveredPassword123!",
      confirmPassword: "RecoveredPassword123!",
    });
    expect(reset.credentialVersion).toBe(replaced.credentialVersion + 1);
    await expect(resetStaffPassword({
      token,
      newPassword: "AnotherPassword123!",
      confirmPassword: "AnotherPassword123!",
    })).rejects.toMatchObject({ code: "STAFF_PASSWORD_RESET_INVALID", status: 422 });
    await expect(
      authenticate(
        user.email,
        "RecoveredPassword123!",
        authenticationIpAddresses.recoveredPassword,
      ),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("corrects email with re-verification and Admin-resets a temporary password while revoking sessions", async () => {
    const { user } = await onboard("AdminActions");
    const oldSession = await authenticate(
      user.email,
      "Operational123!",
      authenticationIpAddresses.administratorActions,
    );
    const changed = await changeStaffEmail(adminId, user.id, `${"corrected"}${fixtureDomain}`);
    expect(changed).toMatchObject({ status: "PENDING_VERIFICATION", credentialVersion: 3 });
    await expect(authorizeAuthenticatedStaff(oldSession)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await confirmStaffEmail(await securityToken(user.id, "STAFF_EMAIL_VERIFICATION"));
    const verifiedSession = await authenticate(
      `corrected${fixtureDomain}`,
      "Operational123!",
      authenticationIpAddresses.administratorActions,
    );
    const reset = await resetStaffTemporaryPassword(adminId, user.id, {
      temporaryPassword: "FallbackPassword123!",
      confirmTemporaryPassword: "FallbackPassword123!",
    });
    expect(reset).toMatchObject({ status: "PASSWORD_CHANGE_REQUIRED", credentialVersion: 4 });
    await expect(authorizeAuthenticatedStaff(verifiedSession)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("preserves pending email verification when an Administrator replaces a temporary password", async () => {
    const user = await newCoordinator("PendingAdminReset");
    const verificationToken = await securityToken(user.id, "STAFF_EMAIL_VERIFICATION");

    await resetStaffTemporaryPassword(adminId, user.id, {
      temporaryPassword: "FallbackPassword123!",
      confirmTemporaryPassword: "FallbackPassword123!",
    });

    const verificationMail = await pool.query<{
      status: string;
      encrypted: boolean;
    }>(
      `SELECT status,verification_body_encrypted IS NOT NULL AS encrypted
         FROM email_outbox
        WHERE source_type='STAFF_EMAIL_VERIFICATION'
          AND source_id IN (SELECT id::text FROM staff_email_verifications WHERE user_id=$1)`,
      [user.id],
    );
    expect(verificationMail.rows).toEqual([{ status: "PENDING", encrypted: true }]);
    await expect(confirmStaffEmail(verificationToken)).resolves.toMatchObject({
      status: "PASSWORD_CHANGE_REQUIRED",
      emailVerified: true,
      mustChangePassword: true,
    });
  });

  it("permanently tombstones a user, releases email, and preserves historical identity", async () => {
    const { user } = await onboard("Delete");
    const oldSession = await authenticate(
      user.email,
      "Operational123!",
      authenticationIpAddresses.deletedAccount,
    );
    await requestStaffPasswordReset(user.email);
    await pool.query(
      "INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id) VALUES ($1,'TEST_HISTORICAL_ACTOR','test_history','fixture')",
      [user.id],
    );
    await deleteStaffUser(adminId, user.id);
    await expect(
      authenticate(
        user.email,
        "Operational123!",
        authenticationIpAddresses.deletedAccount,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(authorizeAuthenticatedStaff(oldSession)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await listStaffUsers()).some((item) => item.id === user.id)).toBe(false);
    const tombstone = await pool.query(
      "SELECT full_name,role,email,password_hash,email_verified_at,deleted_at IS NOT NULL AS deleted FROM users WHERE id=$1",
      [user.id],
    );
    expect(tombstone.rows[0]).toMatchObject({
      full_name: "TEST Staff Lifecycle Delete",
      role: "COORDINATOR",
      email: null,
      password_hash: null,
      email_verified_at: null,
      deleted: true,
    });
    await expect(pool.query(
      `SELECT COUNT(*)::int AS active_tokens FROM (
         SELECT id FROM staff_email_verifications
          WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL
         UNION ALL
         SELECT id FROM staff_password_resets
          WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL
       ) active`,
      [user.id],
    )).resolves.toMatchObject({ rows: [{ active_tokens: 0 }] });
    await expect(pool.query(
      `SELECT COUNT(*)::int AS pending_mail FROM email_outbox
        WHERE status NOT IN ('SENT','OBSOLETE') AND source_id IN (
          SELECT id::text FROM staff_email_verifications WHERE user_id=$1
          UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=$1
        )`,
      [user.id],
    )).resolves.toMatchObject({ rows: [{ pending_mail: 0 }] });
    await expect(newCoordinator("Delete")).resolves.toMatchObject({ email: user.email });
  });

  it("rejects self-deletion and serializes concurrent cross-deletion of Administrators", async () => {
    await expect(deleteStaffUser(adminId, adminId)).rejects.toMatchObject({
      code: "STAFF_SELF_DELETE_FORBIDDEN",
      status: 422,
    });
    const first = await createStaffUser({
      fullName: "TEST Staff Lifecycle Admin A",
      email: `admin-a${fixtureDomain}`,
      temporaryPassword: "Temporary123!",
      confirmTemporaryPassword: "Temporary123!",
      role: "ADMIN",
      clinicCode: null,
    }, adminId);
    const second = await createStaffUser({
      fullName: "TEST Staff Lifecycle Admin B",
      email: `admin-b${fixtureDomain}`,
      temporaryPassword: "Temporary123!",
      confirmTemporaryPassword: "Temporary123!",
      role: "ADMIN",
      clinicCode: null,
    }, adminId);
    await pool.query(
      "UPDATE users SET email_verified_at=clock_timestamp(),must_change_password=FALSE WHERE id=ANY($1::uuid[])",
      [[first.id, second.id]],
    );
    await pool.query("UPDATE users SET role='COORDINATOR' WHERE id=$1", [adminId]);
    try {
      const outcomes = await Promise.allSettled([
        deleteStaffUser(first.id, second.id),
        deleteStaffUser(second.id, first.id),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const surviving = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND deleted_at IS NULL",
      );
      expect(surviving.rows[0].count).toBe(1);
    } finally {
      await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [adminId]);
    }
  });
});
