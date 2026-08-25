import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { transaction } from "@/server/db/pool";
import { encryptEmailOutboxSensitiveBody } from "@/server/email/verification-body-encryption";
import {
  addressMetadata,
  createSecurityToken,
  securityTokenHash,
  staffEmailSchema,
} from "@/server/security/staff-security";
import { requireDifferentPassword, validatedPasswordPair } from "./staff-service-helpers";

async function obsoleteResetMail(client: import("pg").PoolClient, requestIds: string[]) {
  if (!requestIds.length) return;
  await client.query(
    `UPDATE email_outbox SET status='OBSOLETE',verification_body_encrypted=NULL,
            locked_at=NULL,last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
      WHERE message_kind='STAFF_SECURITY' AND source_type='STAFF_PASSWORD_RESET'
        AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
    [requestIds],
  );
}

export async function requestStaffPasswordReset(rawEmail: string) {
  const parsed = staffEmailSchema.safeParse(rawEmail);
  if (!parsed.success) return { accepted: true as const };
  await transaction(async (client) => {
    const account = await client.query<{ id: string; email: string }>(
      `SELECT id::text,email FROM users
        WHERE email=$1 AND deleted_at IS NULL AND email_verified_at IS NOT NULL
          AND must_change_password=FALSE FOR UPDATE`,
      [parsed.data],
    );
    const user = account.rows[0];
    if (!user) return;
    const recent = await client.query<{ createdAt: Date; databaseNow: Date }>(
      `SELECT created_at AS "createdAt",clock_timestamp() AS "databaseNow"
         FROM staff_password_resets
        WHERE user_id=$1 AND created_at>clock_timestamp()-INTERVAL '15 minutes'
        ORDER BY created_at`,
      [user.id],
    );
    const latest = recent.rows.at(-1);
    if (recent.rows.length >= 5) return;
    if (latest && latest.createdAt.getTime() + 60_000 > latest.databaseNow.getTime()) return;
    const old = await client.query<{ id: string }>(
      `UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
        WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL RETURNING id::text`,
      [user.id],
    );
    await obsoleteResetMail(client, old.rows.map((row) => row.id));
    const token = createSecurityToken();
    const request = await client.query<{ id: string }>(
      `INSERT INTO staff_password_resets (user_id,token_hash,expires_at)
       VALUES ($1,$2,clock_timestamp()+INTERVAL '30 minutes') RETURNING id::text`,
      [user.id, securityTokenHash(token)],
    );
    const env = serverEnv();
    const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await client.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,html_body,message_kind,
         notification_type,source_type,source_id,verification_body_encrypted
       ) VALUES (
         NULL,$1,'Reset your MedClinic staff password',
         'Staff security email content is encrypted.',NULL,'STAFF_SECURITY',
         'STAFF_PASSWORD_RESET','STAFF_PASSWORD_RESET',$2,$3
       )`,
      [
        user.email,
        request.rows[0].id,
        encryptEmailOutboxSensitiveBody(
          `Reset your staff password within 30 minutes: ${resetUrl}`,
          env.EMAIL_OUTBOX_ENCRYPTION_KEY,
        ),
      ],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES (NULL,'STAFF_PASSWORD_RESET_REQUESTED','staff_password_reset',$1,$2::jsonb)`,
      [request.rows[0].id, JSON.stringify({ userId: user.id, ...addressMetadata(user.email) })],
    );
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
    const request = await client.query<{
      id: string;
      userId: string;
      email: string;
      role: string;
      storedPasswordHash: string;
      credentialVersion: number;
      consumedAt: Date | null;
      invalidatedAt: Date | null;
      expired: boolean;
    }>(
      `SELECT reset.id::text,reset.user_id::text AS "userId",account.email,account.role,
              account.password_hash AS "storedPasswordHash",
              account.credential_version AS "credentialVersion",
              reset.consumed_at AS "consumedAt",reset.invalidated_at AS "invalidatedAt",
              reset.expires_at<=clock_timestamp() AS expired
         FROM staff_password_resets reset JOIN users account ON account.id=reset.user_id
        WHERE reset.token_hash=$1 AND account.deleted_at IS NULL
          AND account.email_verified_at IS NOT NULL AND account.must_change_password=FALSE
        FOR UPDATE OF reset,account`,
      [securityTokenHash(input.token)],
    );
    const row = request.rows[0];
    if (!row || row.consumedAt || row.invalidatedAt || row.expired) {
      throw new AppError("STAFF_PASSWORD_RESET_INVALID", "This password reset link is invalid or expired.", 422);
    }
    await requireDifferentPassword(newPassword, row.storedPasswordHash);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await client.query<{ credentialVersion: number }>(
      `UPDATE users SET password_hash=$2,credential_version=credential_version+1
        WHERE id=$1 RETURNING credential_version AS "credentialVersion"`,
      [row.userId, passwordHash],
    );
    await client.query("UPDATE staff_password_resets SET consumed_at=clock_timestamp() WHERE id=$1", [row.id]);
    const others = await client.query<{ id: string }>(
      `UPDATE staff_password_resets SET invalidated_at=clock_timestamp()
        WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL AND invalidated_at IS NULL
        RETURNING id::text`,
      [row.userId, row.id],
    );
    await obsoleteResetMail(client, [row.id, ...others.rows.map((item) => item.id)]);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES (NULL,'STAFF_PASSWORD_RESET_COMPLETED','user',$1,$2::jsonb)`,
      [row.userId, JSON.stringify({ role: row.role, ...addressMetadata(row.email) })],
    );
    return { userId: row.userId, credentialVersion: updated.rows[0].credentialVersion };
  });
}
