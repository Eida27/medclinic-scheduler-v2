// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, complianceReport } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  complianceReport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/tracking.repository", () => ({ complianceReport }));

import { GET } from "./route";
import { AppError } from "@/lib/errors";

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

  it("defaults an unsupported sort without forwarding invalid filters", async () => {
    const response = await GET(new Request(
      "http://localhost/api/compliance?sort=unsafe&page=1&limit=20",
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

  it.each([
    "appointmentStatus=DRAFT",
    "physicalExamStatus=UNKNOWN",
    "laboratoryStatus=UNKNOWN",
    "overallStatus=UNKNOWN",
  ])("rejects an unsupported status filter: %s", async (query) => {
    const response = await GET(new Request(`http://localhost/api/compliance?${query}`));

    expect(response.status).toBe(422);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it.each([
    "collegeId=not-a-uuid",
    "programId=not-a-uuid",
    "priorityGroupId=not-a-uuid",
    "appointmentDate=2026-99-99",
  ])("rejects a malformed identifier or date: %s", async (query) => {
    const response = await GET(new Request(`http://localhost/api/compliance?${query}`));

    expect(response.status).toBe(422);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    requireUser.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Sign in required.", 401));

    const response = await GET(new Request("http://localhost/api/compliance"));

    expect(response.status).toBe(401);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it("forwards supported filters and sort values", async () => {
    await GET(new Request(
      "http://localhost/api/compliance?appointmentDate=2026-07-30&appointmentStatus=PENDING&physicalExamStatus=PENDING_UPLOAD&laboratoryStatus=REQUIRES_FOLLOW_UP&overallStatus=FOLLOW_UP&sort=name_desc&page=1&limit=20",
    ));

    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentDate: "2026-07-30",
      appointmentStatus: "PENDING",
      physicalExamStatus: "PENDING_UPLOAD",
      laboratoryStatus: "REQUIRES_FOLLOW_UP",
      overallStatus: "FOLLOW_UP",
      sort: "name_desc",
    }));
  });
});
