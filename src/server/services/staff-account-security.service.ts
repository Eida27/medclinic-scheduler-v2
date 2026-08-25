import bcrypt from "bcryptjs";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  findOperationalStaffAccount,
  findStaffAccountForUpdate,
  findStaffOnboarding,
  insertStaffAudit,
  invalidateStaffPasswordResets,
  obsoleteStaffPasswordResetMail,
  updateStaffPassword,
} from "@/server/repositories/staff-security.repository";
import { addressMetadata, staffAccountStatus } from "@/server/security/staff-security";
import {
  mapStaffAccount,
  requireDifferentPassword,
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
  const row = await findStaffOnboarding(userId);
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
  const row = await findOperationalStaffAccount(userId);
  if (!row) throw new AppError("ONBOARDING_REQUIRED", "Complete account security onboarding before using MedClinic.", 403);
  return mapStaffAccount(row);
}

async function invalidatePasswordResets(client: import("pg").PoolClient, userId: string) {
  const resetIds = await invalidateStaffPasswordResets(client, userId);
  await obsoleteStaffPasswordResetMail(client, resetIds);
}

async function changePassword(
  userId: string,
  input: PasswordChangeInput,
  mode: "temporary" | "ordinary",
) {
  const newPassword = validatedPasswordPair(input.newPassword, input.confirmPassword);
  return transaction(async (client) => {
    const row = await findStaffAccountForUpdate(client, userId);
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
    const updated = await updateStaffPassword(client, userId, passwordHash);
    await invalidatePasswordResets(client, userId);
    await insertStaffAudit(client, {
      actorUserId: userId,
      action: mode === "temporary" ? "STAFF_TEMP_PASSWORD_REPLACED" : "STAFF_PASSWORD_CHANGED",
      entityType: "user",
      entityId: userId,
      metadata: { role: row.role, ...addressMetadata(row.email) },
    });
    const current = updated;
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
