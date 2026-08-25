import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { encryptVerificationEmailBody } from "@/server/email/verification-body-encryption";
import {
  addressMetadata,
  createSecurityToken,
  securityTokenHash,
  staffEmailSchema,
} from "@/server/security/staff-security";
import { transaction } from "@/server/db/pool";
import { mapStaffAccount, staffAccountColumns, type StaffAccountRow } from "./staff-service-helpers";

const VERIFICATION_LIFETIME_MINUTES = 30;
const RESEND_COOLDOWN_SECONDS = 60;
const THROTTLE_LIMIT = 5;

type QueueVerificationOptions = {
  auditAction?: "STAFF_EMAIL_VERIFICATION_REQUESTED" | "STAFF_EMAIL_VERIFICATION_RESENT";
  enforceRateLimit?: boolean;
  actorUserId?: string | null;
};

export async function queueStaffEmailVerification(
  client: PoolClient,
  userId: string,
  destination: string,
  options: QueueVerificationOptions = {},
) {
  const email = staffEmailSchema.parse(destination);
  const enforceRateLimit = options.enforceRateLimit ?? true;
  const recent = await client.query<{ createdAt: Date; databaseNow: Date }>(
    `SELECT created_at AS "createdAt",clock_timestamp() AS "databaseNow"
       FROM staff_email_verifications
      WHERE user_id=$1 AND created_at>clock_timestamp()-INTERVAL '15 minutes'
      ORDER BY created_at`,
    [userId],
  );
  const databaseNow = recent.rows.at(-1)?.databaseNow ?? new Date();
  if (enforceRateLimit && recent.rows.length >= THROTTLE_LIMIT) {
    const retryAt = new Date(recent.rows[0].createdAt.getTime() + 15 * 60_000);
    throw new AppError(
      "STAFF_EMAIL_VERIFICATION_THROTTLED",
      "Too many verification emails were requested. Try again shortly.",
      429,
      undefined,
      { retryAt: retryAt.toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - databaseNow.getTime()) / 1000)) },
    );
  }
  const latest = recent.rows.at(-1);
  if (enforceRateLimit && latest) {
    const resendAvailableAt = new Date(latest.createdAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000);
    if (resendAvailableAt.getTime() > databaseNow.getTime()) {
      throw new AppError(
        "STAFF_EMAIL_VERIFICATION_COOLDOWN",
        "Please wait before requesting another verification email.",
        429,
        undefined,
        {
          retryAt: resendAvailableAt.toISOString(),
          retryAfterSeconds: Math.max(1, Math.ceil((resendAvailableAt.getTime() - databaseNow.getTime()) / 1000)),
        },
      );
    }
  }

  const previous = await client.query<{ id: string }>(
    `UPDATE staff_email_verifications
        SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
      WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING id::text`,
    [userId],
  );
  const previousIds = previous.rows.map((row) => row.id);
  if (previousIds.length) {
    await client.query(
      `UPDATE email_outbox
          SET status='OBSOLETE',verification_body_encrypted=NULL,locked_at=NULL,
              last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
        WHERE message_kind='STAFF_SECURITY'
          AND source_type='STAFF_EMAIL_VERIFICATION'
          AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
      [previousIds],
    );
  }

  const token = createSecurityToken();
  const request = await client.query<{ id: string; expiresAt: Date; resendAvailableAt: Date }>(
    `WITH timing AS (SELECT clock_timestamp() AS created_at)
     INSERT INTO staff_email_verifications (
       user_id,pending_email,token_hash,expires_at,created_at
     )
     SELECT $1,$2,$3,created_at+INTERVAL '30 minutes',created_at FROM timing
     RETURNING id::text,expires_at AS "expiresAt",
               created_at+INTERVAL '60 seconds' AS "resendAvailableAt"`,
    [userId, email, securityTokenHash(token)],
  );
  const row = request.rows[0];
  const env = serverEnv();
  const verifyUrl = `${env.APP_URL}/staff/email-verification/confirm?token=${encodeURIComponent(token)}`;
  await client.query(
    `INSERT INTO email_outbox (
       student_number,to_email,subject,text_body,html_body,message_kind,
       notification_type,source_type,source_id,verification_body_encrypted
     ) VALUES (
       NULL,$1,'Verify your MedClinic staff email',
       'Staff security email content is encrypted.',NULL,'STAFF_SECURITY',
       'STAFF_EMAIL_VERIFICATION','STAFF_EMAIL_VERIFICATION',$2,$3
     )`,
    [
      email,
      row.id,
      encryptVerificationEmailBody(
        `Verify your staff email within ${VERIFICATION_LIFETIME_MINUTES} minutes: ${verifyUrl}`,
        env.EMAIL_OUTBOX_ENCRYPTION_KEY,
      ),
    ],
  );
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES ($4,$1,'staff_email_verification',$2,$3::jsonb)`,
    [
      options.auditAction ?? "STAFF_EMAIL_VERIFICATION_REQUESTED",
      row.id,
      JSON.stringify({ userId, ...addressMetadata(email) }),
      options.actorUserId ?? null,
    ],
  );
  return {
    requestId: row.id,
    expiresAt: row.expiresAt,
    resendAvailableAt: row.resendAvailableAt,
  };
}

