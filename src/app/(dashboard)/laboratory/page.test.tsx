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

import LaboratoryPage from "./page";

const laboratoryStaff = {
  userId: "staff-1",
  fullName: "Laboratory Staff",
  email: "laboratory@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "KABALAKA_CLINIC" as const,
};

const physicalExamStaff = {
  userId: "staff-2",
  fullName: "Physical Examination Staff",
  email: "physical@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "CPU_CLINIC" as const,
};

const administrator = {
  userId: "admin-1",
  fullName: "MedClinic Administrator",
  email: "admin@example.com",
  role: "ADMIN" as const,
  clinicCode: null,
};

describe("LaboratoryPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireUser.mockResolvedValue(laboratoryStaff);
    listAppointments.mockResolvedValue({ items: [], total: 0 });
    dashboardMetrics.mockResolvedValue({
      pendingAppointments: 0,
      completedLaboratory: 0,
      noShows: 0,
      unpublishedBatches: 0,
    });
  });

  it("requires KABALAKA access and renders only its published laboratory schedule", async () => {
    render(await LaboratoryPage({
      searchParams: Promise.resolve({
        studentNumber: "Ana Santos",
        appointmentDate: "2026-08-18",
        status: "COMPLETED",
        sort: "surname_asc",
        isPublished: "false",
      }),
    }));

    expect(requireUser).toHaveBeenCalledOnce();
    expect(assertClinicAccess).toHaveBeenCalledWith(laboratoryStaff, "KABALAKA_CLINIC");
    expect(listAppointments).toHaveBeenCalledWith({
      clinicCode: "KABALAKA_CLINIC",
      appointmentDate: "2026-08-18",
      scheduleType: "LABORATORY",
      status: "COMPLETED",
      studentNumber: "Ana Santos",
      sort: "surname_asc",
      isPublished: true,
      page: 1,
      limit: 150,
      offset: 0,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Published laboratory schedule" })).toBeVisible();
    expect(screen.getByText("No published laboratory appointments match these filters.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /coordinator schedules/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new batch|import/i })).not.toBeInTheDocument();
  });

  it("shows CPU staff a restricted state without loading KABALAKA Clinic schedule data", async () => {
    requireUser.mockResolvedValue(physicalExamStaff);
    listAppointments.mockResolvedValue({
      items: [{
        id: "laboratory-appointment-1",
        studentNumber: "23-8000-01",
        studentName: "Laboratory Student",
        scheduleType: "LABORATORY",
        appointmentDate: "2026-08-18",
        status: "PENDING",
        completedFromStatus: null,
      }],
      total: 1,
    });

    render(await LaboratoryPage({
      searchParams: Promise.resolve({ studentNumber: "Laboratory Student" }),
    }));

    expect(screen.getByRole("heading", { level: 1, name: "Laboratory access restricted" })).toBeVisible();
    expect(screen.getByText("This account is assigned to CPU Clinic. You can only access the Physical Exam tab.")).toBeVisible();
    expect(screen.getAllByTestId("clinic-access-lock")).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 1, name: "Published laboratory schedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Sort" })).not.toBeInTheDocument();
    expect(screen.queryByText("Laboratory Student")).not.toBeInTheDocument();
    expect(assertClinicAccess).not.toHaveBeenCalled();
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("allows an administrator to load the KABALAKA Clinic laboratory schedule", async () => {
    requireUser.mockResolvedValue(administrator);

    render(await LaboratoryPage({ searchParams: Promise.resolve({}) }));

    expect(assertClinicAccess).toHaveBeenCalledWith(administrator, "KABALAKA_CLINIC");
    expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
    }));
    expect(screen.getByRole("heading", { level: 1, name: "Published laboratory schedule" })).toBeVisible();
  });

  it.each([
    ["missing", { ...laboratoryStaff, clinicCode: null }],
    ["invalid", { ...laboratoryStaff, clinicCode: "UNKNOWN_CLINIC" }],
  ])("keeps the %s clinic assignment on the existing authorization path", async (_kind, unauthorizedUser) => {
    const accessError = new Error("CLINIC_ACCESS_DENIED");
    requireUser.mockResolvedValue(unauthorizedUser);
    assertClinicAccess.mockImplementation(() => { throw accessError; });

    await expect(LaboratoryPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("CLINIC_ACCESS_DENIED");

    expect(assertClinicAccess).toHaveBeenCalledWith(unauthorizedUser, "KABALAKA_CLINIC");
    expect(listAppointments).not.toHaveBeenCalled();
  });

  it("loads and renders the second laboratory page", async () => {
    listAppointments.mockResolvedValue({
      items: [{
        id: "laboratory-appointment-151",
        studentNumber: "23-8300-01",
        studentName: "Ana Santos",
        scheduleType: "LABORATORY",
        appointmentDate: "2026-08-18",
        status: "PENDING",
        completedFromStatus: null,
      }],
      total: 280,
    });

    render(await LaboratoryPage({
      searchParams: Promise.resolve({
        studentNumber: "Ana Santos",
        appointmentDate: "2026-08-18",
        status: "COMPLETED",
        sort: "latest",
        page: "2",
      }),
    }));

    expect(listAppointments).toHaveBeenCalledWith({
      clinicCode: "KABALAKA_CLINIC",
      appointmentDate: "2026-08-18",
      scheduleType: "LABORATORY",
      status: "COMPLETED",
      studentNumber: "Ana Santos",
      sort: "latest",
      isPublished: true,
      page: 2,
      limit: 150,
      offset: 150,
    });
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/laboratory?studentNumber=Ana+Santos&sort=latest&appointmentDate=2026-08-18&status=COMPLETED&page=1",
    );
    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pending — click to mark completed" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Ana Santos" })).toHaveAttribute(
      "href",
      "/laboratory/laboratory-appointment-151",
    );
  });

  it("falls back to soonest for an unsupported sort", async () => {
    render(await LaboratoryPage({
      searchParams: Promise.resolve({ sort: "date_desc" }),
    }));

    expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({ sort: "soonest" }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("soonest");
  });
});
