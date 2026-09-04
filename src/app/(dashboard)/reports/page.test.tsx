import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { getHistoricalComplianceReport, listAcademicYears, notFound, redirect, requireUser } = vi.hoisted(() => ({
  getHistoricalComplianceReport: vi.fn(),
  listAcademicYears: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/academic-years.service", () => ({ listAcademicYears }));
vi.mock("@/server/services/historical-compliance-report.service", () => ({
  getHistoricalComplianceReport,
}));

import ReportsPage from "./page";

const collegeId = "11111111-1111-4111-8111-111111111111";
const programId = "22222222-2222-4222-8222-222222222222";
const otherCollegeId = "33333333-3333-4333-8333-333333333333";
const otherProgramId = "44444444-4444-4444-8444-444444444444";

const configuredYears = [{
  startYear: 2025,
  label: "2025–2026",
  closingDate: "2026-07-31",
  state: "CLOSED",
  linkedSnapshotCount: 301,
}];

const report = {
  academicYear: {
    startYear: 2025,
    label: "2025–2026",
    closingDate: "2026-07-31",
    state: "CLOSED",
  },
  filters: {
    academicYearStart: 2025,
    search: "Aaron",
    overallStatus: "DID_NOT_COMPLY",
    laboratoryStatus: "NO_SHOW",
    physicalExamStatus: "COMPLETED",
    collegeId,
    programId,
    yearLevel: 4,
    sort: "name_desc",
    page: 2,
    limit: 150,
    offset: 150,
  },
  items: [{
    studentNumber: "23-8200-01",
    studentName: "Abad, Aaron Miguel",
    collegeId,
    collegeName: "College of Computer Studies",
    programId,
    programCode: "BSCS",
    programName: "Computer Science",
    yearLevel: 4,
    laboratoryAppointmentId: "lab-1",
    laboratoryAppointmentDate: "2026-07-20",
    laboratoryStatus: "NO_SHOW",
    physicalExamAppointmentId: "physical-1",
    physicalExamAppointmentDate: "2026-07-21",
    physicalExamStatus: "COMPLETED",
    overallStatus: "DID_NOT_COMPLY_LABORATORY",
  }],
  total: 301,
  summary: {
    totalStudents: 301,
    fullyComplied: 180,
    pendingCompliance: 0,
    didNotComply: 121,
    complianceRate: 59.8,
    laboratoryIncomplete: 80,
    physicalExamIncomplete: 70,
    bothIncomplete: 29,
  },
  breakdowns: {
    colleges: [{
      collegeId,
      collegeName: "College of Computer Studies",
      totalStudents: 301,
      fullyComplied: 180,
      attentionStudents: 121,
      complianceRate: 59.8,
    }],
    programs: [{
      collegeId,
      collegeName: "College of Computer Studies",
      programId,
      programCode: "BSCS",
      programName: "Computer Science",
      totalStudents: 301,
      fullyComplied: 180,
      attentionStudents: 121,
      complianceRate: 59.8,
    }],
    yearLevels: [{
      yearLevel: 4,
      totalStudents: 301,
      fullyComplied: 180,
      attentionStudents: 121,
      complianceRate: 59.8,
    }],
  },
  dimensions: {
    colleges: [
      { id: collegeId, name: "College of Computer Studies" },
      { id: otherCollegeId, name: "College of Engineering" },
    ],
    programs: [
      { id: programId, collegeId, code: "BSCS", name: "Computer Science" },
      { id: "55555555-5555-4555-8555-555555555555", collegeId, code: "BSIT", name: "Information Technology" },
      { id: otherProgramId, collegeId: otherCollegeId, code: "BSCE", name: "Civil Engineering" },
    ],
    yearLevels: [1, 2, 3, 4],
  },
} as const;

describe("ReportsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-id", role: "ADMIN" });
    listAcademicYears.mockResolvedValue(configuredYears);
    getHistoricalComplianceReport.mockResolvedValue(report);
  });

  it.each(["COORDINATOR", "CLINIC_STAFF"])(
    "cleanly denies %s before reading report data",
    async (role) => {
      const error = new AppError("FORBIDDEN", `${role} is forbidden`, 403);
      requireUser.mockRejectedValue(error);

      await expect(ReportsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");

      expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
      expect(notFound).toHaveBeenCalledOnce();
      expect(listAcademicYears).not.toHaveBeenCalled();
      expect(getHistoricalComplianceReport).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an unauthenticated error", new AppError("UNAUTHENTICATED", "Sign in required", 401)],
    ["an unexpected error", new Error("Session store unavailable")],
  ])("propagates %s before reading report data", async (_label, error) => {
    requireUser.mockRejectedValue(error);

    await expect(ReportsPage({ searchParams: Promise.resolve({}) })).rejects.toBe(error);

    expect(notFound).not.toHaveBeenCalled();
    expect(listAcademicYears).not.toHaveBeenCalled();
    expect(getHistoricalComplianceReport).not.toHaveBeenCalled();
  });

  it("requires a configured academic year before loading report data", async () => {
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listAcademicYears).toHaveBeenCalledOnce();
    expect(getHistoricalComplianceReport).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    expect(screen.getByText("Review historical appointment compliance, identify students with incomplete requirements, and export filtered records.")).toBeVisible();
    expect(screen.getByText("Select a configured academic year to generate the report.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
  });

  it("maps an unknown year to not found without rendering report data", async () => {
    getHistoricalComplianceReport.mockRejectedValue(
      new AppError("ACADEMIC_YEAR_NOT_FOUND", "Academic year not found.", 404),
    );

    await expect(ReportsPage({
      searchParams: Promise.resolve({ academicYearStart: "2024" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledOnce();
  });

  it("redirects an incompatible bookmarked college and program to normalized filters", async () => {
    getHistoricalComplianceReport.mockResolvedValue({
      ...report,
      filters: {
        ...report.filters,
        collegeId,
        programId: otherProgramId,
        page: 2,
        offset: 150,
      },
      total: 0,
      items: [],
    });

    await expect(ReportsPage({
      searchParams: Promise.resolve({
        academicYearStart: "2025",
        search: "Aaron",
        overallStatus: "DID_NOT_COMPLY",
        laboratoryStatus: "NO_SHOW",
        physicalExamStatus: "COMPLETED",
        collegeId,
        programId: otherProgramId,
        yearLevel: "4",
        dataQuality: "MIGRATED_INCOMPLETE",
        sort: "name_desc",
        page: "2",
      }),
    })).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith(
      `/reports?academicYearStart=2025&search=Aaron&overallStatus=DID_NOT_COMPLY&laboratoryStatus=NO_SHOW&physicalExamStatus=COMPLETED&collegeId=${collegeId}&yearLevel=4&sort=name_desc`,
    );
  });

  it("preserves a valid bookmarked program filter when no college is selected", async () => {
    getHistoricalComplianceReport.mockResolvedValue({
      ...report,
      filters: {
        ...report.filters,
        collegeId: undefined,
        page: 1,
        offset: 0,
      },
    });

    render(await ReportsPage({
      searchParams: Promise.resolve({ academicYearStart: "2025", programId }),
    }));

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "College" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue(programId);
  });

  it("preserves a bookmarked college-program pair when a reassigned program has another tuple first", async () => {
    getHistoricalComplianceReport.mockResolvedValue({
      ...report,
      filters: {
        ...report.filters,
        collegeId,
        programId,
        page: 1,
        offset: 0,
      },
      dimensions: {
        ...report.dimensions,
        programs: [
          { id: programId, collegeId: otherCollegeId, code: "OLD", name: "Former Program" },
          { id: programId, collegeId, code: "BSCS", name: "Computer Science" },
        ],
      },
    });

    render(await ReportsPage({
      searchParams: Promise.resolve({ academicYearStart: "2025", collegeId, programId }),
    }));

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "College" })).toHaveValue(collegeId);
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue(programId);
  });

  it("redirects pages beyond the last result page while preserving normalized filters", async () => {
    getHistoricalComplianceReport.mockResolvedValue({
      ...report,
      filters: { ...report.filters, page: 999, offset: 149_700 },
      items: [],
      total: 301,
    });

    await expect(ReportsPage({
      searchParams: Promise.resolve({ academicYearStart: "2025", page: "999" }),
    })).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith(
      `/reports?academicYearStart=2025&search=Aaron&overallStatus=DID_NOT_COMPLY&laboratoryStatus=NO_SHOW&physicalExamStatus=COMPLETED&collegeId=${collegeId}&programId=${programId}&yearLevel=4&sort=name_desc&page=3`,
    );
  });

  it("renders normalized metrics, dependent filters, breakdowns, rows, and pagination", async () => {
    render(await ReportsPage({
      searchParams: Promise.resolve({
        academicYearStart: "2025",
        search: "Aaron",
        overallStatus: "DID_NOT_COMPLY",
        laboratoryStatus: "NO_SHOW",
        physicalExamStatus: "COMPLETED",
        collegeId,
        programId,
        yearLevel: "4",
        dataQuality: "MIGRATED_INCOMPLETE",
        sort: "name_desc",
        page: "2",
      }),
    }));

    expect(getHistoricalComplianceReport).toHaveBeenCalledWith(expect.objectContaining({
      academicYearStart: "2025",
      search: "Aaron",
      sort: "name_desc",
      page: "2",
    }));
    expect(screen.getByRole("heading", { level: 2, name: "2025–2026" })).toBeVisible();
    expect(screen.getByText(/Closing date: July 31, 2026/)).toBeVisible();
    expect(screen.getByText("Closed")).toBeVisible();

    const primaryMetrics = screen.getByRole("region", { name: "Primary report metrics" });
    for (const [label, value] of [
      ["Total Students", "301"],
      ["Fully Complied", "180"],
      ["Did Not Comply", "121"],
      ["Compliance Rate", "59.8%"],
    ]) {
      const metric = within(primaryMetrics).getByText(label).closest("div");
      expect(metric).toHaveTextContent(value);
    }
    const secondaryMetrics = screen.getByRole("region", { name: "Secondary report metrics" });
    for (const [label, value] of [
      ["Laboratory incomplete", "80"],
      ["Physical Examination incomplete", "70"],
      ["Both incomplete", "29"],
    ]) {
      const metric = within(secondaryMetrics).getByText(label).closest("div");
      expect(metric).toHaveTextContent(value);
    }
    expect(screen.queryByText(/migrated or incomplete historical/i)).not.toBeInTheDocument();

    const filterForm = screen.getByRole("form", { name: "Report filters" });
    expect(filterForm).toHaveAttribute("method", "get");
    expect(filterForm).toHaveClass("md:grid-cols-2", "xl:grid-cols-4");
    expect(screen.getByRole("textbox", { name: "Student name or number" })).toHaveValue("Aaron");
    expect(screen.getByRole("combobox", { name: "Overall compliance" })).toHaveValue("DID_NOT_COMPLY");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("name_desc");
    expect(screen.queryByRole("combobox", { name: /data quality/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Program" })).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Any program",
      "BSCS — Computer Science",
      "BSIT — Information Technology",
    ]);
    expect(screen.queryByRole("option", { name: /Civil Engineering/ })).not.toBeInTheDocument();
    expect(filterForm.querySelector('[name="page"]')).toBeNull();

    expect(screen.getByRole("heading", { level: 2, name: "College breakdown" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Program breakdown" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Year-level breakdown" })).toBeVisible();
    const collegeLink = screen.getByRole("link", { name: "Filter by College of Computer Studies" });
    const collegeUrl = new URL(collegeLink.getAttribute("href")!, "http://localhost");
    expect(collegeUrl.pathname).toBe("/reports");
    expect(collegeUrl.searchParams.get("collegeId")).toBe(collegeId);
    expect(collegeUrl.searchParams.get("programId")).toBe(programId);
    expect(collegeUrl.searchParams.get("search")).toBe("Aaron");
    expect(collegeUrl.searchParams.has("page")).toBe(false);

    const row = screen.getByRole("row", { name: /Abad, Aaron Miguel/ });
    expect(within(row).getByText("23-8200-01")).toBeVisible();
    expect(within(row).getByText("BSCS — Computer Science")).toBeVisible();
    expect(within(row).getByText("No-show")).toBeVisible();
    expect(within(row).getByText("Completed")).toBeVisible();
    expect(within(row).getByText("Did Not Comply - Laboratory")).toBeVisible();
    expect(within(row).getAllByRole("cell")).toHaveLength(7);
    expect([...screen.getByRole("table", { name: "Detailed historical compliance records" }).querySelectorAll("th")]
      .map((header) => header.textContent)).toEqual([
        "Student", "Historical college", "Historical program", "Year", "Laboratory", "Physical Examination", "Overall",
      ]);
    expect(screen.getByRole("table", { name: "Detailed historical compliance records" })).toHaveClass("min-w-[64rem]");

    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    const nextUrl = new URL(screen.getByRole("link", { name: "Next page" }).getAttribute("href")!, "http://localhost");
    expect(nextUrl.searchParams.get("academicYearStart")).toBe("2025");
    expect(nextUrl.searchParams.get("programId")).toBe(programId);
    expect(nextUrl.searchParams.get("sort")).toBe("name_desc");
    expect(nextUrl.searchParams.get("page")).toBe("3");
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
  });

  it("shows an empty filtered state and disables export", async () => {
    getHistoricalComplianceReport.mockResolvedValue({
      ...report,
      items: [],
      total: 0,
      summary: {
        totalStudents: 0,
        fullyComplied: 0,
        pendingCompliance: 0,
        didNotComply: 0,
        complianceRate: 0,
        laboratoryIncomplete: 0,
        physicalExamIncomplete: 0,
        bothIncomplete: 0,
      },
      breakdowns: { colleges: [], programs: [], yearLevels: [] },
    });

    render(await ReportsPage({
      searchParams: Promise.resolve({ academicYearStart: "2025", search: "Nobody" }),
    }));

    expect(screen.getByText("No historical compliance records match the selected filters.")).toBeVisible();
    expect(screen.queryByRole("table", { name: "Detailed historical compliance records" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Report pagination" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
