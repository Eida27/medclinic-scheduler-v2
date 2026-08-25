import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { encryptVerificationEmailBody } from "@/server/email/verification-body-encryption";
import {
  addressMetadata,
  createSecurityToken,
  securityTokenHash,
  staffAccountStatus,
  staffEmailSchema,
} from "@/server/security/staff-security";
import { transaction } from "@/server/db/pool";
import {
  consumeStaffEmailVerification,
  findStaffEmailVerificationForUpdate,
  findStaffVerificationTargetForUpdate,
  insertStaffAudit,
  insertStaffEmailVerification,
  insertStaffSecurityOutbox,
  invalidateOtherStaffEmailVerifications,
  invalidateStaffEmailVerifications,
  listRecentStaffEmailVerifications,
  markStaffEmailVerified,
  obsoleteStaffEmailVerificationMail,
} from "@/server/repositories/staff-security.repository";

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
  const recent = await listRecentStaffEmailVerifications(client, userId);
  const databaseNow = recent.at(-1)?.databaseNow ?? new Date();
  if (enforceRateLimit && recent.length >= THROTTLE_LIMIT) {
    const retryAt = new Date(recent[0].createdAt.getTime() + 15 * 60_000);
    throw new AppError(
      "STAFF_EMAIL_VERIFICATION_THROTTLED",
      "Too many verification emails were requested. Try again shortly.",
      429,
      undefined,
      { retryAt: retryAt.toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - databaseNow.getTime()) / 1000)) },
    );
  }
  const latest = recent.at(-1);
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

  const previousIds = await invalidateStaffEmailVerifications(client, userId);
  await obsoleteStaffEmailVerificationMail(client, previousIds);

  const token = createSecurityToken();
  const row = await insertStaffEmailVerification(client, {
    userId,
    email,
    tokenHash: securityTokenHash(token),
  });
  const env = serverEnv();
  const verifyUrl = `${env.APP_URL}/staff/email-verification/confirm?token=${encodeURIComponent(token)}`;
  await insertStaffSecurityOutbox(client, {
    email,
    subject: "Verify your MedClinic staff email",
    notificationType: "STAFF_EMAIL_VERIFICATION",
    sourceId: row.id,
    encryptedBody: encryptVerificationEmailBody(
        `Verify your staff email within ${VERIFICATION_LIFETIME_MINUTES} minutes: ${verifyUrl}`,
        env.EMAIL_OUTBOX_ENCRYPTION_KEY,
      ),
  });
  await insertStaffAudit(client, {
    actorUserId: options.actorUserId ?? null,
    action: options.auditAction ?? "STAFF_EMAIL_VERIFICATION_REQUESTED",
    entityType: "staff_email_verification",
    entityId: row.id,
    metadata: { userId, ...addressMetadata(email) },
  });
  return {
    requestId: row.id,
    expiresAt: row.expiresAt,
    resendAvailableAt: row.resendAvailableAt,
  };
}

export async function confirmStaffEmail(token: string) {
  const hash = securityTokenHash(token);
  return transaction(async (client) => {
    const row = await findStaffEmailVerificationForUpdate(client, hash);
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
    await markStaffEmailVerified(client, row.id);
    await consumeStaffEmailVerification(client, row.requestId);
    const invalidatedIds = await invalidateOtherStaffEmailVerifications(client, row.id, row.requestId);
    await obsoleteStaffEmailVerificationMail(client, [row.requestId, ...invalidatedIds]);
    await insertStaffAudit(client, {
      actorUserId: null,
      action: "STAFF_EMAIL_VERIFIED",
      entityType: "user",
      entityId: row.id,
      metadata: addressMetadata(row.email),
    });
    return {
      status: staffAccountStatus({ emailVerifiedAt: new Date(), mustChangePassword: row.mustChangePassword }),
      emailVerified: true,
      mustChangePassword: row.mustChangePassword,
      onboardingRequired: row.mustChangePassword,
    };
  });
}

export async function resendOwnStaffVerification(userId: string) {
  return transaction(async (client) => {
    const row = await findStaffVerificationTargetForUpdate(client, userId);
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
