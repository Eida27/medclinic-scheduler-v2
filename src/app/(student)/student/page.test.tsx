import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { getStudentPortalSchedule, requireStudent } = vi.hoisted(() => ({
  getStudentPortalSchedule: vi.fn(),
  requireStudent: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/repositories/student-portal.repository", () => ({ getStudentPortalSchedule }));
vi.mock("@/components/student/EmailVerificationReminder", () => ({
  EmailVerificationReminder: () => null,
}));

import StudentSchedulePage from "./page";

describe("StudentSchedulePage", () => {
  it("shows readable appointment status labels", async () => {
    requireStudent.mockResolvedValue({ studentNumber: "24-0001" });
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
    });

    render(await StudentSchedulePage());

    expect(screen.getByText("No-show")).toBeVisible();
    expect(screen.queryByText("NO SHOW")).not.toBeInTheDocument();
  });
});
