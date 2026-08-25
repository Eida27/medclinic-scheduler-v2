import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
import type { EmailOutboxMessageKind } from "./email-outbox.repository";

export type EmailDeliveryDatabaseStatus =
  | "PENDING"
  | "PROCESSING"
  | "SENT"
  | "PERMANENT_FAILURE"
  | "OBSOLETE";
export type EmailDeliveryState = "Pending" | "Sent" | "Retrying" | "Failed";

export type AdminEmailDeliveryRow = {
  id: string;
  studentNumber: string | null;
  toEmail: string;
  status: EmailDeliveryDatabaseStatus;
  attempts: number;
  lastAttemptAt: Date | null;
  lastAttemptStatus: EmailDeliveryDatabaseStatus | null;
  lastError: string | null;
  messageKind: EmailOutboxMessageKind;
  notificationType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  scheduleFingerprint: string | null;
};

export type LockedAdminEmailDeliveryRow = AdminEmailDeliveryRow;

export type AdminEmailDeliveryIdentity = Pick<
  AdminEmailDeliveryRow,
  "id" | "studentNumber" | "messageKind" | "sourceType" | "sourceId"
>;

export type AdminEmailDelivery = ReturnType<typeof mapAdminEmailDeliveryRow>;

export function maskEmailDestination(destination: string) {
  const separator = destination.indexOf("@");
  if (separator < 1 || separator === destination.length - 1) return "***";
  return `${destination.slice(0, 1)}***${destination.slice(separator)}`;
}

export function sanitizeEmailDeliveryFailure(failure: string | null) {
  if (!failure) return null;
  if (/auth|credential|password|535/i.test(failure)) return "Email service authentication failed.";
  if (/timeout|timedout|etimedout/i.test(failure)) return "Email service timed out.";
  if (/quota|rate|limit|throttl/i.test(failure)) return "Email service temporarily limited.";
  if (/connect|socket|dns|enotfound|econn/i.test(failure)) return "Email service connection failed.";
  return "Email delivery failed.";
}

function mapState(status: EmailDeliveryDatabaseStatus, attempts: number): EmailDeliveryState {
  if (status === "SENT") return "Sent";
  if (status === "PERMANENT_FAILURE" || status === "OBSOLETE") return "Failed";
  if (status === "PROCESSING" || attempts > 0) return "Retrying";
  return "Pending";
}

function safeSourceId(row: AdminEmailDeliveryRow) {
  if (row.sourceType === "CURRENT_SCHEDULE_STATE") return null;
  if (row.sourceId && /^[0-9a-f]{64}$/i.test(row.sourceId)) return null;
  return row.sourceId;
}

export function mapAdminEmailDeliveryRow(row: AdminEmailDeliveryRow) {
  const state = mapState(row.status, row.attempts);
  return {
    id: row.id,
    destination: maskEmailDestination(row.toEmail),
    state,
    attempts: row.attempts,
    lastAttempt: row.lastAttemptAt
      ? {
          at: row.lastAttemptAt.toISOString(),
          state: mapState(row.lastAttemptStatus ?? row.status, row.attempts),
        }
      : null,
    context: {
      studentNumber: row.studentNumber,
      messageKind: row.messageKind,
      notificationType: row.notificationType,
      sourceType: row.sourceType,
      sourceId: safeSourceId(row),
    },
    failureReason: state === "Failed" ? sanitizeEmailDeliveryFailure(row.lastError) : null,
    actionable: row.status === "PERMANENT_FAILURE",
  };
}

const deliveryColumns = `outbox.id::text,outbox.student_number AS "studentNumber",
  outbox.to_email AS "toEmail",outbox.status,outbox.attempts,
  outbox.last_attempt_at AS "lastAttemptAt",
  outbox.last_attempt_status AS "lastAttemptStatus",outbox.last_error AS "lastError",
  outbox.message_kind AS "messageKind",outbox.notification_type AS "notificationType",
  outbox.source_type AS "sourceType",outbox.source_id AS "sourceId",
  outbox.schedule_fingerprint AS "scheduleFingerprint"`;

