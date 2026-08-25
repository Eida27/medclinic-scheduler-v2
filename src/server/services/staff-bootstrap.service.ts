import bcrypt from "bcryptjs";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  findNonDeletedAdministratorForUpdate,
  insertBootstrapAdministrator,
  insertStaffAudit,
  lockStaffAdministratorSet,
} from "@/server/repositories/staff-security.repository";
import {
  addressMetadata,
  staffAccountStatus,
  staffEmailSchema,
  staffFullNameSchema,
  staffPasswordSchema,
} from "@/server/security/staff-security";
import { queueStaffEmailVerification } from "./staff-email-verification.service";

export type BootstrapAdministratorInput = {
  fullName: string;
  email: string;
  temporaryPassword: string;
};

export async function bootstrapFirstAdministrator(input: BootstrapAdministratorInput) {
  const fullName = staffFullNameSchema.parse(input.fullName);
  const email = staffEmailSchema.parse(input.email);
  const temporaryPassword = staffPasswordSchema.parse(input.temporaryPassword);
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  try {
    return await transaction(async (client) => {
      await lockStaffAdministratorSet(client);
      if (await findNonDeletedAdministratorForUpdate(client)) {
        throw new AppError(
          "STAFF_ADMIN_EXISTS",
          "A non-deleted Administrator already exists; bootstrap is no longer available.",
          409,
        );
      }

      const user = await insertBootstrapAdministrator(client, { fullName, email, passwordHash });
      await queueStaffEmailVerification(client, user.id, user.email, { enforceRateLimit: false });
      await insertStaffAudit(client, {
        actorUserId: null,
        action: "STAFF_BOOTSTRAP_ADMIN_CREATED",
        entityType: "user",
        entityId: user.id,
        metadata: { fullName, role: "ADMIN", ...addressMetadata(email) },
      });
      return {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: "ADMIN" as const,
        status: staffAccountStatus(user),
      };
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError("STAFF_EMAIL_IN_USE", "That email address is already in use.", 409);
    }
    throw error;
  }
}
