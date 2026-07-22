import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { appointmentSummaryReport, listAppointments } = vi.hoisted(() => ({
  appointmentSummaryReport: vi.fn(),
  listAppointments: vi.fn(),
}));

vi.mock("@/server/repositories/appointment-summary.repository", () => ({ appointmentSummaryReport }));
vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));

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
  laboratoryAppointmentStatus: "NO_SHOW",
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
  });

  it("renders the approved filters and result-only service summaries with readable labels", async () => {
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
    expect(screen.getByRole("combobox", { name: "Overall completion" })).toHaveValue("FOLLOW_UP");
    expect(screen.getByRole("combobox", { name: "Laboratory status" })).toHaveValue("REQUIRES_FOLLOW_UP");
    expect(screen.getByRole("combobox", { name: "Physical exam status" })).toHaveValue("COMPLETED");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("name_desc");
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/appointments");
    expect(screen.queryByText("More filters")).not.toBeInTheDocument();
    for (const removedLabel of ["Appointment date", "Appointment status", "College", "Program", "Priority"]) {
      expect(screen.queryByLabelText(removedLabel)).not.toBeInTheDocument();
    }

    for (const name of ["Laboratory status", "Physical exam status"]) {
      const select = screen.getByRole("combobox", { name });
      expect(within(select).getByRole("option", { name: "Pending" })).toHaveValue("PENDING_UPLOAD");
      expect(within(select).getByRole("option", { name: "Completed" })).toHaveValue("COMPLETED");
      expect(within(select).getByRole("option", { name: "Needs follow-up" })).toHaveValue("REQUIRES_FOLLOW_UP");
      expect(within(select).getByRole("option", { name: "Not applicable" })).toHaveValue("NOT_APPLICABLE");
    }

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    expect(headers.map((header) => header.textContent)).toEqual([
      "Student",
      "Laboratory",
      "Physical exam",
      "Overall",
    ]);
    headers.slice(0, 3).forEach((header) => {
      expect(header).not.toHaveClass("text-center");
    });
    expect(headers[3]).toHaveClass("text-center");

    const row = screen.getByRole("row", { name: /Aaron Abad/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    cells.slice(0, 3).forEach((cell) => {
      expect(cell).not.toHaveClass("text-center");
    });
    expect(cells[3]).toHaveClass("text-center");
    const studentLink = within(row).getByRole("link", { name: "Aaron Abad" });
    expect(studentLink).toHaveAttribute(
      "href",
      "/students/23-8200-01",
    );
    expect(within(row).getAllByRole("link")).toEqual([studentLink]);
    expect(within(row).getAllByText("Needs follow-up")).toHaveLength(2);
    expect(within(row).getByText("Completed")).toBeVisible();
    expect(within(row).queryByText("2026-07-29")).not.toBeInTheDocument();
    expect(within(row).queryByText("2026-07-30")).not.toBeInTheDocument();
    expect(within(row).queryByText("Result")).not.toBeInTheDocument();
    expect(within(row).queryByText("PENDING")).not.toBeInTheDocument();
    expect(within(row).queryByText("NO_SHOW")).not.toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Open laboratory appointment" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Open physical exam appointment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Next schedule" })).not.toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();

    const nextHref = screen.getByRole("link", { name: "Next page" }).getAttribute("href");
    const nextUrl = new URL(nextHref!, "http://localhost");
    expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
      studentNumber: "Aaron",
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
    },
  );

  it("renders an empty student-summary state without pagination", async () => {
    render(await AppointmentsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("No students match the selected filters. Clear one or more filters and try again.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Appointment pagination" })).not.toBeInTheDocument();
  });
});
