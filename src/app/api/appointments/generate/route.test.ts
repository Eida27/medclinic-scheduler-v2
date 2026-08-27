// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, generateBatchAppointments } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  generateBatchAppointments: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/coordinator-schedules.service", () => ({ generateBatchAppointments }));

import { POST } from "./route";

describe("POST /api/appointments/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "user-1", role: "ADMIN" });
  });

  it("keeps authentication ahead of retirement", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHORIZED", "Authentication required.", 401));
    const request = new Request("http://localhost/api/appointments/generate", { method: "POST" });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(generateBatchAppointments).not.toHaveBeenCalled();
  });

  it("returns 410 without parsing or generating appointments", async () => {
    const request = new Request("http://localhost/api/appointments/generate", {
      method: "POST",
      body: "not-json",
    });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCHEDULING_WORKFLOW_RETIRED" },
    });
    expect(json).not.toHaveBeenCalled();
    expect(generateBatchAppointments).not.toHaveBeenCalled();
  });
});
