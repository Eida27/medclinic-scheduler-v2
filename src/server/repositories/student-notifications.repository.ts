import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export type StudentNotificationInput = {
  studentNumber: string;
  notificationType: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  eventKey?: string;
};

export async function insertStudentNotifications(
  client: PoolClient,
  inputs: StudentNotificationInput[],
) {
  if (!inputs.length) return [];
  const result = await client.query<{ id: string }>(
    `WITH source AS MATERIALIZED (
       SELECT row.student_number,row.notification_type,row.title,row.message,
              row.metadata,row.event_key
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number text,notification_type text,title text,message text,
           metadata jsonb,event_key text
         )
     ),
     inserted AS (
       INSERT INTO student_portal_notifications (
         student_number,notification_type,title,message,metadata,event_key
       )
       SELECT student_number,notification_type,title,message,metadata,event_key
         FROM source
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
       RETURNING id,student_number,notification_type,title,message,event_key
     ),
     enqueued AS (
       INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,html_body,event_key,
         message_kind,notification_type,portal_notification_id
       )
       SELECT inserted.student_number,student.email,inserted.title,
              inserted.message || E'\\n\\nOpen the student portal to review the details.',
              NULL,inserted.event_key,'SCHEDULE',inserted.notification_type,inserted.id
         FROM inserted
         JOIN students student ON student.student_number=inserted.student_number
        WHERE student.email_verified_at IS NOT NULL AND student.email IS NOT NULL
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
       RETURNING id,student_number,to_email,message_kind,notification_type
     ),
     audited AS (
       INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       SELECT NULL,'EMAIL_OUTBOX_QUEUED','email_outbox',enqueued.id::text,
              jsonb_build_object(
                'studentNumber',enqueued.student_number,
                'messageKind',enqueued.message_kind,
                'notificationType',enqueued.notification_type,
                'destinationHash',encode(digest(LOWER(BTRIM(enqueued.to_email)),'sha256'),'hex')
              )
         FROM enqueued
     )
     SELECT id::text FROM inserted`,
    [JSON.stringify(inputs.map((input) => ({
      student_number: input.studentNumber,
      notification_type: input.notificationType,
      title: input.title,
      message: input.message,
      metadata: input.metadata ?? {},
      event_key: input.eventKey ?? null,
    })))],
  );
  return result.rows.map((row) => row.id);
}

export async function insertStudentNotification(
  client: PoolClient,
  input: StudentNotificationInput,
) {
  const result = await client.query<{ id: string; email: string | null }>(
    `WITH inserted AS (
       INSERT INTO student_portal_notifications (
         student_number, notification_type, title, message, metadata, event_key
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
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
      input.eventKey ?? null,
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
    eventKey?: string;
    messageKind?: "SCHEDULE" | "VERIFICATION";
    notificationType?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    portalNotificationId?: string | null;
    scheduleFingerprint?: string | null;
    verificationBodyEncrypted?: string | null;
  },
) {
  const result = await client.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,html_body,event_key,
         message_kind,notification_type,source_type,source_id,
         portal_notification_id,schedule_fingerprint,verification_body_encrypted
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
       RETURNING id,student_number,to_email,message_kind,notification_type,source_type,source_id
     ),
     audited AS (
       INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       SELECT NULL,'EMAIL_OUTBOX_QUEUED','email_outbox',inserted.id::text,
              jsonb_strip_nulls(jsonb_build_object(
                'studentNumber',inserted.student_number,
                'messageKind',inserted.message_kind,
                'notificationType',inserted.notification_type,
                'sourceType',inserted.source_type,
                'sourceId',inserted.source_id,
                'destinationHash',encode(digest(LOWER(BTRIM(inserted.to_email)),'sha256'),'hex')
              ))
         FROM inserted
     )
     SELECT id::text FROM inserted`,
    [
      input.studentNumber,
      input.toEmail,
      input.subject,
      input.textBody,
      input.htmlBody ?? null,
      input.eventKey ?? null,
      input.messageKind ?? "SCHEDULE",
      input.notificationType ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.portalNotificationId ?? null,
      input.scheduleFingerprint ?? null,
      input.verificationBodyEncrypted ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
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
