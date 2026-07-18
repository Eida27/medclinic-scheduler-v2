import "server-only";
import { query, transaction } from "@/server/db/pool";

export type ClaimedEmailOutboxMessage = {
  id: string;
  studentNumber: string | null;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  attempts: number;
};

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
                 outbox.attempts`,
      [limit, now],
    );
    return result.rows;
  });
}

export async function markEmailOutboxSent(id: string, attempts: number, now: Date) {
  await query(
    `UPDATE email_outbox
        SET status='SENT', attempts=$2, sent_at=$3, locked_at=NULL,
            last_error=NULL
      WHERE id=$1 AND status='PROCESSING'`,
    [id, attempts, now],
  );
}

export async function markEmailOutboxFailed(
  id: string,
  attempts: number,
  nextAttemptAt: Date,
  error: string,
) {
  await query(
    `UPDATE email_outbox
        SET status=CASE WHEN $2 >= 10 THEN 'PERMANENT_FAILURE' ELSE 'PENDING' END,
            attempts=$2, next_attempt_at=$3, locked_at=NULL, last_error=$4
      WHERE id=$1 AND status='PROCESSING'`,
    [id, attempts, nextAttemptAt, error.slice(0, 2000)],
  );
}
