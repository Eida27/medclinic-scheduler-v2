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

const studentHash = "cc489581e86dff1348dd5618df2fd8686c2803df0c954b11baa6da1ed7f68441";
const eventKeyHash = "c8e9e793a5a9c5fc4eee5d6a62261bea011b48eb18c72da181b1a0e801c29ec6";

function warningAuditCall(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.find(([sql]) => String(sql).includes("STUDENT_NOTIFICATION_ENQUEUE_WARNING"));
}

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
      expect.stringContaining("STUDENT_NOTIFICATION_ENQUEUE_WARNING"),
    ]);
    expect(warningAuditCall(query)?.[1]).toEqual([
      null,
      JSON.stringify({
        channel: "PORTAL",
        studentHash,
        notificationType: "CLINIC_CLOSURE_RESCHEDULED",
        messageKind: "GENERAL",
        eventKeyHash,
      }),
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
      expect.stringContaining("STUDENT_NOTIFICATION_ENQUEUE_WARNING"),
    ]);
    expect(warningAuditCall(query)?.[1]).toEqual([
      "notification-1",
      JSON.stringify({
        channel: "EMAIL_OUTBOX",
        studentHash,
        notificationType: "CLINIC_CLOSURE_RESCHEDULED",
        messageKind: "GENERAL",
        eventKeyHash,
      }),
    ]);
  });

  it("keeps verification tokens, destinations, bodies, and failure details out of warning audits", async () => {
    const query = vi.fn().mockResolvedValue({});
    insertStudentNotification.mockResolvedValueOnce({
      id: "notification-private",
      email: "private.student@example.test",
    });
    enqueueStudentEmail.mockRejectedValueOnce(
      new Error("SMTP rejected token=verification-secret-token for private.student@example.test"),
    );

    await createStudentNotificationIsolated({ query } as never, {
      ...input,
      message: "Internal portal message with verification-secret-token",
      emailSubject: "Private email subject",
      emailTextBody: "Private email body with verification-secret-token",
    });

    const auditCall = warningAuditCall(query);
    expect(auditCall?.[1]).toEqual([
      "notification-private",
      JSON.stringify({
        channel: "EMAIL_OUTBOX",
        studentHash,
        notificationType: "CLINIC_CLOSURE_RESCHEDULED",
        messageKind: "GENERAL",
        eventKeyHash,
      }),
    ]);
    expect(JSON.stringify(auditCall)).not.toContain("verification-secret-token");
    expect(JSON.stringify(auditCall)).not.toContain("private.student@example.test");
    expect(JSON.stringify(auditCall)).not.toContain("Private email");
    expect(JSON.stringify(auditCall)).not.toContain("SMTP rejected");
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