export async function listAdminEmailDeliveryRows(filters: {
  scope: "actionable" | "history";
  state?: EmailDeliveryState;
}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters.scope === "actionable") conditions.push("outbox.status='PERMANENT_FAILURE'");
  if (filters.state) {
    values.push(filters.state);
    conditions.push(`CASE
      WHEN outbox.status='SENT' THEN 'Sent'
      WHEN outbox.status IN ('PERMANENT_FAILURE','OBSOLETE') THEN 'Failed'
      WHEN outbox.status='PROCESSING' OR outbox.attempts>0 THEN 'Retrying'
      ELSE 'Pending' END=$${values.length}`);
  }
  const result = await query<AdminEmailDeliveryRow>(
    `SELECT ${deliveryColumns}
       FROM email_outbox outbox
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY outbox.created_at DESC,outbox.id DESC
      LIMIT 100`,
    values,
  );
  return result.rows;
}

export async function readAdminEmailDeliveryIdentity(client: PoolClient, id: string) {
  const result = await client.query<AdminEmailDeliveryIdentity>(
    `SELECT id::text,student_number AS "studentNumber",message_kind AS "messageKind",
            source_type AS "sourceType",source_id AS "sourceId"
       FROM email_outbox WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function lockAdminEmailDeliveryStudent(
  client: PoolClient,
  studentNumber: string,
  mode: "UPDATE" | "NO KEY UPDATE",
) {
  const result = await client.query<{
    isActive: boolean;
    verifiedEmail: string | null;
  }>(
    `SELECT is_active AS "isActive",
            CASE WHEN is_active=TRUE AND email_verified_at IS NOT NULL
                 THEN LOWER(BTRIM(email)) ELSE NULL END AS "verifiedEmail"
       FROM students WHERE student_number=$1
       FOR ${mode}`,
    [studentNumber],
  );
  return result.rows[0] ?? null;
}

export async function lockAdminEmailVerificationRequest(client: PoolClient, sourceId: string | null) {
  if (!sourceId) return null;
  const result = await client.query<{
    retryEligible: boolean;
    obsoleteReason: "CONSUMED" | "EXPIRED" | "SUPERSEDED" | null;
  }>(
    `SELECT verification.consumed_at IS NULL
              AND verification.expires_at>clock_timestamp() AS "retryEligible",
            CASE
              WHEN verification.consumed_at IS NULL
                AND verification.expires_at>clock_timestamp() THEN NULL
              WHEN verification.expires_at<=clock_timestamp() THEN 'EXPIRED'
              WHEN student.is_active=TRUE AND student.email_verified_at IS NOT NULL
                AND LOWER(BTRIM(student.email))=LOWER(BTRIM(verification.pending_email))
                THEN 'CONSUMED'
              ELSE 'SUPERSEDED'
            END AS "obsoleteReason"
       FROM student_email_verifications verification
       JOIN students student ON student.student_number=verification.student_number
      WHERE verification.id::text=$1
      FOR UPDATE OF verification`,
    [sourceId],
  );
  return result.rows[0] ?? null;
}

export async function lockAdminStaffSecurityRequest(
  client: PoolClient,
  input: {
    sourceType: string | null;
    sourceId: string | null;
    toEmail: string;
  },
) {
  if (!input.sourceId) return null;
  if (input.sourceType === "STAFF_EMAIL_VERIFICATION") {
    const result = await client.query<{
      retryEligible: boolean;
      obsoleteReason: "CONSUMED" | "EXPIRED" | "ACCOUNT_STATE_CHANGED" | null;
    }>(
      `SELECT verification.consumed_at IS NULL
                AND verification.invalidated_at IS NULL
                AND verification.expires_at>clock_timestamp()
                AND account.deleted_at IS NULL
                AND LOWER(BTRIM(account.email))=LOWER(BTRIM(verification.pending_email))
                AND LOWER(BTRIM(verification.pending_email))=LOWER(BTRIM($2))
                AS "retryEligible",
              CASE
                WHEN verification.expires_at<=clock_timestamp() THEN 'EXPIRED'
                WHEN verification.consumed_at IS NOT NULL THEN 'CONSUMED'
                WHEN verification.invalidated_at IS NOT NULL OR account.deleted_at IS NOT NULL
                  OR LOWER(BTRIM(account.email))<>LOWER(BTRIM(verification.pending_email))
                  OR LOWER(BTRIM(verification.pending_email))<>LOWER(BTRIM($2))
                  THEN 'ACCOUNT_STATE_CHANGED'
                ELSE NULL
              END AS "obsoleteReason"
         FROM staff_email_verifications verification
         JOIN users account ON account.id=verification.user_id
        WHERE verification.id::text=$1
        FOR UPDATE OF verification,account`,
      [input.sourceId, input.toEmail],
    );
    return result.rows[0] ?? null;
  }
  if (input.sourceType === "STAFF_PASSWORD_RESET") {
    const result = await client.query<{
      retryEligible: boolean;
      obsoleteReason: "CONSUMED" | "EXPIRED" | "ACCOUNT_STATE_CHANGED" | null;
    }>(
      `SELECT reset.consumed_at IS NULL
                AND reset.invalidated_at IS NULL
                AND reset.expires_at>clock_timestamp()
                AND account.deleted_at IS NULL
                AND account.email_verified_at IS NOT NULL
                AND account.must_change_password=FALSE
                AND LOWER(BTRIM(account.email))=LOWER(BTRIM($2))
                AS "retryEligible",
              CASE
                WHEN reset.expires_at<=clock_timestamp() THEN 'EXPIRED'
                WHEN reset.consumed_at IS NOT NULL THEN 'CONSUMED'
                WHEN reset.invalidated_at IS NOT NULL OR account.deleted_at IS NOT NULL
                  OR account.email_verified_at IS NULL OR account.must_change_password=TRUE
                  OR LOWER(BTRIM(account.email))<>LOWER(BTRIM($2))
                  THEN 'ACCOUNT_STATE_CHANGED'
                ELSE NULL
              END AS "obsoleteReason"
         FROM staff_password_resets reset
         JOIN users account ON account.id=reset.user_id
        WHERE reset.id::text=$1
        FOR UPDATE OF reset,account`,
      [input.sourceId, input.toEmail],
    );
    return result.rows[0] ?? null;
  }
  return null;
}

export async function lockAdminScheduleStateRows(client: PoolClient, studentNumber: string) {
  await client.query(
    `SELECT id FROM clinic_closure_manual_cases
      WHERE student_number=$1
      ORDER BY id
      FOR UPDATE`,
    [studentNumber],
  );
  await client.query(
    `SELECT id FROM appointments
      WHERE student_number=$1
      ORDER BY id
      FOR UPDATE`,
    [studentNumber],
  );
}

export async function lockAdminScheduleMutationQueue(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
}

export async function lockAdminEmailDeliveryRow(client: PoolClient, id: string) {
  const result = await client.query<LockedAdminEmailDeliveryRow>(
    `SELECT ${deliveryColumns}
       FROM email_outbox outbox
      WHERE outbox.id=$1
      FOR UPDATE OF outbox`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function resetAdminEmailDeliveryFailure(client: PoolClient, id: string) {
  const result = await client.query<AdminEmailDeliveryRow>(
    `UPDATE email_outbox outbox
        SET status='PENDING',attempts=0,next_attempt_at=clock_timestamp(),locked_at=NULL,last_error=NULL
      WHERE outbox.id=$1 AND outbox.status='PERMANENT_FAILURE'
      RETURNING ${deliveryColumns}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function obsoleteAdminEmailDeliveryFailure(client: PoolClient, id: string) {
  const result = await client.query(
    `UPDATE email_outbox
        SET status='OBSOLETE',locked_at=NULL,last_error=NULL,last_attempt_at=clock_timestamp(),
            last_attempt_status='OBSOLETE',verification_body_encrypted=NULL
      WHERE id=$1 AND status='PERMANENT_FAILURE'`,
    [id],
  );
  return Boolean(result.rowCount);
}
