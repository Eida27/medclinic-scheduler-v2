// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { requireUser, resolveClinicClosureManualCase } = vi.hoisted(() => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "admin", role: "ADMIN" }),
  resolveClinicClosureManualCase: vi.fn().mockResolvedValue({ status: "RESOLVED" }),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({ resolveClinicClosureManualCase }));

import { POST } from "./route";

describe("manual-case resolution API", () => {
  it("passes the optimistic resolution body and case ID", async () => {
    const body = {
      action: "KEEP_CURRENT_REPLACEMENT",
      expectedOptimisticToken: "90000000-0000-4000-8000-000000000001",
      reason: "The replacement remains safe.",
    };
    const response = await POST(new Request("http://local/resolve", {
      method: "POST",
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ caseId: "80000000-0000-4000-8000-000000000001" }) });
    expect(response.status).toBe(200);
    expect(resolveClinicClosureManualCase).toHaveBeenCalledWith(
      "80000000-0000-4000-8000-000000000001",
      body,
      expect.objectContaining({ role: "ADMIN" }),
    );
  });
});
