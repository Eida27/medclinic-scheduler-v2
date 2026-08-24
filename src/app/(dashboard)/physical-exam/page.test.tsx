import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertClinicAccess, dashboardMetrics, listAppointments, requireUser } = vi.hoisted(() => ({
  assertClinicAccess: vi.fn(),
  dashboardMetrics: vi.fn(),
  listAppointments: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/clinic-access", () => ({ assertClinicAccess }));
vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));
vi.mock("@/server/repositories/tracking.repository", () => ({ dashboardMetrics }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import PhysicalExamPage from "./page";

const physicalExamStaff = {
  userId: "staff-2",
  fullName: "Physical Examination Staff",
  email: "physical@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "CPU_CLINIC" as const,
};

const kabalakaStaff = {
  userId: "staff-1",
  fullName: "Laboratory Staff",
  email: "laboratory@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "KABALAKA_CLINIC" as const,
};

const administrator = {
  userId: "admin-1",
  fullName: "MedClinic Administrator",
  email: "admin@example.com",
  role: "ADMIN" as const,
  clinicCode: null,
};

describe("PhysicalExamPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireUser.mockResolvedValue(physicalExamStaff);
    listAppointments.mockResolvedValue({ items: [], total: 0 });
    dashboardMetrics.mockResolvedValue({
      pendingAppointments: 0,
      completedPhysicalExams: 0,
      noShows: 0,
      unpublishedBatches: 0,
    });
  });

  it("requires CPU Clinic access and renders only its published physical examination schedule", async () => {
    render(await PhysicalExamPage({
      searchParams: Promise.resolve({
        studentNumber: "Ben Reyes",
        appointmentDate: "2026-08-19",
        status: "NO_SHOW",
        sort: "surname_desc",
        isPublished: "false",
      }),
    }));

    expect(requireUser).toHaveBeenCalledOnce();
    expect(assertClinicAccess).toHaveBeenCalledWith(physicalExamStaff, "CPU_CLINIC");
    expect(listAppointments).toHaveBeenCalledWith({
      clinicCode: "CPU_CLINIC",
      appointmentDate: "2026-08-19",
      scheduleType: "PHYSICAL_EXAM",
      status: "NO_SHOW",
      studentNumber: "Ben Reyes",
      sort: "surname_desc",
      isPublished: true,
      includeLaboratoryStatus: true,
      page: 1,
      limit: 150,
      offset: 0,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Published physical examination schedule" })).toBeVisible();
    expect(screen.getByText("No published physical examination appointments match these filters.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /coordinator schedules/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new batch|import/i })).not.toBeInTheDocument();
  });

  it("shows KABALAKA staff a restricted state without loading CPU Clinic schedule data", async () => {
    requireUser.mockResolvedValue(kabalakaStaff);
    listAppointments.mockResolvedValue({
      items: [{
        id: "cpu-appointment-1",
        studentNumber: "23-8000-01",
        studentName: "CPU Student",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2026-08-19",
        status: "PENDING",
        completedFromStatus: null,
        laboratoryStatus: "PENDING",
      }],
      total: 1,
    });

    render(await PhysicalExamPage({
      searchParams: Promise.resolve({ studentNumber: "CPU Student" }),
    }));

    expect(screen.getByRole("heading", { level: 1, name: "Physical Exam access restricted" })).toBeVisible();
    expect(screen.getByText("This account is assigned to KABALAKA Clinic. You can only access the Laboratory tab.")).toBeVisible();
    expect(screen.getAllByTestId("clinic-access-lock")).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 1, name: "Published physical examination schedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Sort" })).not.toBeInTheDocument();
    expect(screen.queryByText("CPU Student")).not.toBeInTheDocument();
    expect(assertClinicAccess).not.toHaveBeenCalled();
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("allows an administrator to load the CPU Clinic physical examination schedule", async () => {
    requireUser.mockResolvedValue(administrator);

    render(await PhysicalExamPage({ searchParams: Promise.resolve({}) }));

    expect(assertClinicAccess).toHaveBeenCalledWith(administrator, "CPU_CLINIC");
    expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({
      clinicCode: "CPU_CLINIC",
      scheduleType: "PHYSICAL_EXAM",
    }));
    expect(screen.getByRole("heading", { level: 1, name: "Published physical examination schedule" })).toBeVisible();
  });

  it.each([
    ["missing", { ...physicalExamStaff, clinicCode: null }],
    ["invalid", { ...physicalExamStaff, clinicCode: "UNKNOWN_CLINIC" }],
  ])("keeps the %s clinic assignment on the existing authorization path", async (_kind, unauthorizedUser) => {
    const accessError = new Error("CLINIC_ACCESS_DENIED");
    requireUser.mockResolvedValue(unauthorizedUser);
    assertClinicAccess.mockImplementation(() => { throw accessError; });

    await expect(PhysicalExamPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("CLINIC_ACCESS_DENIED");

    expect(assertClinicAccess).toHaveBeenCalledWith(unauthorizedUser, "CPU_CLINIC");
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("loads and renders the second physical examination page", async () => {
    listAppointments.mockResolvedValue({
      items: [{
        id: "physical-appointment-151",
        studentNumber: "23-8200-01",
        studentName: "Ben Reyes",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2026-08-19",
        status: "PENDING",
        completedFromStatus: null,
        laboratoryStatus: "COMPLETED",
      }],
      total: 280,
    });

    render(await PhysicalExamPage({
      searchParams: Promise.resolve({
        studentNumber: "Ben Reyes",
        appointmentDate: "2026-08-19",
        status: "NO_SHOW",
        sort: "latest",
        page: "2",
      }),
    }));

    expect(listAppointments).toHaveBeenCalledWith({
      clinicCode: "CPU_CLINIC",
      appointmentDate: "2026-08-19",
      scheduleType: "PHYSICAL_EXAM",
      status: "NO_SHOW",
      studentNumber: "Ben Reyes",
      sort: "latest",
      isPublished: true,
      includeLaboratoryStatus: true,
      page: 2,
      limit: 150,
      offset: 150,
    });
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/physical-exam?studentNumber=Ben+Reyes&sort=latest&appointmentDate=2026-08-19&status=NO_SHOW&page=1",
    );
    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pending — click to mark completed" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Laboratory Status" })).toBeVisible();
    expect(screen.getByText("Completed", { selector: "td span" })).toHaveClass("bg-emerald-100");
    expect(screen.getByRole("link", { name: "Ben Reyes" })).toHaveAttribute(
      "href",
      "/physical-exam/physical-appointment-151",
    );
  });
});
