import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import {
  staffAccountStatus,
  staffPasswordSchema,
} from "@/server/security/staff-security";
import { findOperationalAdministratorForUpdate } from "@/server/repositories/staff-security.repository";

export { staffAccountColumns, type StaffAccountRow } from "@/server/repositories/staff-security.repository";

export async function lockOperationalAdministrator(client: PoolClient, actorUserId: string) {
  const actor = await findOperationalAdministratorForUpdate(client, actorUserId);
  if (!actor) {
    throw new AppError("ADMIN_REQUIRED", "An active, onboarded Administrator is required.", 403);
  }
  return actor;
}

export function validatedPasswordPair(password: string, confirmation: string) {
  const parsed = staffPasswordSchema.parse(password);
  if (parsed !== confirmation) {
    throw new AppError(
      "PASSWORD_CONFIRMATION_MISMATCH",
      "Password confirmation does not match.",
      422,
      { confirmPassword: ["Password confirmation does not match."] },
    );
  }
  return parsed;
}

export async function requireDifferentPassword(newPassword: string, storedPasswordHash: string) {
  if (await bcrypt.compare(newPassword, storedPasswordHash)) {
    throw new AppError("PASSWORD_UNCHANGED", "Choose a password different from the current password.", 422);
  }
}

export function mapStaffAccount(row: {
  id: string;
  fullName: string;
  email: string;
  role: "ADMIN" | "COORDINATOR" | "CLINIC_STAFF";
  clinicId: string | null;
  clinicCode: string | null;
  clinicName: string | null;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  credentialVersion: number;
}) {
  return {
    id: row.id,
    userId: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    clinicId: row.clinicId,
    clinicCode: row.clinicCode,
    clinicName: row.clinicName,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    emailVerified: Boolean(row.emailVerifiedAt),
    mustChangePassword: row.mustChangePassword,
    credentialVersion: row.credentialVersion,
    status: staffAccountStatus(row),
  };
}
