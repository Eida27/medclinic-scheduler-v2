import bcrypt from "bcryptjs";
import { AppError } from "@/lib/errors";
import { transaction, query } from "@/server/db/pool";
import { addressMetadata, staffAccountStatus } from "@/server/security/staff-security";
import {
  mapStaffAccount,
  requireDifferentPassword,
  staffAccountColumns,
  type StaffAccountRow,
  validatedPasswordPair,
} from "./staff-service-helpers";

type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

function maskEmail(email: string) {
  return addressMetadata(email).addressMasked;
}

export async function getStaffOnboardingState(userId: string) {
  const result = await query<{
    email: string;
    emailVerifiedAt: Date | null;
    mustChangePassword: boolean;
    latestRequestAt: Date | null;
    databaseNow: Date;
  }>(
    `SELECT account.email,account.email_verified_at AS "emailVerifiedAt",
            account.must_change_password AS "mustChangePassword",
            latest.created_at AS "latestRequestAt",clock_timestamp() AS "databaseNow"
       FROM users account
       LEFT JOIN LATERAL (
         SELECT created_at FROM staff_email_verifications
          WHERE user_id=account.id ORDER BY created_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE account.id=$1 AND account.deleted_at IS NULL`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
  const resendAvailableAt = row.latestRequestAt
    ? new Date(row.latestRequestAt.getTime() + 60_000)
    : row.databaseNow;
  return {
    emailMasked: maskEmail(row.email),
    emailVerified: Boolean(row.emailVerifiedAt),
    mustChangePassword: row.mustChangePassword,
    status: staffAccountStatus(row),
    resendAvailableAt: resendAvailableAt.toISOString(),
    retryAfterSeconds: Math.max(0, Math.ceil((resendAvailableAt.getTime() - row.databaseNow.getTime()) / 1000)),
  };
}

export async function getStaffAccountSummary(userId: string) {
  const result = await query<StaffAccountRow>(
    `SELECT ${staffAccountColumns}
       FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
      WHERE account.id=$1 AND account.deleted_at IS NULL
        AND account.email_verified_at IS NOT NULL AND account.must_change_password=FALSE`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("ONBOARDING_REQUIRED", "Complete account security onboarding before using MedClinic.", 403);
  return mapStaffAccount(row);
}

async function invalidatePasswordResets(client: import("pg").PoolClient, userId: string) {
  const resetIds = await client.query<{ id: string }>(
    `UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
      WHERE user_id=$1 AND consumed_at IS NULL RETURNING id::text`,
    [userId],
  );
  if (resetIds.rowCount) {
    await client.query(
      `UPDATE email_outbox SET status='OBSOLETE',verification_body_encrypted=NULL,
              locked_at=NULL,last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
        WHERE message_kind='STAFF_SECURITY' AND source_type='STAFF_PASSWORD_RESET'
          AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
      [resetIds.rows.map((row) => row.id)],
    );
  }
}

async function changePassword(
  userId: string,
  input: PasswordChangeInput,
  mode: "temporary" | "ordinary",
) {
  const newPassword = validatedPasswordPair(input.newPassword, input.confirmPassword);
  return transaction(async (client) => {
    const target = await client.query<StaffAccountRow & { passwordHash: string }>(
      `SELECT ${staffAccountColumns},account.password_hash AS "passwordHash"
         FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
        WHERE account.id=$1 AND account.deleted_at IS NULL FOR UPDATE OF account`,
      [userId],
    );
    const row = target.rows[0];
    if (!row) throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
    if (mode === "temporary") {
      if (!row.emailVerifiedAt) throw new AppError("STAFF_EMAIL_NOT_VERIFIED", "Verify your email before replacing the temporary password.", 409);
      if (!row.mustChangePassword) throw new AppError("TEMPORARY_PASSWORD_NOT_REQUIRED", "Temporary password replacement is not required.", 409);
    } else if (!row.emailVerifiedAt || row.mustChangePassword) {
      throw new AppError("ONBOARDING_REQUIRED", "Complete account security onboarding before changing your password.", 403);
    }
    if (!await bcrypt.compare(input.currentPassword, row.passwordHash)) {
      throw new AppError("CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.", 422);
    }
    await requireDifferentPassword(newPassword, row.passwordHash);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await client.query<StaffAccountRow>(
      `UPDATE users SET password_hash=$2,must_change_password=FALSE,
                        credential_version=credential_version+1 WHERE id=$1
       RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
                 NULL::text AS "clinicCode",NULL::text AS "clinicName",
                 email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
                 credential_version AS "credentialVersion"`,
      [userId, passwordHash],
    );
    await invalidatePasswordResets(client, userId);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1::uuid,$2,'user',$1::uuid::text,$3::jsonb)`,
      [
        userId,
        mode === "temporary" ? "STAFF_TEMP_PASSWORD_REPLACED" : "STAFF_PASSWORD_CHANGED",
        JSON.stringify({ role: row.role, ...addressMetadata(row.email) }),
      ],
    );
    const current = updated.rows[0];
    current.clinicCode = row.clinicCode;
    current.clinicName = row.clinicName;
    return mapStaffAccount(current);
  });
}

export function replaceStaffTemporaryPassword(userId: string, input: PasswordChangeInput) {
  return changePassword(userId, input, "temporary");
}

export function changeStaffPassword(userId: string, input: PasswordChangeInput) {
  return changePassword(userId, input, "ordinary");
}
