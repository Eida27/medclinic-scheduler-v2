// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, publishScheduleBatch } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  publishScheduleBatch: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/appointments.service", () => ({ publishScheduleBatch }));

import { POST } from "./route";

describe("POST /api/appointments/publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "user-1", role: "ADMIN" });
  });

  it("keeps the established administrator authentication check ahead of retirement", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "Administrator access required.", 403));
    const request = new Request("http://localhost/api/appointments/publish", { method: "POST" });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(json).not.toHaveBeenCalled();
    expect(publishScheduleBatch).not.toHaveBeenCalled();
  });

  it("returns 410 without parsing or publishing an authenticated request", async () => {
    const request = new Request("http://localhost/api/appointments/publish", {
      method: "POST",
      body: "not-json",
    });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCHEDULING_WORKFLOW_RETIRED" },
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(json).not.toHaveBeenCalled();
    expect(publishScheduleBatch).not.toHaveBeenCalled();
  });
});
