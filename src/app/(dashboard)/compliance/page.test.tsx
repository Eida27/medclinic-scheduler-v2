import { beforeEach, describe, expect, it, vi } from "vitest";

const { complianceReport, listColleges, listPriorityGroups, listPrograms, redirect } = vi.hoisted(() => ({
  complianceReport: vi.fn(),
  listColleges: vi.fn(),
  listPriorityGroups: vi.fn(),
  listPrograms: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/repositories/tracking.repository", () => ({ complianceReport }));
vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges,
  listPriorityGroups,
  listPrograms,
}));

import CompliancePage from "./page";

describe("CompliancePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    complianceReport.mockResolvedValue({
      items: [],
      total: 0,
      summary: { totalStudents: 0, physicalCompleted: 0, laboratoryCompleted: 0, pendingAny: 0 },
    });
    listColleges.mockResolvedValue([]);
    listPriorityGroups.mockResolvedValue([]);
    listPrograms.mockResolvedValue([]);
  });

  it("redirects legacy filters to the combined Appointments page", async () => {
    await CompliancePage({
      searchParams: Promise.resolve({
        search: "Aaron Abad",
        appointmentStatus: "PENDING",
        physicalExamStatus: "COMPLETED",
        laboratoryStatus: "PENDING_UPLOAD",
        overallStatus: "INCOMPLETE",
        priorityGroupId: "priority-1",
        sort: "name_asc",
        page: "2",
        unknown: "discard-me",
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/appointments?studentNumber=Aaron+Abad&appointmentStatus=PENDING&priorityGroupId=priority-1&physicalExamStatus=COMPLETED&laboratoryStatus=PENDING_UPLOAD&overallStatus=INCOMPLETE&sort=name_asc&page=2",
    );
    expect(complianceReport).not.toHaveBeenCalled();
  });
});
