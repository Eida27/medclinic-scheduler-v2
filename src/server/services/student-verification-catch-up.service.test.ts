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

const client = { query: vi.fn() } as never;
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
  openManualResolutionId: null,
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
      eventKey: "schedule:current:24-0001:9bd953b9d1a559c23160ca4c52570e70e573825728d1a9aad817005b49bf7958",
      emailTextBody: expect.stringContaining("Laboratory: 2026-09-10 at CPU Medical Center (Pending)."),
      scheduleFingerprint: "9bd953b9d1a559c23160ca4c52570e70e573825728d1a9aad817005b49bf7958",
    }));
  });
});
