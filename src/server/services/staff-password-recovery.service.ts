import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { transaction } from "@/server/db/pool";
import { encryptEmailOutboxSensitiveBody } from "@/server/email/verification-body-encryption";
import {
  consumeStaffPasswordReset,
  findEligibleStaffPasswordResetAccountForUpdate,
  findStaffPasswordResetForUpdate,
  insertStaffAudit,
  insertStaffPasswordReset,
  insertStaffSecurityOutbox,
  invalidateActiveStaffPasswordResets,
  invalidateOtherStaffPasswordResets,
  listRecentStaffPasswordResets,
  obsoleteStaffPasswordResetMail,
  updateStaffPasswordFromReset,
} from "@/server/repositories/staff-security.repository";
import {
  addressMetadata,
  createSecurityToken,
  securityTokenHash,
  staffEmailSchema,
} from "@/server/security/staff-security";
import { requireDifferentPassword, validatedPasswordPair } from "./staff-service-helpers";

export async function requestStaffPasswordReset(rawEmail: string) {
  const parsed = staffEmailSchema.safeParse(rawEmail);
  if (!parsed.success) return { accepted: true as const };
  await transaction(async (client) => {
    const user = await findEligibleStaffPasswordResetAccountForUpdate(client, parsed.data);
    if (!user) return;
    const recent = await listRecentStaffPasswordResets(client, user.id);
    const latest = recent.at(-1);
    if (recent.length >= 5) return;
    if (latest && latest.createdAt.getTime() + 60_000 > latest.databaseNow.getTime()) return;
    const oldResetIds = await invalidateActiveStaffPasswordResets(client, user.id);
    await obsoleteStaffPasswordResetMail(client, oldResetIds);
    const token = createSecurityToken();
    const request = await insertStaffPasswordReset(client, user.id, securityTokenHash(token));
    const env = serverEnv();
    const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await insertStaffSecurityOutbox(client, {
      email: user.email,
      subject: "Reset your MedClinic staff password",
      notificationType: "STAFF_PASSWORD_RESET",
      sourceId: request.id,
      encryptedBody: encryptEmailOutboxSensitiveBody(
          `Reset your staff password within 30 minutes: ${resetUrl}`,
          env.EMAIL_OUTBOX_ENCRYPTION_KEY,
        ),
    });
    await insertStaffAudit(client, {
      actorUserId: null,
      action: "STAFF_PASSWORD_RESET_REQUESTED",
      entityType: "staff_password_reset",
      entityId: request.id,
      metadata: { userId: user.id, ...addressMetadata(user.email) },
    });
  });
  return { accepted: true as const };
}

export async function resetStaffPassword(raw: unknown) {
  const input = z.object({
    token: z.string().min(1).max(256),
    newPassword: z.string(),
    confirmPassword: z.string(),
  }).parse(raw);
  const newPassword = validatedPasswordPair(input.newPassword, input.confirmPassword);
  return transaction(async (client) => {
    const row = await findStaffPasswordResetForUpdate(client, securityTokenHash(input.token));
    if (!row || row.consumedAt || row.invalidatedAt || row.expired) {
      throw new AppError("STAFF_PASSWORD_RESET_INVALID", "This password reset link is invalid or expired.", 422);
    }
    await requireDifferentPassword(newPassword, row.storedPasswordHash);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const credentialVersion = await updateStaffPasswordFromReset(client, row.userId, passwordHash);
    await consumeStaffPasswordReset(client, row.id);
    const otherResetIds = await invalidateOtherStaffPasswordResets(client, row.userId, row.id);
    await obsoleteStaffPasswordResetMail(client, [row.id, ...otherResetIds]);
    await insertStaffAudit(client, {
      actorUserId: null,
      action: "STAFF_PASSWORD_RESET_COMPLETED",
      entityType: "user",
      entityId: row.userId,
      metadata: { role: row.role, ...addressMetadata(row.email) },
    });
    return { userId: row.userId, credentialVersion };
  });
}
