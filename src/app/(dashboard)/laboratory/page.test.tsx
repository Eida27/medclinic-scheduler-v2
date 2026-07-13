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

import LaboratoryPage from "./page";

const laboratoryStaff = {
  userId: "staff-1",
  fullName: "Laboratory Staff",
  email: "laboratory@example.com",
  role: "CLINIC_STAFF" as const,
  clinicCode: "KABALAKA_CLINIC" as const,
};

describe("LaboratoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("loads and renders the second laboratory page", async () => {
    listAppointments.mockResolvedValue({
      items: [{
        id: "laboratory-appointment-151",
        studentNumber: "23-8300-01",
        studentName: "Ana Santos",
        scheduleType: "LABORATORY",
        appointmentDate: "2026-08-18",
        appointmentTime: null,
        status: "PENDING",
      }],
      total: 280,
    });

    render(await LaboratoryPage({
      searchParams: Promise.resolve({
        studentNumber: "Ana Santos",
        appointmentDate: "2026-08-18",
        status: "COMPLETED",
        page: "2",
      }),
    }));

    expect(listAppointments).toHaveBeenCalledWith({
      clinicCode: "KABALAKA_CLINIC",
      appointmentDate: "2026-08-18",
      scheduleType: "LABORATORY",
      status: "COMPLETED",
      studentNumber: "Ana Santos",
      isPublished: true,
      page: 2,
      limit: 150,
      offset: 150,
    });
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/laboratory?studentNumber=Ana+Santos&appointmentDate=2026-08-18&status=COMPLETED&page=1",
    );
    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
  });
});
