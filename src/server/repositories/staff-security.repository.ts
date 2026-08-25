import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export const staffAccountColumns = `
  account.id::text AS id,account.full_name AS "fullName",account.email,
  account.role,account.clinic_id AS "clinicId",clinic.code AS "clinicCode",
  clinic.name AS "clinicName",account.email_verified_at AS "emailVerifiedAt",
  account.must_change_password AS "mustChangePassword",
  account.credential_version AS "credentialVersion"`;

export type StaffAccountRow = {
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
};

export type StaffOnboardingRow = {
  email: string;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  latestRequestAt: Date | null;
  databaseNow: Date;
};

export async function findStaffOnboarding(userId: string) {
  const result = await query<StaffOnboardingRow>(
    `SELECT account.email,account.email_verified_at AS "emailVerifiedAt",
            account.must_change_password AS "mustChangePassword",
            latest.created_at AS "latestRequestAt",clock_timestamp() AS "databaseNow"
       FROM users account
       LEFT JOIN LATERAL (
         SELECT created_at FROM staff_email_verifications
          WHERE user_id=account.id ORDER BY created_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE account.id=$1 AND account.deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function findOperationalStaffAccount(userId: string) {
  const result = await query<StaffAccountRow>(
    `SELECT ${staffAccountColumns}
       FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
      WHERE account.id=$1 AND account.deleted_at IS NULL
        AND account.email_verified_at IS NOT NULL AND account.must_change_password=FALSE`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function findStaffAccountForUpdate(client: PoolClient, userId: string) {
  const result = await client.query<StaffAccountRow & { passwordHash: string }>(
    `SELECT ${staffAccountColumns},account.password_hash AS "passwordHash"
       FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
      WHERE account.id=$1 AND account.deleted_at IS NULL FOR UPDATE OF account`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function updateStaffPassword(client: PoolClient, userId: string, passwordHash: string) {
  const result = await client.query<StaffAccountRow>(
    `UPDATE users SET password_hash=$2,must_change_password=FALSE,
                      credential_version=credential_version+1 WHERE id=$1
     RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
               NULL::text AS "clinicCode",NULL::text AS "clinicName",
               email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
               credential_version AS "credentialVersion"`,
    [userId, passwordHash],
  );
  return result.rows[0];
}

export async function invalidateStaffPasswordResets(client: PoolClient, userId: string) {
  const result = await client.query<{ id: string }>(
    `UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
      WHERE user_id=$1 AND consumed_at IS NULL RETURNING id::text`,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

export async function obsoleteStaffPasswordResetMail(client: PoolClient, resetIds: string[]) {
  if (!resetIds.length) return;
  await client.query(
    `UPDATE email_outbox SET status='OBSOLETE',verification_body_encrypted=NULL,
            locked_at=NULL,last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
      WHERE message_kind='STAFF_SECURITY' AND source_type='STAFF_PASSWORD_RESET'
        AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
    [resetIds],
  );
}

export async function insertStaffAudit(
  client: PoolClient,
  input: {
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [input.actorUserId, input.action, input.entityType, input.entityId, JSON.stringify(input.metadata)],
  );
}

export async function lockStaffAdministratorSet(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:staff-admin-set'))");
}

export async function findNonDeletedAdministratorForUpdate(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    "SELECT id::text FROM users WHERE role='ADMIN' AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
  );
  return result.rows[0] ?? null;
}

export async function insertBootstrapAdministrator(
  client: PoolClient,
  input: { fullName: string; email: string; passwordHash: string },
) {
  const result = await client.query<{
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
    [input.fullName, input.email, input.passwordHash],
  );
  return result.rows[0];
}

export async function findOperationalAdministratorForUpdate(client: PoolClient, actorUserId: string) {
  const result = await client.query<{ id: string }>(
    `SELECT id::text FROM users
      WHERE id=$1 AND role='ADMIN' AND deleted_at IS NULL
        AND email_verified_at IS NOT NULL AND must_change_password=FALSE
      FOR UPDATE`,
    [actorUserId],
  );
  return result.rows[0] ?? null;
}

export async function listRecentStaffEmailVerifications(client: PoolClient, userId: string) {
  const result = await client.query<{ createdAt: Date; databaseNow: Date }>(
    `SELECT created_at AS "createdAt",clock_timestamp() AS "databaseNow"
       FROM staff_email_verifications
      WHERE user_id=$1 AND created_at>clock_timestamp()-INTERVAL '15 minutes'
      ORDER BY created_at`,
    [userId],
  );
  return result.rows;
}

