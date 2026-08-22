import { describe, expect, it } from "vitest";
import {
  mapAdminEmailDeliveryRow,
  maskEmailDestination,
  sanitizeEmailDeliveryFailure,
} from "./admin-email-deliveries.repository";

describe("administrator email-delivery response mapping", () => {
  it.each([
    ["ana.santos@example.test", "a***@example.test"],
    ["A@Sub.Example.Test", "A***@Sub.Example.Test"],
    ["invalid-address", "***"],
  ])("masks %s without returning the full destination", (destination, masked) => {
    expect(maskEmailDestination(destination)).toBe(masked);
  });

  it.each([
    ["535 Authentication failed for smtp-user with password=hunter2", "Email service authentication failed."],
    ["connect ETIMEDOUT 192.0.2.4:587", "Email service timed out."],
    ["getaddrinfo ENOTFOUND smtp.private.example", "Email service connection failed."],
    ["Quota exceeded; token=https://student.test/verify?token=raw-secret", "Email service temporarily limited."],
    ["provider-specific internal response", "Email delivery failed."],
    [null, null],
  ])("sanitizes raw delivery failure %s", (failure, sanitized) => {
    expect(sanitizeEmailDeliveryFailure(failure)).toBe(sanitized);
  });

  it.each([
    ["PENDING", 0, "Pending"],
    ["PENDING", 3, "Retrying"],
    ["PROCESSING", 3, "Retrying"],
    ["SENT", 1, "Sent"],
    ["PERMANENT_FAILURE", 10, "Failed"],
    ["OBSOLETE", 10, "Failed"],
  ] as const)("maps %s with %s attempts to %s", (status, attempts, expected) => {
    const mapped = mapAdminEmailDeliveryRow({
      id: "delivery-1",
      studentNumber: "24-0001",
      toEmail: "student@example.test",
      status,
      attempts,
      lastAttemptAt: new Date("2026-08-22T02:00:00.000Z"),
      lastAttemptStatus: status === "PROCESSING" ? "PENDING" : status,
      lastError: "SMTP password=secret token=https://private.test/token",
      messageKind: "SCHEDULE",
      notificationType: "SCHEDULE_CURRENT_STATE",
      sourceType: "CURRENT_SCHEDULE_STATE",
      sourceId: "safe-source",
      scheduleFingerprint: "f".repeat(64),
    });

    expect(mapped).toEqual({
      id: "delivery-1",
      destination: "s***@example.test",
      state: expected,
      attempts,
      lastAttempt: {
        at: "2026-08-22T02:00:00.000Z",
        state: expected,
      },
      context: {
        studentNumber: "24-0001",
        messageKind: "SCHEDULE",
        notificationType: "SCHEDULE_CURRENT_STATE",
        sourceType: "CURRENT_SCHEDULE_STATE",
        sourceId: "safe-source",
      },
      failureReason: expected === "Failed" ? "Email service authentication failed." : null,
      actionable: status === "PERMANENT_FAILURE",
    });
    expect(mapped).not.toHaveProperty("toEmail");
    expect(mapped).not.toHaveProperty("lastError");
    expect(mapped).not.toHaveProperty("scheduleFingerprint");
    expect(JSON.stringify(mapped)).not.toContain("password=secret");
    expect(JSON.stringify(mapped)).not.toContain("https://private.test/token");
  });
});
