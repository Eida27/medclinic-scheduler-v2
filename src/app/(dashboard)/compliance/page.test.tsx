import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect }));

import CompliancePage from "./page";

describe("CompliancePage legacy redirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects compatible report parameters directly to Reports", async () => {
    await CompliancePage({
      searchParams: Promise.resolve({
        academicYearStart: "2025",
        search: "Aaron Abad",
        overallStatus: "DID_NOT_COMPLY",
        physicalExamStatus: "COMPLETED",
        laboratoryStatus: "NO_SHOW",
        collegeId: "11111111-1111-4111-8111-111111111111",
        programId: "22222222-2222-4222-8222-222222222222",
        yearLevel: "4",
        dataQuality: "MIGRATED_INCOMPLETE",
        sort: "attention_first",
        page: "2",
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/reports?academicYearStart=2025&search=Aaron+Abad&overallStatus=DID_NOT_COMPLY&laboratoryStatus=NO_SHOW&physicalExamStatus=COMPLETED&collegeId=11111111-1111-4111-8111-111111111111&programId=22222222-2222-4222-8222-222222222222&yearLevel=4&dataQuality=MIGRATED_INCOMPLETE&sort=attention_first&page=2",
    );
  });

  it("uses the first value when report query parameters are duplicated", async () => {
    await CompliancePage({
      searchParams: Promise.resolve({
        academicYearStart: ["2025", "2024"],
        search: ["First Student", "Second Student"],
        overallStatus: ["COMPLIED", "DID_NOT_COMPLY"],
        sort: ["year_desc", "name_asc"],
        page: ["3", "8"],
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/reports?academicYearStart=2025&search=First+Student&overallStatus=COMPLIED&sort=year_desc&page=3",
    );
  });
});
