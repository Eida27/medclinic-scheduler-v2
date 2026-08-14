import "server-only";
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
      subject: input.title,
      textBody: `${input.message}\n\nOpen the student portal to review the details.`,
      eventKey: input.eventKey,
    });
  }
  return inserted.id;
}

export type StudentNotificationWriteWarning = {
  channel: "PORTAL" | "EMAIL_OUTBOX";
};

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
    return { id: null, warnings };
  }

  if (inserted?.email) {
    await client.query("SAVEPOINT student_notification_email");
    try {
      await enqueueStudentEmail(client, {
        studentNumber: input.studentNumber,
        toEmail: inserted.email,
        subject: input.title,
        textBody: `${input.message}\n\nOpen the student portal to review the details.`,
        eventKey: input.eventKey,
      });
      await client.query("RELEASE SAVEPOINT student_notification_email");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT student_notification_email");
      await client.query("RELEASE SAVEPOINT student_notification_email");
      warnings.push({ channel: "EMAIL_OUTBOX" });
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
