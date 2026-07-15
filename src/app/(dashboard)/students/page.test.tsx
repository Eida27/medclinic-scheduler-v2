import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  listStudents,
  listColleges,
  listPrograms,
  listScheduleImports,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listStudents: vi.fn(),
  listColleges: vi.fn(),
  listPrograms: vi.fn(),
  listScheduleImports: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/students.service", () => ({ listStudents }));
vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges,
  listPrograms,
}));
vi.mock("@/server/services/schedule-imports.service", () => ({ listScheduleImports }));

import StudentsPage from "./page";

const admin = {
  userId: "admin-1",
  fullName: "System Admin",
  email: "admin@example.com",
  role: "ADMIN" as const,
};

const clinicStaff = {
  userId: "staff-1",
  fullName: "Clinic Staff",
  email: "staff@example.com",
  role: "CLINIC_STAFF" as const,
};

const coordinator = {
  userId: "coordinator-1",
  fullName: "Schedule Coordinator",
  email: "coordinator@example.com",
  role: "COORDINATOR" as const,
};

const student = {
  studentNumber: "24-0001",
  firstName: "Ana",
  middleName: null,
  lastName: "Santos",
  suffix: null,
  fullName: "Ana Santos",
  collegeId: "college-1",
  collegeName: "College of Computer Studies",
  programId: "program-1",
  programName: "BSIT",
  yearLevel: 3,
  section: "A",
  isActive: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const scheduleImport = {
  importId: "11111111-1111-4111-8111-111111111111",
  importName: "First Semester Schedules",
  sourceFilename: "first-semester.csv",
  totalRows: 40,
  createdStudentCount: 8,
  matchedStudentCount: 32,
  submittedByName: "Health Services Coordinator",
  description: null,
  createdByName: "System Admin",
  laboratoryItemCount: 25,
  physicalExaminationItemCount: 30,
  status: "VALIDATED" as const,
  createdAt: "2026-07-10T08:30:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
};

describe("StudentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listStudents.mockResolvedValue({ items: [student], total: 1 });
    listColleges.mockResolvedValue([{
      id: "college-1",
      code: "CCS",
      name: "College of Computer Studies",
      isActive: true,
    }]);
    listPrograms.mockResolvedValue([{
      id: "program-1",
      collegeId: "college-1",
      collegeName: "College of Computer Studies",
      code: "BSIT",
      name: "BSIT",
      isActive: true,
    }]);
    listScheduleImports.mockResolvedValue([scheduleImport]);
  });

  it("shows the administrator's grouped schedule-import workspace and actions", async () => {
    render(await StudentsPage({
      searchParams: Promise.resolve({ view: "schedule-imports" }),
    }));

    expect(screen.getByRole("heading", { name: "Students & Schedules" })).toBeVisible();
    expect(screen.getByText("Manage student records and publish imported clinic schedules.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Students" })).toHaveAttribute("href", "/students");
    expect(screen.getByRole("link", { name: "Schedule Imports" })).toHaveAttribute(
      "href",
      "/students?view=schedule-imports",
    );
    expect(screen.getByRole("link", { name: "Schedule Imports" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Import schedule CSV" })).toHaveAttribute(
      "href",
      "/students/schedule-imports/new",
    );
    expect(screen.getByRole("link", { name: "Download CSV template" })).toHaveAttribute(
      "href",
      "/templates/student-schedule-import-template.csv",
    );
    expect(screen.getByRole("link", { name: "Add student" })).toHaveAttribute("href", "/students/new");

    const row = screen.getByRole("row", { name: /First Semester Schedules/ });
    expect(within(row).getByText("first-semester.csv")).toBeVisible();
    expect(within(row).getByText("System Admin")).toBeVisible();
    expect(within(row).getByText("40")).toBeVisible();
    expect(within(row).getByText("32 matched · 8 created")).toBeVisible();
    expect(within(row).getByRole("cell", { name: "25" })).toBeVisible();
    expect(within(row).getByRole("cell", { name: "30" })).toBeVisible();
    expect(within(row).getByText("VALIDATED")).toBeVisible();
    expect(within(row).getByRole("link", { name: "View details" })).toHaveAttribute(
      "href",
      `/students/schedule-imports/${scheduleImport.importId}`,
    );
    expect(listScheduleImports).toHaveBeenCalledWith(admin);
    expect(listStudents).not.toHaveBeenCalled();
  });

  it("forces clinic staff back to Students when the schedule-import query is requested", async () => {
    requireUser.mockResolvedValue(clinicStaff);

    render(await StudentsPage({
      searchParams: Promise.resolve({ view: "schedule-imports" }),
    }));

    expect(screen.getByRole("link", { name: "Students" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Schedule Imports" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Import schedule CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download CSV template" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add student" })).toBeVisible();
    expect(screen.getByText("Ana Santos")).toBeVisible();
    expect(listScheduleImports).not.toHaveBeenCalled();
    expect(listStudents).toHaveBeenCalled();
  });

  it("gives coordinators the import workspace without student mutation controls", async () => {
    requireUser.mockResolvedValue(coordinator);

    render(await StudentsPage({
      searchParams: Promise.resolve({ view: "schedule-imports" }),
    }));

    expect(screen.getByRole("link", { name: "Schedule Imports" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Import schedule CSV" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Download CSV template" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Add student" })).not.toBeInTheDocument();
    expect(listScheduleImports).toHaveBeenCalledWith(coordinator);
    expect(listStudents).not.toHaveBeenCalled();
  });

  it("filters students by year level and preserves all filters in pagination links", async () => {
    listStudents.mockResolvedValue({ items: [student], total: 45 });

    render(await StudentsPage({
      searchParams: Promise.resolve({
        search: "Ana",
        collegeId: "college-1",
        programId: "program-1",
        yearLevel: "3",
        page: "2",
      }),
    }));

    expect(screen.getByRole("textbox", { name: "Search students" })).toHaveValue("Ana");
    expect(screen.getByRole("combobox", { name: "College" })).toHaveValue("college-1");
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("program-1");
    expect(screen.getByRole("combobox", { name: "Year level" })).toHaveValue("3");
    expect(listStudents).toHaveBeenCalledWith({
      search: "Ana",
      collegeId: "college-1",
      programId: "program-1",
      yearLevel: 3,
      page: 2,
      limit: 20,
      offset: 20,
    });
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/students?search=Ana&collegeId=college-1&programId=program-1&yearLevel=3&page=1",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/students?search=Ana&collegeId=college-1&programId=program-1&yearLevel=3&page=3",
    );
  });

  it("shows the exact grouped-import empty state", async () => {
    listScheduleImports.mockResolvedValue([]);

    render(await StudentsPage({
      searchParams: Promise.resolve({ view: "schedule-imports" }),
    }));

    expect(screen.getByText("No schedule CSV files have been imported yet.")).toBeVisible();
  });
});
