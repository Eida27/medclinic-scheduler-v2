import "server-only";
import type { PoolClient } from "pg";
import {
  enqueueStudentEmail,
  insertStudentNotification,
  listStudentNotificationRows,
  markStudentNotificationReadRow,
  type StudentNotificationInput,
} from "@/server/repositories/student-notifications.repository";

export async function createStudentNotification(
  client: PoolClient,
  input: StudentNotificationInput,
) {
  const inserted = await insertStudentNotification(client, input);
  if (inserted.email) {
    await enqueueStudentEmail(client, {
      studentNumber: input.studentNumber,
      toEmail: inserted.email,
      subject: input.title,
      textBody: `${input.message}\n\nOpen the student portal to review the details.`,
    });
  }
  return inserted.id;
}

export async function listStudentNotifications(studentNumber: string) {
  const items = await listStudentNotificationRows(studentNumber);
  return { items, unreadCount: items.filter((item) => !item.readAt).length };
}

export function markStudentNotificationRead(studentNumber: string, notificationId: string) {
  return markStudentNotificationReadRow(studentNumber, notificationId);
}
