import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { getStudentPortalSchedule, requireVerifiedStudentPage } = vi.hoisted(() => ({
  getStudentPortalSchedule: vi.fn(),
  requireVerifiedStudentPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/verified-student-page", () => ({ requireVerifiedStudentPage }));
vi.mock("@/server/repositories/student-portal.repository", () => ({ getStudentPortalSchedule }));

import StudentSchedulePage from "./page";

describe("StudentSchedulePage", () => {
  it("shows the exact shared Schedule Notice", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      appointments: [],
      history: [],
    });

    render(await StudentSchedulePage());

    expect(screen.getByText(
      "Schedule Notice: Your Laboratory and Physical Examination schedule may change due to priority scheduling requirements, including OJT, Tour, First Year/OVPSA scheduling, clinic closures, emergency closures, capacity adjustments, or other authorized rescheduling. Please check your verified email and the MedClinic student portal for the latest schedule.",
    )).toBeVisible();
  });

  it("shows readable appointment status labels", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      appointments: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        appointmentDate: "2026-08-18",
        status: "NO_SHOW",
      }],
      history: [],
    });

    render(await StudentSchedulePage());

    expect(screen.getByText("No-show")).toBeVisible();
    expect(screen.queryByText("NO SHOW")).not.toBeInTheDocument();
  });

  it("splits unresolved current items from dated closure history", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      appointments: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        appointmentDate: null,
        status: "AWAITING_RESCHEDULE",
      }],
      history: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        originalDate: "2026-08-18",
        status: "AWAITING_RESCHEDULE",
        closureReason: "Generator testing",
        strategy: "MANUAL_RESOLUTION_REQUIRED",
      }],
    });

    render(await StudentSchedulePage());

    expect(screen.getByRole("heading", { name: "Current schedule" })).toBeVisible();
    expect(screen.getByText("Awaiting manual reschedule")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Schedule history" })).toBeVisible();
    expect(screen.getByText(/Original date: 2026-08-18/)).toBeVisible();
    expect(screen.getByText(/Generator testing/)).toBeVisible();
  });
});
