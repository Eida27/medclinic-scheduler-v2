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

  it("normalizes unsupported summary filters instead of forwarding them", async () => {
    const response = await GET(new Request(
      "http://localhost/api/compliance?appointmentStatus=DRAFT&physicalExamStatus=UNKNOWN&laboratoryStatus=UNKNOWN&overallStatus=UNKNOWN&sort=unsafe&page=1&limit=20",
    ));

    expect(response.status).toBe(200);
    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentStatus: undefined,
      physicalExamStatus: undefined,
      laboratoryStatus: undefined,
      overallStatus: undefined,
      sort: "upcoming_asc",
      page: 1,
      limit: 20,
      offset: 0,
    }));
  });

  it("forwards supported filters and sort values", async () => {
    await GET(new Request(
      "http://localhost/api/compliance?appointmentDate=2026-07-30&appointmentStatus=PENDING&physicalExamStatus=COMPLETED&laboratoryStatus=REQUIRES_FOLLOW_UP&overallStatus=FOLLOW_UP&sort=name_desc&page=1&limit=20",
    ));

    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentDate: "2026-07-30",
      appointmentStatus: "PENDING",
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "REQUIRES_FOLLOW_UP",
      overallStatus: "FOLLOW_UP",
      sort: "name_desc",
    }));
  });
});
