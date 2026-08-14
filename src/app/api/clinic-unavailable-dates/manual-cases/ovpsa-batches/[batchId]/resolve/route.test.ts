// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { requireUser, confirmOvpsaClinicClosureBatchRecovery } = vi.hoisted(() => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "admin", role: "ADMIN" }),
  confirmOvpsaClinicClosureBatchRecovery: vi.fn().mockResolvedValue({ revisionNumber: 2 }),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({
  confirmOvpsaClinicClosureBatchRecovery,
}));

import { POST } from "./route";

describe("OVPSA closure batch confirmation API", () => {
  it("passes linked case tokens for one atomic confirmation", async () => {
    const body = {
      optimisticToken: "90000000-0000-4000-8000-000000000001",
      replacementLaboratoryDate: "2026-10-05",
      caseTokens: [{
        caseId: "70000000-0000-4000-8000-000000000001",
        expectedOptimisticToken: "60000000-0000-4000-8000-000000000001",
      }],
      reason: "Mission Hospital replacement approved.",
    };
    const response = await POST(new Request("http://local/resolve", {
      method: "POST",
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ batchId: "80000000-0000-4000-8000-000000000001" }) });
    expect(response.status).toBe(200);
    expect(confirmOvpsaClinicClosureBatchRecovery).toHaveBeenCalledWith(
      "80000000-0000-4000-8000-000000000001",
      body,
      expect.objectContaining({ role: "ADMIN" }),
    );
  });
});
