import "server-only";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "@/server/db/pool";

export type EmailOutboxMessageKind = "SCHEDULE" | "VERIFICATION";

export type ClaimedEmailOutboxMessage = {
  id: string;
  studentNumber: string | null;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  messageKind: EmailOutboxMessageKind;
  verificationBodyEncrypted: string | null;
  attempts: number;
};

type EmailOutboxAuditRow = {
  id: string;
  studentNumber: string | null;
  toEmail: string;
  messageKind: EmailOutboxMessageKind;
  notificationType: string | null;
  sourceType: string | null;
  sourceId: string | null;
};

function destinationHash(toEmail: string) {
  return createHash("sha256").update(toEmail.trim().toLowerCase()).digest("hex");
}

async function writeLifecycleAudit(
  client: PoolClient,
  row: EmailOutboxAuditRow,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES (NULL,$1,'email_outbox',$2,$3::jsonb)`,
    [
      action,
      row.id,
      JSON.stringify({
        messageKind: row.messageKind,
        studentNumber: row.studentNumber,
        notificationType: row.notificationType,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        destinationHash: destinationHash(row.toEmail),
        ...metadata,
      }),
    ],
  );
}

export async function claimEmailOutboxRows(limit: number, now: Date) {
  return transaction(async (client) => {
    const result = await client.query<ClaimedEmailOutboxMessage>(
      `WITH candidates AS (
         SELECT id
           FROM email_outbox
          WHERE attempts < 10 AND next_attempt_at <= $2
            AND (
              status='PENDING'
              OR (status='PROCESSING' AND locked_at <= $2 - INTERVAL '5 minutes')
            )
          ORDER BY next_attempt_at, created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox outbox
          SET status='PROCESSING', locked_at=$2
         FROM candidates
        WHERE outbox.id=candidates.id
       RETURNING outbox.id, outbox.student_number AS "studentNumber",
                 outbox.to_email AS "toEmail", outbox.subject,
                 outbox.text_body AS "textBody", outbox.html_body AS "htmlBody",
                 outbox.message_kind AS "messageKind",
                 outbox.verification_body_encrypted AS "verificationBodyEncrypted",
                 outbox.attempts`,
      [limit, now],
    );
    return result.rows;
  });
}

export async function markEmailOutboxSentWithClient(
  client: PoolClient,
  id: string,
  attempts: number,
  now: Date,
) {
  const result = await client.query<EmailOutboxAuditRow>(
    `UPDATE email_outbox
        SET status='SENT',attempts=$2,sent_at=$3,locked_at=NULL,last_error=NULL,
            verification_body_encrypted=NULL,last_attempt_at=$3,last_attempt_status='SENT'
      WHERE id=$1 AND status='PROCESSING'
      RETURNING id,student_number AS "studentNumber",to_email AS "toEmail",
                message_kind AS "messageKind",notification_type AS "notificationType",
                source_type AS "sourceType",source_id AS "sourceId"`,
    [id, attempts, now],
  );
  if (result.rows[0]) {
    await writeLifecycleAudit(client, result.rows[0], "EMAIL_OUTBOX_DELIVERED", { attempts });
  }
}

export async function markEmailOutboxSent(id: string, attempts: number, now: Date) {
  await transaction(async (client) => {
    await markEmailOutboxSentWithClient(client, id, attempts, now);
  });
}

export async function markEmailOutboxFailedWithClient(
  client: PoolClient,
  id: string,
  attempts: number,
  nextAttemptAt: Date,
  error: string,
  now: Date,
) {
  const result = await client.query<EmailOutboxAuditRow & { status: "PENDING" | "PERMANENT_FAILURE" }>(
    `UPDATE email_outbox
        SET status=CASE WHEN $2 >= 10 THEN 'PERMANENT_FAILURE' ELSE 'PENDING' END,
            attempts=$2,next_attempt_at=$3,locked_at=NULL,last_error=$4,
            last_attempt_at=$5,
            last_attempt_status=CASE WHEN $2 >= 10 THEN 'PERMANENT_FAILURE' ELSE 'PENDING' END
      WHERE id=$1 AND status='PROCESSING'
      RETURNING id,student_number AS "studentNumber",to_email AS "toEmail",
                message_kind AS "messageKind",notification_type AS "notificationType",
                source_type AS "sourceType",source_id AS "sourceId",status`,
    [id, attempts, nextAttemptAt, error.slice(0, 2000), now],
  );
  const row = result.rows[0];
  if (row) {
    await writeLifecycleAudit(
      client,
      row,
      row.status === "PERMANENT_FAILURE"
        ? "EMAIL_OUTBOX_PERMANENT_FAILURE"
        : "EMAIL_OUTBOX_RETRY_SCHEDULED",
      { attempts, ...(row.status === "PENDING" ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}) },
    );
  }
}

export async function markEmailOutboxFailed(
  id: string,
  attempts: number,
  nextAttemptAt: Date,
  error: string,
  now: Date,
) {
  await transaction(async (client) => {
    await markEmailOutboxFailedWithClient(client, id, attempts, nextAttemptAt, error, now);
  });
}

export type EmailOutboxObsoleteReason = "EXPIRED" | "SUPERSEDED" | "VERIFIED_ADDRESS_CHANGED";

export async function markEmailOutboxObsoleteWithClient(
  client: PoolClient,
  id: string,
  reason: EmailOutboxObsoleteReason,
  now: Date,
) {
  const result = await client.query<EmailOutboxAuditRow>(
    `UPDATE email_outbox
        SET status='OBSOLETE',locked_at=NULL,last_error=NULL,
            verification_body_encrypted=NULL,last_attempt_at=$2,
            last_attempt_status='OBSOLETE'
      WHERE id=$1 AND status NOT IN ('SENT','OBSOLETE')
      RETURNING id,student_number AS "studentNumber",to_email AS "toEmail",
                message_kind AS "messageKind",notification_type AS "notificationType",
                source_type AS "sourceType",source_id AS "sourceId"`,
    [id, now],
  );
  const row = result.rows[0];
  if (!row) return false;
  await writeLifecycleAudit(client, row, "EMAIL_OUTBOX_OBSOLETE", { reason });
  return true;
}

export async function markEmailOutboxObsolete(
  id: string,
  reason: EmailOutboxObsoleteReason,
  now: Date,
) {
  return transaction(async (client) => {
    return markEmailOutboxObsoleteWithClient(client, id, reason, now);
  });
}

export async function authorizeScheduleEmailOutboxDelivery(
  client: PoolClient,
  message: Pick<ClaimedEmailOutboxMessage, "id" | "studentNumber">,
  now: Date,
) {
  const student = message.studentNumber
    ? await client.query<{ verifiedEmail: string | null }>(
        `SELECT CASE WHEN is_active=TRUE AND email_verified_at IS NOT NULL
                     THEN LOWER(BTRIM(email)) ELSE NULL END AS "verifiedEmail"
           FROM students WHERE student_number=$1
           FOR NO KEY UPDATE`,
        [message.studentNumber],
      )
    : null;
  const outbox = await client.query<{
    status: string;
    messageKind: EmailOutboxMessageKind;
    studentNumber: string | null;
    toEmail: string;
  }>(
    `SELECT status,message_kind AS "messageKind",student_number AS "studentNumber",
            to_email AS "toEmail"
       FROM email_outbox WHERE id=$1
       FOR UPDATE`,
    [message.id],
  );
  const row = outbox.rows[0];
  if (!row || row.status !== "PROCESSING" || row.messageKind !== "SCHEDULE") return "SKIPPED" as const;
  const verifiedEmail = student?.rows[0]?.verifiedEmail ?? null;
  if (
    !message.studentNumber
    || row.studentNumber !== message.studentNumber
    || !verifiedEmail
    || row.toEmail.trim().toLowerCase() !== verifiedEmail
  ) {
    await markEmailOutboxObsoleteWithClient(client, message.id, "VERIFIED_ADDRESS_CHANGED", now);
    return "OBSOLETE" as const;
  }
  return "AUTHORIZED" as const;
}
