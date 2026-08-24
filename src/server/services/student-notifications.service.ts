import "server-only";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  enqueueStudentEmail,
  insertStudentNotification,
  insertStudentNotifications,
  listStudentNotificationRows,
  markStudentNotificationReadRow,
  type StudentNotificationInput,
} from "@/server/repositories/student-notifications.repository";

export function createStudentNotifications(
  client: PoolClient,
  inputs: StudentNotificationInput[],
) {
  return insertStudentNotifications(client, inputs);
}

export async function createStudentNotification(
  client: PoolClient,
  input: StudentNotificationInput,
) {
  const inserted = await insertStudentNotification(client, input);
  if (!inserted) return null;
  if (inserted.email) {
    await enqueueStudentEmail(client, {
      studentNumber: input.studentNumber,
      toEmail: inserted.email,
      subject: input.emailSubject ?? input.title,
      textBody: input.emailTextBody ?? `${input.message}\n\nOpen the student portal to review the details.`,
      eventKey: input.eventKey,
      messageKind: input.messageKind,
      notificationType: input.notificationType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      portalNotificationId: inserted.id,
      scheduleFingerprint: input.scheduleFingerprint,
    });
  }
  return inserted.id;
}

export type StudentNotificationWriteWarning = {
  channel: "PORTAL" | "EMAIL_OUTBOX";
};

function auditHash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

async function writeNotificationWarningAudit(
  client: PoolClient,
  input: StudentNotificationInput,
  channel: StudentNotificationWriteWarning["channel"],
  portalNotificationId: string | null,
) {
  const metadata = {
    channel,
    studentHash: auditHash(input.studentNumber),
    notificationType: input.notificationType,
    messageKind: input.messageKind ?? "GENERAL",
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    ...(input.sourceId ? { sourceIdHash: auditHash(input.sourceId) } : {}),
    ...(input.eventKey ? { eventKeyHash: auditHash(input.eventKey) } : {}),
  };
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES (NULL,'STUDENT_NOTIFICATION_ENQUEUE_WARNING','student_notification',$1,$2::jsonb)`,
    [portalNotificationId, JSON.stringify(metadata)],
  );
}

export async function createStudentNotificationIsolated(
  client: PoolClient,
  input: StudentNotificationInput,
): Promise<{ id: string | null; warnings: StudentNotificationWriteWarning[] }> {
  const warnings: StudentNotificationWriteWarning[] = [];
  await client.query("SAVEPOINT student_notification_portal");
  let inserted: Awaited<ReturnType<typeof insertStudentNotification>> | null = null;
  try {
    inserted = await insertStudentNotification(client, input) ?? null;
    await client.query("RELEASE SAVEPOINT student_notification_portal");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT student_notification_portal");
    await client.query("RELEASE SAVEPOINT student_notification_portal");
    warnings.push({ channel: "PORTAL" });
    await writeNotificationWarningAudit(client, input, "PORTAL", null);
    return { id: null, warnings };
  }

  if (inserted?.email) {
    await client.query("SAVEPOINT student_notification_email");
    try {
      await enqueueStudentEmail(client, {
        studentNumber: input.studentNumber,
        toEmail: inserted.email,
        subject: input.emailSubject ?? input.title,
        textBody: input.emailTextBody ?? `${input.message}\n\nOpen the student portal to review the details.`,
        eventKey: input.eventKey,
        messageKind: input.messageKind,
        notificationType: input.notificationType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        portalNotificationId: inserted.id,
        scheduleFingerprint: input.scheduleFingerprint,
      });
      await client.query("RELEASE SAVEPOINT student_notification_email");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT student_notification_email");
      await client.query("RELEASE SAVEPOINT student_notification_email");
      warnings.push({ channel: "EMAIL_OUTBOX" });
      await writeNotificationWarningAudit(client, input, "EMAIL_OUTBOX", inserted.id);
    }
  }

  return { id: inserted?.id ?? null, warnings };
}

export async function listStudentNotifications(studentNumber: string) {
  const items = await listStudentNotificationRows(studentNumber);
  return { items, unreadCount: items.filter((item) => !item.readAt).length };
}

export function markStudentNotificationRead(studentNumber: string, notificationId: string) {
  return markStudentNotificationReadRow(studentNumber, notificationId);
}
