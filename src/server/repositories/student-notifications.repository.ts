import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export type StudentNotificationInput = {
  studentNumber: string;
  notificationType: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export async function insertStudentNotification(
  client: PoolClient,
  input: StudentNotificationInput,
) {
  const result = await client.query<{ id: string; email: string | null }>(
    `WITH inserted AS (
       INSERT INTO student_portal_notifications (
         student_number, notification_type, title, message, metadata
       ) VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING id, student_number
     )
     SELECT inserted.id,
            CASE WHEN student.email_verified_at IS NOT NULL THEN student.email ELSE NULL END AS email
       FROM inserted
       JOIN students student ON student.student_number=inserted.student_number`,
    [
      input.studentNumber,
      input.notificationType,
      input.title,
      input.message,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function enqueueStudentEmail(
  client: PoolClient,
  input: {
    studentNumber: string;
    toEmail: string;
    subject: string;
    textBody: string;
    htmlBody?: string | null;
  },
) {
  await client.query(
    `INSERT INTO email_outbox (
       student_number, to_email, subject, text_body, html_body
     ) VALUES ($1,$2,$3,$4,$5)`,
    [input.studentNumber, input.toEmail, input.subject, input.textBody, input.htmlBody ?? null],
  );
}

export async function listStudentNotificationRows(studentNumber: string) {
  const result = await query<{
    id: string;
    notificationType: string;
    title: string;
    message: string;
    metadata: Record<string, unknown>;
    readAt: Date | null;
    createdAt: Date;
  }>(
    `SELECT id, notification_type AS "notificationType", title, message, metadata,
            read_at AS "readAt", created_at AS "createdAt"
       FROM student_portal_notifications
      WHERE student_number=$1
      ORDER BY created_at DESC, id DESC`,
    [studentNumber],
  );
  return result.rows;
}

export async function markStudentNotificationReadRow(studentNumber: string, notificationId: string) {
  const result = await query(
    `UPDATE student_portal_notifications
        SET read_at=COALESCE(read_at,NOW())
      WHERE id=$1 AND student_number=$2
      RETURNING id`,
    [notificationId, studentNumber],
  );
  return Boolean(result.rowCount);
}
