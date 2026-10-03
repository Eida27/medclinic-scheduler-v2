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

  it.each(["appointmentStatus", "physicalExamStatus", "laboratoryStatus"])("accepts every current attendance value for %s", async (filter) => {
    for (const value of ["PENDING", "COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED", "AWAITING_RESCHEDULE", "UNSCHEDULED"]) {
      const response = await GET(new Request(`http://localhost/api/compliance?${filter}=${value}`));
      expect(response.status).toBe(200);
      expect(complianceReport).toHaveBeenLastCalledWith(expect.objectContaining({ [filter]: value }));
    }
  });

  it.each(["physicalExamStatus", "laboratoryStatus"])("rejects upload and clinical values for %s before repository access", async (filter) => {
    for (const value of ["PENDING_UPLOAD", "REQUIRES_FOLLOW_UP", "NOT_APPLICABLE"]) {
      const response = await GET(new Request(`http://localhost/api/compliance?${filter}=${value}`));
      expect(response.status).toBe(422);
    }
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it("rejects the obsolete overall FOLLOW_UP filter before repository access", async () => {
    const response = await GET(new Request("http://localhost/api/compliance?overallStatus=FOLLOW_UP"));
    expect(response.status).toBe(422);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it.each([
    "collegeId=not-a-uuid",
    "programId=not-a-uuid",
    "appointmentDate=2026-99-99",
  ])("rejects a malformed identifier or date: %s", async (query) => {
    const response = await GET(new Request(`http://localhost/api/compliance?${query}`));

    expect(response.status).toBe(422);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it("does not forward the retired priority-group query parameter", async () => {
    const response = await GET(new Request(
      "http://localhost/api/compliance?priorityGroupId=33333333-3333-4333-8333-333333333333",
    ));

    expect(response.status).toBe(200);
    expect(complianceReport).toHaveBeenCalledWith(expect.not.objectContaining({
      priorityGroupId: expect.anything(),
    }));
  });

  it("requires authentication", async () => {
    requireUser.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Sign in required.", 401));

    const response = await GET(new Request("http://localhost/api/compliance"));

    expect(response.status).toBe(401);
    expect(complianceReport).not.toHaveBeenCalled();
  });

  it("forwards supported filters and sort values", async () => {
    await GET(new Request(
      "http://localhost/api/compliance?appointmentDate=2026-07-30&appointmentStatus=PENDING&physicalExamStatus=COMPLETED&laboratoryStatus=PENDING&overallStatus=INCOMPLETE&sort=name_desc&page=1&limit=20",
    ));

    expect(complianceReport).toHaveBeenCalledWith(expect.objectContaining({
      appointmentDate: "2026-07-30",
      appointmentStatus: "PENDING",
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "PENDING",
      overallStatus: "INCOMPLETE",
      sort: "name_desc",
    }));
  });
});
