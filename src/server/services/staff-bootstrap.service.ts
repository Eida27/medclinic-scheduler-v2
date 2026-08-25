import bcrypt from "bcryptjs";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:staff-admin-set'))");
      const existing = await client.query(
        "SELECT id FROM users WHERE role='ADMIN' AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      );
      if (existing.rowCount) {
        throw new AppError(
          "STAFF_ADMIN_EXISTS",
          "A non-deleted Administrator already exists; bootstrap is no longer available.",
          409,
        );
      }

      const created = await client.query<{
        id: string;
        fullName: string;
        email: string;
        emailVerifiedAt: Date | null;
        mustChangePassword: boolean;
      }>(
        `INSERT INTO users (
           full_name,email,password_hash,role,clinic_id,email_verified_at,
           must_change_password,credential_version
         ) VALUES ($1,$2,$3,'ADMIN',NULL,NULL,TRUE,1)
         RETURNING id::text,full_name AS "fullName",email,
                   email_verified_at AS "emailVerifiedAt",
                   must_change_password AS "mustChangePassword"`,
        [fullName, email, passwordHash],
      );
      const user = created.rows[0];
      await queueStaffEmailVerification(client, user.id, user.email, { enforceRateLimit: false });
      await client.query(
        `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         VALUES (NULL,'STAFF_BOOTSTRAP_ADMIN_CREATED','user',$1,$2::jsonb)`,
        [user.id, JSON.stringify({ fullName, role: "ADMIN", ...addressMetadata(email) })],
      );
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
