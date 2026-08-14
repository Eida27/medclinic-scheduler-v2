// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { requireUser, previewOvpsaClinicClosureBatchRecovery } = vi.hoisted(() => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "admin", role: "ADMIN" }),
  previewOvpsaClinicClosureBatchRecovery: vi.fn().mockResolvedValue({ linkedCaseCount: 2 }),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({
  previewOvpsaClinicClosureBatchRecovery,
}));

import { POST } from "./route";

describe("OVPSA closure batch preview API", () => {
  it("passes the batch token and replacement Laboratory date", async () => {
    const body = {
      optimisticToken: "90000000-0000-4000-8000-000000000001",
      replacementLaboratoryDate: "2026-10-05",
    };
    const response = await POST(new Request("http://local/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ batchId: "80000000-0000-4000-8000-000000000001" }) });
    expect(response.status).toBe(200);
    expect(previewOvpsaClinicClosureBatchRecovery).toHaveBeenCalledWith(
      "80000000-0000-4000-8000-000000000001",
      body,
      expect.objectContaining({ role: "ADMIN" }),
    );
  });
});
