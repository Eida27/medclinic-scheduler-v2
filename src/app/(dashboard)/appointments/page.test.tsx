import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect }));

import AppointmentsPage from "./page";

describe("AppointmentsPage legacy redirect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps only compatible legacy appointment filters to Reports", async () => {
    await AppointmentsPage({
      searchParams: Promise.resolve({
        academicYearStart: "2025",
        studentNumber: "Aaron Abad",
        overallStatus: "COMPLETE",
        laboratoryStatus: "NO_SHOW",
        physicalExamStatus: "COMPLETED",
        collegeId: "11111111-1111-4111-8111-111111111111",
        programId: "22222222-2222-4222-8222-222222222222",
        yearLevel: "4",
        dataQuality: "RECOVERED_HISTORICAL",
        sort: "name_desc",
        page: "2",
        appointmentDate: "2026-07-30",
        appointmentStatus: "PENDING",
        unknown: "discard-me",
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/reports?academicYearStart=2025&search=Aaron+Abad&overallStatus=COMPLIED&laboratoryStatus=NO_SHOW&physicalExamStatus=COMPLETED&collegeId=11111111-1111-4111-8111-111111111111&programId=22222222-2222-4222-8222-222222222222&yearLevel=4&dataQuality=RECOVERED_HISTORICAL&sort=name_desc&page=2",
    );
  });

  it("drops state-dependent incomplete and incompatible sort/page values", async () => {
    await AppointmentsPage({
      searchParams: Promise.resolve({
        overallStatus: "INCOMPLETE",
        laboratoryStatus: "PENDING_UPLOAD",
        sort: "upcoming_asc",
        page: "-3",
      }),
    });

    expect(redirect).toHaveBeenCalledWith("/reports");
  });

  it("uses the first value when legacy query parameters are duplicated", async () => {
    await AppointmentsPage({
      searchParams: Promise.resolve({
        academicYearStart: ["2025", "2024"],
        studentNumber: ["First Student", "Second Student"],
        overallStatus: ["COMPLETE", "INCOMPLETE"],
        sort: ["name_asc", "upcoming_asc"],
        page: ["2", "999"],
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/reports?academicYearStart=2025&search=First+Student&overallStatus=COMPLIED&sort=name_asc&page=2",
    );
  });
});