export async function invalidateStaffEmailVerifications(client: PoolClient, userId: string) {
  const result = await client.query<{ id: string }>(
    `UPDATE staff_email_verifications
        SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
      WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING id::text`,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

export async function obsoleteStaffEmailVerificationMail(client: PoolClient, requestIds: string[]) {
  if (!requestIds.length) return;
  await client.query(
    `UPDATE email_outbox
        SET status='OBSOLETE',verification_body_encrypted=NULL,locked_at=NULL,
            last_attempt_at=clock_timestamp(),last_attempt_status='OBSOLETE'
      WHERE message_kind='STAFF_SECURITY'
        AND source_type='STAFF_EMAIL_VERIFICATION'
        AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')`,
    [requestIds],
  );
}

export async function insertStaffEmailVerification(
  client: PoolClient,
  input: { userId: string; email: string; tokenHash: string },
) {
  const result = await client.query<{ id: string; expiresAt: Date; resendAvailableAt: Date }>(
    `WITH timing AS (SELECT clock_timestamp() AS created_at)
     INSERT INTO staff_email_verifications (
       user_id,pending_email,token_hash,expires_at,created_at
     )
     SELECT $1,$2,$3,created_at+INTERVAL '30 minutes',created_at FROM timing
     RETURNING id::text,expires_at AS "expiresAt",
               created_at+INTERVAL '60 seconds' AS "resendAvailableAt"`,
    [input.userId, input.email, input.tokenHash],
  );
  return result.rows[0];
}

export async function insertStaffSecurityOutbox(
  client: PoolClient,
  input: {
    email: string;
    subject: string;
    notificationType: "STAFF_EMAIL_VERIFICATION" | "STAFF_PASSWORD_RESET";
    sourceId: string;
    encryptedBody: string;
  },
) {
  await client.query(
    `INSERT INTO email_outbox (
       student_number,to_email,subject,text_body,html_body,message_kind,
       notification_type,source_type,source_id,verification_body_encrypted
     ) VALUES (
       NULL,$1,$2,'Staff security email content is encrypted.',NULL,'STAFF_SECURITY',
       $3,$3,$4,$5
     )`,
    [input.email, input.subject, input.notificationType, input.sourceId, input.encryptedBody],
  );
}

export type StaffEmailVerificationConfirmationRow = StaffAccountRow & {
  requestId: string;
  pendingEmail: string;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  expired: boolean;
};

export async function findStaffEmailVerificationForUpdate(client: PoolClient, tokenHash: string) {
  const result = await client.query<StaffEmailVerificationConfirmationRow>(
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
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function markStaffEmailVerified(client: PoolClient, userId: string) {
  await client.query("UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1", [userId]);
}

export async function consumeStaffEmailVerification(client: PoolClient, requestId: string) {
  await client.query(
    "UPDATE staff_email_verifications SET consumed_at=clock_timestamp() WHERE id=$1",
    [requestId],
  );
}

export async function invalidateOtherStaffEmailVerifications(
  client: PoolClient,
  userId: string,
  requestId: string,
) {
  const result = await client.query<{ id: string }>(
    `UPDATE staff_email_verifications SET invalidated_at=clock_timestamp()
      WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING id::text`,
    [userId, requestId],
  );
  return result.rows.map((row) => row.id);
}

export async function findStaffVerificationTargetForUpdate(client: PoolClient, userId: string) {
  const result = await client.query<{ email: string; emailVerifiedAt: Date | null }>(
    `SELECT email,email_verified_at AS "emailVerifiedAt" FROM users
      WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function findEligibleStaffPasswordResetAccountForUpdate(client: PoolClient, email: string) {
  const result = await client.query<{ id: string; email: string }>(
    `SELECT id::text,email FROM users
      WHERE email=$1 AND deleted_at IS NULL AND email_verified_at IS NOT NULL
        AND must_change_password=FALSE FOR UPDATE`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function listRecentStaffPasswordResets(client: PoolClient, userId: string) {
  const result = await client.query<{ createdAt: Date; databaseNow: Date }>(
    `SELECT created_at AS "createdAt",clock_timestamp() AS "databaseNow"
       FROM staff_password_resets
      WHERE user_id=$1 AND created_at>clock_timestamp()-INTERVAL '15 minutes'
      ORDER BY created_at`,
    [userId],
  );
  return result.rows;
}

export async function invalidateActiveStaffPasswordResets(client: PoolClient, userId: string) {
  const result = await client.query<{ id: string }>(
    `UPDATE staff_password_resets SET invalidated_at=COALESCE(invalidated_at,clock_timestamp())
      WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL RETURNING id::text`,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

export async function insertStaffPasswordReset(client: PoolClient, userId: string, tokenHash: string) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO staff_password_resets (user_id,token_hash,expires_at)
     VALUES ($1,$2,clock_timestamp()+INTERVAL '30 minutes') RETURNING id::text`,
    [userId, tokenHash],
  );
  return result.rows[0];
}

export type StaffPasswordResetRow = {
  id: string;
  userId: string;
  email: string;
  role: string;
  storedPasswordHash: string;
  credentialVersion: number;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  expired: boolean;
};

export async function findStaffPasswordResetForUpdate(client: PoolClient, tokenHash: string) {
  const result = await client.query<StaffPasswordResetRow>(
    `SELECT reset.id::text,reset.user_id::text AS "userId",account.email,account.role,
            account.password_hash AS "storedPasswordHash",
            account.credential_version AS "credentialVersion",
            reset.consumed_at AS "consumedAt",reset.invalidated_at AS "invalidatedAt",
            reset.expires_at<=clock_timestamp() AS expired
       FROM staff_password_resets reset JOIN users account ON account.id=reset.user_id
      WHERE reset.token_hash=$1 AND account.deleted_at IS NULL
        AND account.email_verified_at IS NOT NULL AND account.must_change_password=FALSE
      FOR UPDATE OF reset,account`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function updateStaffPasswordFromReset(
  client: PoolClient,
  userId: string,
  passwordHash: string,
) {
  const result = await client.query<{ credentialVersion: number }>(
    `UPDATE users SET password_hash=$2,credential_version=credential_version+1
      WHERE id=$1 RETURNING credential_version AS "credentialVersion"`,
    [userId, passwordHash],
  );
  return result.rows[0].credentialVersion;
}

export async function consumeStaffPasswordReset(client: PoolClient, requestId: string) {
  await client.query("UPDATE staff_password_resets SET consumed_at=clock_timestamp() WHERE id=$1", [requestId]);
}

export async function invalidateOtherStaffPasswordResets(
  client: PoolClient,
  userId: string,
  requestId: string,
) {
  const result = await client.query<{ id: string }>(
    `UPDATE staff_password_resets SET invalidated_at=clock_timestamp()
      WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING id::text`,
    [userId, requestId],
  );
  return result.rows.map((row) => row.id);
}

export async function insertStaffUser(
  client: PoolClient,
  input: {
    fullName: string;
    email: string;
    passwordHash: string;
    role: "ADMIN" | "COORDINATOR" | "CLINIC_STAFF";
    clinicCode: string | null;
  },
) {
  const result = await client.query<StaffAccountRow>(
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
    [input.fullName, input.email, input.passwordHash, input.role, input.clinicCode],
  );
  return result.rows[0];
}

export async function findClinicName(client: PoolClient, clinicId: string | null) {
  if (!clinicId) return null;
  const result = await client.query<{ name: string }>("SELECT name FROM clinics WHERE id=$1", [clinicId]);
  return result.rows[0]?.name ?? null;
}

export async function listActiveStaffAccounts() {
  const result = await query<StaffAccountRow & { createdAt: Date }>(
    `SELECT ${staffAccountColumns},account.created_at AS "createdAt"
       FROM users account LEFT JOIN clinics clinic ON clinic.id=account.clinic_id
      WHERE account.deleted_at IS NULL ORDER BY account.full_name,account.id`,
  );
  return result.rows;
}

export async function obsoleteStaffSecurityMailForUser(
  client: PoolClient,
  userId: string,
  sourceTypes: Array<"STAFF_EMAIL_VERIFICATION" | "STAFF_PASSWORD_RESET">,
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

export async function updateStaffEmail(client: PoolClient, userId: string, email: string) {
  const result = await client.query<StaffAccountRow>(
    `UPDATE users SET email=$2,email_verified_at=NULL,
                      credential_version=credential_version+1
      WHERE id=$1
      RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
                NULL::text AS "clinicCode",NULL::text AS "clinicName",
                email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
                credential_version AS "credentialVersion"`,
    [userId, email],
  );
  return result.rows[0];
}

export async function updateStaffTemporaryPassword(
  client: PoolClient,
  userId: string,
  passwordHash: string,
) {
  const result = await client.query<StaffAccountRow>(
    `UPDATE users SET password_hash=$2,must_change_password=TRUE,
                      credential_version=credential_version+1 WHERE id=$1
     RETURNING id::text,full_name AS "fullName",email,role,clinic_id AS "clinicId",
               NULL::text AS "clinicCode",NULL::text AS "clinicName",
               email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
               credential_version AS "credentialVersion"`,
    [userId, passwordHash],
  );
  return result.rows[0];
}

export async function countNonDeletedAdministrators(client: PoolClient) {
  const result = await client.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND deleted_at IS NULL",
  );
  return result.rows[0].count;
}

export async function tombstoneStaffUser(client: PoolClient, userId: string, deletedBy: string) {
  await client.query(
    `UPDATE users SET credential_version=credential_version+1,email=NULL,password_hash=NULL,
            email_verified_at=NULL,must_change_password=FALSE,deleted_at=clock_timestamp(),deleted_by=$2
      WHERE id=$1`,
    [userId, deletedBy],
  );
}
