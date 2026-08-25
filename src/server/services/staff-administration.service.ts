import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction, query } from "@/server/db/pool";
import { addressMetadata, staffEmailSchema, staffFullNameSchema } from "@/server/security/staff-security";
import type { UserRole } from "@/types/roles";
import { queueStaffEmailVerification } from "./staff-email-verification.service";
import {
  lockOperationalAdministrator,
  mapStaffAccount,
  requireDifferentPassword,
  staffAccountColumns,
  type StaffAccountRow,
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
      const created = await client.query<StaffAccountRow>(
        `INSERT INTO users (
           full_name,email,password_hash,role,clinic_id,email_verified_at,
           must_change_password,credential_version
         ) VALUES (
           $1,$2,$3,$4,(SELECT id FROM clinics WHERE code=$5),NULL,TRUE,1
         )
         RETURNING id::text,full_name AS "fullName",email,role,
                   clinic_id AS "clinicId",NULL::text AS "clinicCode",NULL::text AS "clinicName",
                   email_verified_at AS "emailVerifiedAt",
                   must_change_password AS "mustChangePassword",
                   credential_version AS "credentialVersion"`,
        [input.fullName, input.email, passwordHash, input.role, input.clinicCode],
      );
      const row = created.rows[0];
      if (input.clinicCode) {
        row.clinicCode = input.clinicCode;
        row.clinicName = (await client.query<{ name: string }>("SELECT name FROM clinics WHERE id=$1", [row.clinicId])).rows[0]?.name ?? null;
      }
      await queueStaffEmailVerification(client, row.id, row.email, {
        enforceRateLimit: false,
        actorUserId,
      });
      await client.query(
        `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         VALUES ($1,'STAFF_USER_CREATED','user',$2,$3::jsonb)`,
        [actorUserId, row.id, JSON.stringify({ fullName: row.fullName, role: row.role, ...addressMetadata(row.email) })],
      );
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
  const result = await query<StaffAccountRow & { createdAt: Date }>(
    `SELECT ${staffAccountColumns},account.created_at AS "createdAt"
       FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
      WHERE account.deleted_at IS NULL ORDER BY account.full_name,account.id`,
  );
  return result.rows.map((row) => ({ ...mapStaffAccount(row), createdAt: row.createdAt.toISOString() }));
}

