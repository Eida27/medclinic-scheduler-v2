import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertStudentNotification, enqueueStudentEmail } = vi.hoisted(() => ({
  insertStudentNotification: vi.fn(),
  enqueueStudentEmail: vi.fn(),
}));
vi.mock("@/server/repositories/student-notifications.repository", () => ({
  insertStudentNotification,
  enqueueStudentEmail,
  insertStudentNotifications: vi.fn(),
  listStudentNotificationRows: vi.fn(),
  markStudentNotificationReadRow: vi.fn(),
}));

import { createStudentNotificationIsolated } from "./student-notifications.service";

const input = {
  studentNumber: "24-0001",
  notificationType: "CLINIC_CLOSURE_RESCHEDULED",
  title: "Schedule updated",
  message: "Review the replacement schedule.",
  eventKey: "closure-warning-test",
};

describe("isolated student notification writes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recovers a portal write failure at its savepoint", async () => {
    const query = vi.fn().mockResolvedValue({});
    insertStudentNotification.mockRejectedValueOnce(new Error("portal insert failed"));

    await expect(createStudentNotificationIsolated({ query } as never, input)).resolves.toEqual({
      id: null,
      warnings: [{ channel: "PORTAL" }],
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SAVEPOINT student_notification_portal",
      "ROLLBACK TO SAVEPOINT student_notification_portal",
      "RELEASE SAVEPOINT student_notification_portal",
    ]);
  });

  it("keeps the portal row when only outbox enqueue fails", async () => {
    const query = vi.fn().mockResolvedValue({});
    insertStudentNotification.mockResolvedValueOnce({
      id: "notification-1",
      email: "student@example.test",
    });
    enqueueStudentEmail.mockRejectedValueOnce(new Error("outbox insert failed"));

    await expect(createStudentNotificationIsolated({ query } as never, input)).resolves.toEqual({
      id: "notification-1",
      warnings: [{ channel: "EMAIL_OUTBOX" }],
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SAVEPOINT student_notification_portal",
      "RELEASE SAVEPOINT student_notification_portal",
      "SAVEPOINT student_notification_email",
      "ROLLBACK TO SAVEPOINT student_notification_email",
      "RELEASE SAVEPOINT student_notification_email",
    ]);
  });

  it("forwards optional typed schedule email content and keeps legacy defaults", async () => {
    const query = vi.fn().mockResolvedValue({});
    insertStudentNotification
      .mockResolvedValueOnce({ id: "notification-typed", email: "student@example.test" })
      .mockResolvedValueOnce({ id: "notification-legacy", email: "student@example.test" });
    enqueueStudentEmail.mockResolvedValue("outbox-1");

    await createStudentNotificationIsolated({ query } as never, {
      ...input,
      emailSubject: "Typed schedule subject",
      emailTextBody: "Typed schedule body",
      messageKind: "SCHEDULE",
      sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
      sourceId: "event-1",
      scheduleFingerprint: "a".repeat(64),
    });
    await createStudentNotificationIsolated({ query } as never, input);

    expect(enqueueStudentEmail.mock.calls[0][1]).toEqual({
      studentNumber: "24-0001",
      toEmail: "student@example.test",
      subject: "Typed schedule subject",
      textBody: "Typed schedule body",
      eventKey: "closure-warning-test",
      messageKind: "SCHEDULE",
      notificationType: "CLINIC_CLOSURE_RESCHEDULED",
      sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
      sourceId: "event-1",
      portalNotificationId: "notification-typed",
      scheduleFingerprint: "a".repeat(64),
    });
    expect(enqueueStudentEmail.mock.calls[1][1]).toEqual({
      studentNumber: "24-0001",
      toEmail: "student@example.test",
      subject: "Schedule updated",
      textBody: "Review the replacement schedule.\n\nOpen the student portal to review the details.",
      eventKey: "closure-warning-test",
      messageKind: undefined,
      notificationType: "CLINIC_CLOSURE_RESCHEDULED",
      sourceType: undefined,
      sourceId: undefined,
      portalNotificationId: "notification-legacy",
      scheduleFingerprint: undefined,
    });
  });
});
