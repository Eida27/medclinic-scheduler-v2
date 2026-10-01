import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { getStudentPortalSchedule, requireVerifiedStudentPage, requireStudentPage } = vi.hoisted(() => ({
  getStudentPortalSchedule: vi.fn(),
  requireVerifiedStudentPage: vi.fn(),
  requireStudentPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/verified-student-page", () => ({ requireVerifiedStudentPage }));
vi.mock("@/server/auth/student-page", () => ({ requireStudentPage }));
vi.mock("@/server/repositories/student-portal.repository", () => ({ getStudentPortalSchedule }));

import StudentSchedulePage from "./page";

describe("StudentSchedulePage", () => {
  it("reads the same schedule without forcing email verification", async () => {
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001", studentName: "Santos, Ana M.", email: null, emailVerifiedAt: null });
    requireVerifiedStudentPage.mockRejectedValue(new Error("Verification must not gate reading"));
    getStudentPortalSchedule.mockResolvedValue({ studentNumber: "24-0001", studentName: "Santos, Ana M.", appointments: [], history: [], previousAcademicYears: [] });
    render(await StudentSchedulePage());
    expect(screen.getByRole("heading", { name: "Santos, Ana M." })).toBeVisible();
    expect(screen.getByText("No published appointments yet.")).toBeVisible();
    expect(getStudentPortalSchedule).toHaveBeenCalledWith("24-0001");
  });
  it("shows the exact shared Schedule Notice", async () => {
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
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
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      appointments: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        appointmentDate: "2026-08-18",
        status: "NO_SHOW",
        academicYearStart: 2026,
        isFutureAcademicYear: false,
      }],
      history: [],
    });

    render(await StudentSchedulePage());

    expect(screen.getByText("No-show")).toBeVisible();
    expect(screen.queryByText("NO SHOW")).not.toBeInTheDocument();
  });

  it("splits unresolved current items from dated closure history", async () => {
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      appointments: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        appointmentDate: null,
        status: "AWAITING_RESCHEDULE",
        academicYearStart: 2026,
        isFutureAcademicYear: false,
      }],
      history: [{
        id: "appointment-1",
        scheduleType: "LABORATORY",
        originalDate: "2026-08-18",
        status: "AWAITING_RESCHEDULE",
        closureReason: "Generator testing",
        strategy: "MANUAL_RESOLUTION_REQUIRED",
        academicYearStart: 2026,
        isEndedAcademicYear: false,
        isFutureAcademicYear: false,
      }],
    });

    render(await StudentSchedulePage());

    expect(screen.getByRole("heading", { name: "Current schedule" })).toBeVisible();
    expect(screen.getByText("Awaiting manual reschedule")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Schedule history" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Schedule history" }).textContent).toContain("Academic year 2026–2027");
    expect(screen.getByText(/Original date: 2026-08-18/)).toBeVisible();
    expect(screen.getByText(/Generator testing/)).toBeVisible();
  });

  it("labels current and prepared future academic years in the schedule", async () => {
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      appointments: [
        { id: "current", scheduleType: "LABORATORY", appointmentDate: "2026-09-22",
          status: "PENDING", academicYearStart: 2026, isFutureAcademicYear: false },
        { id: "future", scheduleType: "LABORATORY", appointmentDate: "2027-09-22",
          status: "PENDING", academicYearStart: 2027, isFutureAcademicYear: true },
      ],
      history: [],
      previousAcademicYears: [],
    });

    render(await StudentSchedulePage());

    expect(screen.getByText("Academic year 2026–2027")).toBeVisible();
    expect(screen.getByText("Academic year 2027–2028 · Upcoming")).toBeVisible();
  });

  it("places ended-year reschedule history with previous academic years", async () => {
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Santos, Ana M.",
      appointments: [],
      history: [
        { id: "old", scheduleType: "LABORATORY", originalDate: "2026-05-12",
          academicYearStart: 2025, isEndedAcademicYear: true, isFutureAcademicYear: false,
          status: "RESCHEDULED", closureReason: "Past-year closure", strategy: "AUTO" },
        { id: "current", scheduleType: "PHYSICAL_EXAM", originalDate: "2026-09-12",
          academicYearStart: 2026, isEndedAcademicYear: false, isFutureAcademicYear: false,
          status: "RESCHEDULED", closureReason: "Current-year closure", strategy: "AUTO" },
      ],
      previousAcademicYears: [],
    });

    render(await StudentSchedulePage());

    const currentHistory = screen.getByRole("region", { name: "Schedule history" });
    const previousYears = screen.getByRole("region", { name: "Previous academic years" });
    expect(within(currentHistory).getByText("Original date: 2026-09-12")).toBeVisible();
    expect(within(currentHistory).queryByText("Original date: 2026-05-12")).not.toBeInTheDocument();
    expect(within(previousYears).getByText("Original date: 2026-05-12")).toBeVisible();
    expect(within(previousYears).getByText("Academic year 2025–2026 · Laboratory schedule change")).toBeVisible();
  });
});
