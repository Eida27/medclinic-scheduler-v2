import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  countNonDeletedAdministrators,
  findClinicName,
  findStaffAccountForUpdate,
  findStaffVerificationTargetForUpdate,
  insertStaffAudit,
  insertStaffUser,
  invalidateStaffEmailVerifications,
  invalidateStaffPasswordResets,
  listActiveStaffAccounts,
  lockStaffAdministratorSet,
  obsoleteStaffSecurityMailForUser,
  tombstoneStaffUser,
  updateStaffEmail,
  updateStaffTemporaryPassword,
} from "@/server/repositories/staff-security.repository";
import { addressMetadata, staffEmailSchema, staffFullNameSchema } from "@/server/security/staff-security";
import type { UserRole } from "@/types/roles";
import { queueStaffEmailVerification } from "./staff-email-verification.service";
import {
  lockOperationalAdministrator,
  mapStaffAccount,
  requireDifferentPassword,
  validatedPasswordPair,
} from "./staff-service-helpers";

const roleSchema = z.enum(["ADMIN", "COORDINATOR", "CLINIC_STAFF"]);
const clinicCodeSchema = z.union([
  z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]),
  z.literal(""),
  z.null(),
  z.undefined(),
]).transform((value) => value || null);

function validateClinic(role: UserRole, clinicCode: string | null) {
  if (role === "CLINIC_STAFF" && !clinicCode) {
    throw new AppError("CLINIC_REQUIRED", "Clinic staff must be assigned to a clinic.", 422);
  }
  if (role !== "CLINIC_STAFF" && clinicCode) {
    throw new AppError("GLOBAL_ROLE_REQUIRED", "Administrator and Coordinator accounts must be global.", 422);
  }
}

export async function createStaffUser(raw: unknown, actorUserId: string) {
  const input = z.object({
    fullName: staffFullNameSchema,
    email: staffEmailSchema,
    temporaryPassword: z.string(),
    confirmTemporaryPassword: z.string(),
    role: roleSchema,
    clinicCode: clinicCodeSchema,
  }).parse(raw);
  validateClinic(input.role, input.clinicCode);
  const password = validatedPasswordPair(input.temporaryPassword, input.confirmTemporaryPassword);
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    return await transaction(async (client) => {
      await lockOperationalAdministrator(client, actorUserId);
      const row = await insertStaffUser(client, {
        fullName: input.fullName,
        email: input.email,
        passwordHash,
        role: input.role,
        clinicCode: input.clinicCode,
      });
      if (input.clinicCode) {
        row.clinicCode = input.clinicCode;
        row.clinicName = await findClinicName(client, row.clinicId);
      }
      await queueStaffEmailVerification(client, row.id, row.email, {
        enforceRateLimit: false,
        actorUserId,
      });
      await insertStaffAudit(client, {
        actorUserId,
        action: "STAFF_USER_CREATED",
        entityType: "user",
        entityId: row.id,
        metadata: { fullName: row.fullName, role: row.role, ...addressMetadata(row.email) },
      });
      return mapStaffAccount(row);
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError("STAFF_EMAIL_IN_USE", "That email address is already in use.", 409);
    }
    throw error;
  }
}

export async function listStaffUsers() {
  return (await listActiveStaffAccounts())
    .map((row) => ({ ...mapStaffAccount(row), createdAt: row.createdAt.toISOString() }));
}

export async function resendStaffVerification(userId: string, actorUserId: string) {
  return transaction(async (client) => {
    await lockOperationalAdministrator(client, actorUserId);
    const row = await findStaffVerificationTargetForUpdate(client, userId);
    if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
    if (row.emailVerifiedAt) {
      throw new AppError("STAFF_EMAIL_ALREADY_VERIFIED", "This staff email is already verified.", 409);
    }
    return queueStaffEmailVerification(client, userId, row.email, {
      auditAction: "STAFF_EMAIL_VERIFICATION_RESENT",
      actorUserId,
    });
  });
}

