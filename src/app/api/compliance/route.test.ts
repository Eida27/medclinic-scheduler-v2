// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, complianceReport } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  complianceReport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/tracking.repository", () => ({ complianceReport }));

import { GET } from "./route";

describe("GET /api/compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "staff-user", role: "CLINIC_STAFF" });
    complianceReport.mockResolvedValue({
      items: [],
      total: 0,
      summary: {
        totalStudents: 0,
        physicalCompleted: 0,
        laboratoryCompleted: 0,
        pendingAny: 0,
      },
    });
  });

  it("does not forward the internal DRAFT status as a compliance filter", async () => {
    const response = await GET(new Request(
      "http://localhost/api/compliance?appointmentStatus=DRAFT&page=1&limit=20",
    ));

    expect(response.status).toBe(200);
    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentStatus: undefined,
      page: 1,
      limit: 20,
      offset: 0,
    }));
  });

  it("forwards published operational appointment statuses", async () => {
    await GET(new Request(
      "http://localhost/api/compliance?appointmentStatus=PENDING&page=1&limit=20",
    ));

    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentStatus: "PENDING",
    }));
  });
});
