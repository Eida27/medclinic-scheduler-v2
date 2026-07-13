import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appointmentSummaryReport,
  listAppointments,
  listColleges,
  listPriorityGroups,
  listPrograms,
} = vi.hoisted(() => ({
  appointmentSummaryReport: vi.fn(),
  listAppointments: vi.fn(),
  listColleges: vi.fn(),
  listPriorityGroups: vi.fn(),
  listPrograms: vi.fn(),
}));

vi.mock("@/server/repositories/appointment-summary.repository", () => ({ appointmentSummaryReport }));
vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));
vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges,
  listPriorityGroups,
  listPrograms,
}));

import AppointmentsPage from "./page";

const summaryItem = {
  studentNumber: "23-8200-01",
  studentName: "Aaron Abad",
  collegeName: "College of Computer Studies",
  programName: "BS Computer Science",
  appointmentStatus: "PENDING",
  physicalExamStatus: "COMPLETED",
  laboratoryStatus: "REQUIRES_FOLLOW_UP",
  physicalExamAppointmentId: "physical-1",
  physicalExamAppointmentDate: "2026-07-30",
  physicalExamAppointmentStatus: "PENDING",
  laboratoryAppointmentId: "laboratory-1",
  laboratoryAppointmentDate: "2026-07-29",
  laboratoryAppointmentStatus: "COMPLETED",
  nextSchedule: "2026-07-30",
  overallStatus: "FOLLOW_UP",
};

describe("AppointmentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appointmentSummaryReport.mockResolvedValue({
      items: [],
      total: 0,
      summary: {
        totalStudents: 0,
        physicalCompleted: 0,
        laboratoryCompleted: 0,
        pendingAny: 0,
      },
    });
    listColleges.mockResolvedValue([{ id: "college-1", name: "CCS" }]);
    listPrograms.mockResolvedValue([{ id: "program-1", name: "BSCS" }]);
    listPriorityGroups.mockResolvedValue([{ id: "priority-1", name: "Graduating" }]);
  });

  it("renders the combined metrics, filters, and both service summaries", async () => {
    appointmentSummaryReport.mockResolvedValue({
      items: [summaryItem],
      total: 301,
      summary: {
        totalStudents: 301,
        physicalCompleted: 200,
        laboratoryCompleted: 180,
        pendingAny: 121,
      },
    });

    render(await AppointmentsPage({
      searchParams: Promise.resolve({
        studentNumber: "Aaron",
        appointmentDate: "2026-07-30",
        status: "PENDING",
        collegeId: "college-1",
        programId: "program-1",
        priorityGroupId: "priority-1",
        physicalExamStatus: "COMPLETED",
        laboratoryStatus: "REQUIRES_FOLLOW_UP",
        overallStatus: "FOLLOW_UP",
        sort: "name_desc",
        page: "2",
      }),
    }));

    expect(appointmentSummaryReport).toHaveBeenCalledWith({
      search: "Aaron",
      appointmentDate: "2026-07-30",
      appointmentStatus: "PENDING",
      collegeId: "college-1",
      programId: "program-1",
      priorityGroupId: "priority-1",
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "REQUIRES_FOLLOW_UP",
      overallStatus: "FOLLOW_UP",
      sort: "name_desc",
      page: 2,
      limit: 150,
      offset: 150,
    });
    expect(listAppointments).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Appointments & Completion" })).toBeVisible();
    expect(screen.getByText("Matching students")).toBeVisible();
    expect(screen.getByText("Physical completed")).toBeVisible();
    expect(screen.getByText("Laboratory completed")).toBeVisible();
    expect(screen.getByText("Incomplete any")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Student name or number" })).toHaveValue("Aaron");
    expect(screen.getByRole("combobox", { name: "Overall status" })).toHaveValue("FOLLOW_UP");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("name_desc");
    expect(screen.getByText("More filters").closest("details")).toHaveAttribute("open");

    const row = screen.getByRole("row", { name: /Aaron Abad/ });
    expect(within(row).getByRole("link", { name: "Aaron Abad" })).toHaveAttribute(
      "href",
      "/students/23-8200-01",
    );
    expect(within(row).getByRole("link", { name: "Open laboratory appointment" })).toHaveAttribute(
      "href",
      "/appointments/laboratory-1",
    );
    expect(within(row).getByRole("link", { name: "Open physical exam appointment" })).toHaveAttribute(
      "href",
      "/appointments/physical-1",
    );
    expect(within(row).getByText("2026-07-29")).toBeVisible();
    expect(within(row).getByText("REQUIRES_FOLLOW_UP")).toBeVisible();
    expect(within(row).getByText("FOLLOW_UP")).toBeVisible();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();

    const nextHref = screen.getByRole("link", { name: "Next page" }).getAttribute("href");
    const nextUrl = new URL(nextHref!, "http://localhost");
    expect(Object.fromEntries(nextUrl.searchParams)).toMatchObject({
      studentNumber: "Aaron",
      appointmentDate: "2026-07-30",
      appointmentStatus: "PENDING",
      collegeId: "college-1",
      programId: "program-1",
      priorityGroupId: "priority-1",
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "REQUIRES_FOLLOW_UP",
      overallStatus: "FOLLOW_UP",
      sort: "name_desc",
      page: "3",
    });
  });

  it.each(["0", "-2", "1.5", "1e3", "Infinity"])(
    "normalizes malformed page %s and an unsupported sort",
    async (page) => {
      render(await AppointmentsPage({
        searchParams: Promise.resolve({ page, sort: "unsafe-order" }),
      }));

      expect(appointmentSummaryReport).toHaveBeenCalledWith(expect.objectContaining({
        page: 1,
        limit: 150,
        offset: 0,
        sort: "upcoming_asc",
      }));
      expect(screen.getByText("More filters").closest("details")).not.toHaveAttribute("open");
    },
  );

  it("renders an empty student-summary state without pagination", async () => {
    render(await AppointmentsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("No students match these filters.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Appointment pagination" })).not.toBeInTheDocument();
  });
});