export async function changeStaffEmail(actorUserId: string, userId: string, rawEmail: string) {
  const email = staffEmailSchema.parse(rawEmail);
  try {
    return await transaction(async (client) => {
      await lockOperationalAdministrator(client, actorUserId);
      const row = await findStaffAccountForUpdate(client, userId);
      if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
      if (row.email === email) throw new AppError("STAFF_EMAIL_UNCHANGED", "Enter a different email address.", 422);
      const oldMetadata = addressMetadata(row.email);
      await invalidateStaffEmailVerifications(client, userId);
      await invalidateStaffPasswordResets(client, userId);
      await obsoleteStaffSecurityMailForUser(client, userId, ["STAFF_EMAIL_VERIFICATION", "STAFF_PASSWORD_RESET"]);
      const current = await updateStaffEmail(client, userId, email);
      current.clinicCode = row.clinicCode;
      current.clinicName = row.clinicName;
      await queueStaffEmailVerification(client, userId, email, { enforceRateLimit: false, actorUserId });
      await insertStaffAudit(client, {
        actorUserId,
        action: "STAFF_EMAIL_CHANGED",
        entityType: "user",
        entityId: userId,
        metadata: { previous: oldMetadata, current: addressMetadata(email) },
      });
      return mapStaffAccount(current);
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new AppError("STAFF_EMAIL_IN_USE", "That email address is already in use.", 409);
    throw error;
  }
}

export async function resetStaffTemporaryPassword(
  actorUserId: string,
  userId: string,
  input: { temporaryPassword: string; confirmTemporaryPassword: string },
) {
  const password = validatedPasswordPair(input.temporaryPassword, input.confirmTemporaryPassword);
  return transaction(async (client) => {
    await lockOperationalAdministrator(client, actorUserId);
    const row = await findStaffAccountForUpdate(client, userId);
    if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
    await requireDifferentPassword(password, row.passwordHash);
    const passwordHash = await bcrypt.hash(password, 12);
    const current = await updateStaffTemporaryPassword(client, userId, passwordHash);
    await invalidateStaffPasswordResets(client, userId);
    await obsoleteStaffSecurityMailForUser(client, userId, ["STAFF_PASSWORD_RESET"]);
    await insertStaffAudit(client, {
      actorUserId,
      action: "STAFF_TEMP_PASSWORD_RESET_BY_ADMIN",
      entityType: "user",
      entityId: userId,
      metadata: { role: row.role, ...addressMetadata(row.email) },
    });
    current.clinicCode = row.clinicCode;
    current.clinicName = row.clinicName;
    return mapStaffAccount(current);
  });
}

export async function deleteStaffUser(actorUserId: string, userId: string) {
  return transaction(async (client) => {
    await lockStaffAdministratorSet(client);
    await lockOperationalAdministrator(client, actorUserId);
    if (actorUserId === userId) {
      throw new AppError("STAFF_SELF_DELETE_FORBIDDEN", "You cannot delete your own account.", 422);
    }
    const row = await findStaffAccountForUpdate(client, userId);
    if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
    if (row.role === "ADMIN") {
      if (await countNonDeletedAdministrators(client) <= 1) {
        throw new AppError("STAFF_LAST_ADMIN_DELETE_FORBIDDEN", "The final Administrator cannot be deleted.", 409);
      }
    }
    await insertStaffAudit(client, {
      actorUserId,
      action: "STAFF_USER_DELETED",
      entityType: "user",
      entityId: userId,
      metadata: { fullName: row.fullName, role: row.role, ...addressMetadata(row.email) },
    });
    await invalidateStaffEmailVerifications(client, userId);
    await invalidateStaffPasswordResets(client, userId);
    await obsoleteStaffSecurityMailForUser(client, userId, ["STAFF_EMAIL_VERIFICATION", "STAFF_PASSWORD_RESET"]);
    await tombstoneStaffUser(client, userId, actorUserId);
    return { deleted: true, id: userId };
  });
}
