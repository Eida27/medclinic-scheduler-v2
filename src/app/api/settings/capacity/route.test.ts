// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getCapacitySettings, changeCapacity } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getCapacitySettings: vi.fn(),
  changeCapacity: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getCapacitySettings }));
vi.mock("@/server/services/appointments.service", () => ({ changeCapacity }));

import { PATCH } from "./route";

describe("PATCH /api/settings/capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-id", role: "ADMIN" });
    changeCapacity.mockResolvedValue({
      scheduleType: "LABORATORY",
      maxDailyCapacity: 125,
    });
  });

  it("accepts a maximum-only capacity payload", async () => {
    const body = {
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
      maxDailyCapacity: 125,
    };
    const response = await PATCH(new Request("http://localhost/api/settings/capacity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(changeCapacity).toHaveBeenCalledWith(body, "admin-id");
    await expect(response.json()).resolves.toEqual({
      data: { scheduleType: "LABORATORY", maxDailyCapacity: 125 },
    });
  });
});
