// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, validateBatch } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  validateBatch: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/coordinator-schedules.service", () => ({ validateBatch }));

import { POST } from "./route";

describe("POST /api/coordinator-schedules/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "user-1", role: "ADMIN" });
  });

  it("keeps unauthenticated requests unauthorized without parsing or validating", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHORIZED", "Authentication required.", 401));
    const request = new Request("http://localhost/api/coordinator-schedules/validate", { method: "POST" });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(validateBatch).not.toHaveBeenCalled();
  });

  it("returns 410 before parsing or validating an authenticated request", async () => {
    const request = new Request("http://localhost/api/coordinator-schedules/validate", {
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
    expect(validateBatch).not.toHaveBeenCalled();
  });
});
