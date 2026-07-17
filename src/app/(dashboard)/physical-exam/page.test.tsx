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

import PhysicalExamPage from "./page";

const physicalExamStaff = {
  userId: "staff-2",
  fullName: "Physical Examination Staff",
  email: "physical@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "CPU_CLINIC" as const,
};

describe("PhysicalExamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      page: 1,
      limit: 150,
      offset: 0,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Published physical examination schedule" })).toBeVisible();
    expect(screen.getByText("No published physical examination appointments match these filters.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /coordinator schedules/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new batch|import/i })).not.toBeInTheDocument();
  });

  it("loads and renders the second physical examination page", async () => {
    listAppointments.mockResolvedValue({
      items: [{
        id: "physical-appointment-151",
        studentNumber: "23-8200-01",
        studentName: "Ben Reyes",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2026-08-19",
        appointmentTime: null,
        status: "PENDING",
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
  });
});
