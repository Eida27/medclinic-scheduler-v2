// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/types/roles";

const { recordResult, requireUser, resultsForStudent } = vi.hoisted(() => ({
  recordResult: vi.fn(),
  requireUser: vi.fn(),
  resultsForStudent: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/tracking.repository", () => ({ resultsForStudent }));
vi.mock("@/server/services/tracking.service", () => ({ recordResult }));

import { POST } from "./route";

const actor = {
  userId: "00000000-0000-4000-8000-000000000002",
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: "60000000-0000-4000-8000-000000000001",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
} satisfies SessionUser;

describe("POST /api/results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(actor);
    recordResult.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("passes the full authenticated session user to the result service", async () => {
    const input = {
      studentNumber: "TEST-ROUTE-0001",
      appointmentId: null,
      resultType: "LABORATORY",
      resultStatus: "COMPLETED",
      completedAt: "2026-07-17",
      remarks: "Historical result",
    };

    const response = await POST(new Request("http://localhost/api/results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));

    expect(response.status).toBe(201);
    expect(recordResult).toHaveBeenCalledWith(input, actor);
  });
});
