import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadAuthoritativeScheduleState, createStudentNotificationIsolated } = vi.hoisted(() => ({
  loadAuthoritativeScheduleState: vi.fn(),
  createStudentNotificationIsolated: vi.fn(),
}));

vi.mock("@/server/repositories/schedule-state.repository", () => ({
  loadAuthoritativeScheduleState,
}));
vi.mock("./student-notifications.service", () => ({
  createStudentNotificationIsolated,
}));

import { queueFirstVerificationCurrentStateCatchUp } from "./student-verification-catch-up.service";

const query = vi.fn();
const client = { query } as never;
const state = {
  studentNumber: "24-0001",
  studentName: "Santos, Ana M.",
  laboratory: {
    id: "lab-1",
    scheduleType: "LABORATORY",
    status: "PENDING",
    date: "2026-09-10",
    affectedDate: null,
    location: "CPU Medical Center",
  },
  physicalExam: null,
  openManualResolutionIds: [],
};

describe("first-verification current-state catch-up", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when no authoritative schedule state exists", async () => {
    loadAuthoritativeScheduleState.mockResolvedValue(null);

    await expect(queueFirstVerificationCurrentStateCatchUp(client, "24-0001"))
      .resolves.toBeUndefined();
    expect(createStudentNotificationIsolated).not.toHaveBeenCalled();
  });

  it("uses the isolated notification boundary with a fingerprint-idempotent current state", async () => {
    loadAuthoritativeScheduleState.mockResolvedValue(state);
    createStudentNotificationIsolated.mockResolvedValue({ id: "notification-1", warnings: [] });

    await expect(queueFirstVerificationCurrentStateCatchUp(client, "24-0001"))
      .resolves.toEqual({ id: "notification-1", warnings: [] });
    expect(createStudentNotificationIsolated).toHaveBeenCalledWith(client, expect.objectContaining({
      eventKey: "schedule:current:24-0001:640d9172a7a9b1bdc88d298494a92b3a8895f79db92d8a01035013f1aee6cdb2",
      emailTextBody: expect.stringContaining("Laboratory: 2026-09-10 at CPU Medical Center (Pending)."),
      scheduleFingerprint: "640d9172a7a9b1bdc88d298494a92b3a8895f79db92d8a01035013f1aee6cdb2",
    }));
  });

  it("audits an isolated channel warning while preserving it for the caller", async () => {
    loadAuthoritativeScheduleState.mockResolvedValue(state);
    createStudentNotificationIsolated.mockResolvedValue({
      id: "notification-1",
      warnings: [{ channel: "EMAIL_OUTBOX" }],
    });

    await expect(queueFirstVerificationCurrentStateCatchUp(client, "24-0001")).resolves.toEqual({
      id: "notification-1",
      warnings: [{ channel: "EMAIL_OUTBOX" }],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("STUDENT_SCHEDULE_CATCH_UP_NOTIFICATION_WARNING"),
      [
        "24-0001",
        "EMAIL_OUTBOX",
        "640d9172a7a9b1bdc88d298494a92b3a8895f79db92d8a01035013f1aee6cdb2",
      ],
    );
  });
});