export async function resendStaffVerification(userId: string, actorUserId: string) {
  return transaction(async (client) => {
    await lockOperationalAdministrator(client, actorUserId);
    const target = await client.query<{ email: string; emailVerifiedAt: Date | null }>(
      `SELECT email,email_verified_at AS "emailVerifiedAt" FROM users
        WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [userId],
    );
    const row = target.rows[0];
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

async function obsoleteStaffSecurityMail(
  client: import("pg").PoolClient,
  userId: string,
  sourceTypes: Array<"STAFF_EMAIL_VERIFICATION" | "STAFF_PASSWORD_RESET"> = [
    "STAFF_EMAIL_VERIFICATION",
    "STAFF_PASSWORD_RESET",
  ],
) {
  await client.query(
    `UPDATE email_outbox SET status='OBSOLETE',verification_body_encrypted=NULL,
            locked_at=NULL,last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
      WHERE message_kind='STAFF_SECURITY' AND status NOT IN ('SENT','OBSOLETE')
        AND source_type=ANY($2::text[])
        AND source_id IN (
          SELECT id::text FROM staff_email_verifications WHERE user_id=$1
          UNION ALL SELECT id::text FROM staff_password_resets WHERE user_id=$1
        )`,
    [userId, sourceTypes],
  );
}

export async function changeStaffEmail(actorUserId: string, userId: string, rawEmail: string) {
  const email = staffEmailSchema.parse(rawEmail);
  try {
    return await transaction(async (client) => {
      await lockOperationalAdministrator(client, actorUserId);
      const target = await client.query<StaffAccountRow & { passwordHash: string }>(
        `SELECT ${staffAccountColumns},account.password_hash AS "passwordHash"
           FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
          WHERE account.id=$1 AND account.deleted_at IS NULL FOR UPDATE OF account`,
        [userId],
      );
      const row = target.rows[0];
      if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
      if (row.email === email) throw new AppError("STAFF_EMAIL_UNCHANGED", "Enter a different email address.", 422);
      const oldMetadata = addressMetadata(row.email);
      await client.query(
        "UPDATE staff_email_verifications SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND consumed_at IS NULL",
        [userId],
      );
      await client.query(
        "UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND consumed_at IS NULL",
        [userId],
      );
      await obsoleteStaffSecurityMail(client, userId);
      const updated = await client.query<StaffAccountRow>(
        `UPDATE users SET email=$2,email_verified_at=NULL,
                          credential_version=credential_version+1
          WHERE id=$1
          RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
                    NULL::text AS "clinicCode",NULL::text AS "clinicName",
                    email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
                    credential_version AS "credentialVersion"`,
        [userId, email],
      );
      const current = updated.rows[0];
      current.clinicCode = row.clinicCode;
      current.clinicName = row.clinicName;
      await queueStaffEmailVerification(client, userId, email, { enforceRateLimit: false, actorUserId });
      await client.query(
        `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         VALUES ($1,'STAFF_EMAIL_CHANGED','user',$2,$3::jsonb)`,
        [actorUserId, userId, JSON.stringify({ previous: oldMetadata, current: addressMetadata(email) })],
      );
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
    const target = await client.query<StaffAccountRow & { passwordHash: string }>(
      `SELECT ${staffAccountColumns},account.password_hash AS "passwordHash"
         FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
        WHERE account.id=$1 AND account.deleted_at IS NULL FOR UPDATE OF account`,
      [userId],
    );
    const row = target.rows[0];
    if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
    await requireDifferentPassword(password, row.passwordHash);
    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await client.query<StaffAccountRow>(
      `UPDATE users SET password_hash=$2,must_change_password=TRUE,
                        credential_version=credential_version+1 WHERE id=$1
       RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
                 NULL::text AS "clinicCode",NULL::text AS "clinicName",
                 email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
                 credential_version AS "credentialVersion"`,
      [userId, passwordHash],
    );
    await client.query(
      "UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND consumed_at IS NULL",
      [userId],
    );
    await obsoleteStaffSecurityMail(client, userId, ["STAFF_PASSWORD_RESET"]);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'STAFF_TEMP_PASSWORD_RESET_BY_ADMIN','user',$2,$3::jsonb)`,
      [actorUserId, userId, JSON.stringify({ role: row.role, ...addressMetadata(row.email) })],
    );
    const current = updated.rows[0];
    current.clinicCode = row.clinicCode;
    current.clinicName = row.clinicName;
    return mapStaffAccount(current);
  });
}

export async function deleteStaffUser(actorUserId: string, userId: string) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:staff-admin-set'))");
    await lockOperationalAdministrator(client, actorUserId);
    if (actorUserId === userId) {
      throw new AppError("STAFF_SELF_DELETE_FORBIDDEN", "You cannot delete your own account.", 422);
    }
    const target = await client.query<StaffAccountRow>(
      `SELECT ${staffAccountColumns}
         FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
        WHERE account.id=$1 AND account.deleted_at IS NULL FOR UPDATE OF account`,
      [userId],
    );
    const row = target.rows[0];
    if (!row) throw new AppError("STAFF_USER_NOT_FOUND", "Staff user not found.", 404);
    if (row.role === "ADMIN") {
      const count = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND deleted_at IS NULL",
      );
      if (count.rows[0].count <= 1) {
        throw new AppError("STAFF_LAST_ADMIN_DELETE_FORBIDDEN", "The final Administrator cannot be deleted.", 409);
      }
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'STAFF_USER_DELETED','user',$2,$3::jsonb)`,
      [actorUserId, userId, JSON.stringify({ fullName: row.fullName, role: row.role, ...addressMetadata(row.email) })],
    );
    await client.query(
      "UPDATE staff_email_verifications SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND consumed_at IS NULL",
      [userId],
    );
    await client.query(
      "UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND consumed_at IS NULL",
      [userId],
    );
    await obsoleteStaffSecurityMail(client, userId);
    await client.query(
      `UPDATE users SET credential_version=credential_version+1,email=NULL,password_hash=NULL,
              email_verified_at=NULL,must_change_password=FALSE,deleted_at=clock_timestamp(),deleted_by=$2
        WHERE id=$1`,
      [userId, actorUserId],
    );
    return { deleted: true, id: userId };
  });
}