export async function confirmStaffEmail(token: string) {
  const hash = securityTokenHash(token);
  return transaction(async (client) => {
    const result = await client.query<StaffAccountRow & {
      requestId: string;
      pendingEmail: string;
      consumedAt: Date | null;
      invalidatedAt: Date | null;
      expired: boolean;
    }>(
      `SELECT ${staffAccountColumns},verification.id::text AS "requestId",
              verification.pending_email AS "pendingEmail",
              verification.consumed_at AS "consumedAt",
              verification.invalidated_at AS "invalidatedAt",
              verification.expires_at<=clock_timestamp() AS expired
         FROM staff_email_verifications verification
         JOIN users account ON account.id=verification.user_id
         LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
        WHERE verification.token_hash=$1 AND account.deleted_at IS NULL
        FOR UPDATE OF verification,account`,
      [hash],
    );
    const row = result.rows[0];
    if (
      !row
      || row.consumedAt
      || row.invalidatedAt
      || row.expired
      || row.email.trim().toLowerCase() !== row.pendingEmail.trim().toLowerCase()
    ) {
      throw new AppError(
        "STAFF_EMAIL_VERIFICATION_INVALID",
        "This staff email verification link is invalid or expired.",
        422,
      );
    }
    await client.query(
      "UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1",
      [row.id],
    );
    await client.query(
      "UPDATE staff_email_verifications SET consumed_at=clock_timestamp() WHERE id=$1",
      [row.requestId],
    );
    const invalidated = await client.query<{ id: string }>(
      `UPDATE staff_email_verifications SET invalidated_at=clock_timestamp()
        WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL AND invalidated_at IS NULL
        RETURNING id::text`,
      [row.id, row.requestId],
    );
    const obsoleteRequestIds = [row.requestId, ...invalidated.rows.map((item) => item.id)];
    await client.query(
      `UPDATE email_outbox SET status='OBSOLETE',verification_body_encrypted=NULL,
              locked_at=NULL,last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
        WHERE message_kind='STAFF_SECURITY' AND source_type='STAFF_EMAIL_VERIFICATION'
          AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
      [obsoleteRequestIds],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES (NULL,'STAFF_EMAIL_VERIFIED','user',$1,$2::jsonb)`,
      [row.id, JSON.stringify(addressMetadata(row.email))],
    );
    return {
      ...mapStaffAccount({ ...row, emailVerifiedAt: new Date() }),
      onboardingRequired: row.mustChangePassword,
    };
  });
}

export async function resendOwnStaffVerification(userId: string) {
  return transaction(async (client) => {
    const target = await client.query<{ email: string; emailVerifiedAt: Date | null }>(
      `SELECT email,email_verified_at AS "emailVerifiedAt" FROM users
        WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [userId],
    );
    const row = target.rows[0];
    if (!row) throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
    if (row.emailVerifiedAt) {
      throw new AppError("STAFF_EMAIL_ALREADY_VERIFIED", "Your staff email is already verified.", 409);
    }
    return queueStaffEmailVerification(client, userId, row.email, {
      auditAction: "STAFF_EMAIL_VERIFICATION_RESENT",
      actorUserId: userId,
    });
  });
}
