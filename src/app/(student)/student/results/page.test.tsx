import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  getCurrentEffectiveAppointmentsForStudent,
  getStudentPortalSchedule,
  requireVerifiedStudentPage,
} = vi.hoisted(() => ({
  getCurrentEffectiveAppointmentsForStudent: vi.fn(),
  getStudentPortalSchedule: vi.fn(),
  requireVerifiedStudentPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/verified-student-page", () => ({ requireVerifiedStudentPage }));
vi.mock("@/server/repositories/current-effective-appointments.repository", () => ({
  getCurrentEffectiveAppointmentsForStudent,
}));
vi.mock("@/server/repositories/student-portal.repository", () => ({ getStudentPortalSchedule }));

import StudentResultsPage from "./page";

describe("StudentResultsPage", () => {
  it("links only completed current-effective appointments after replacements become current", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentPortalSchedule.mockResolvedValue({
      appointments: [
        {
          id: "older-laboratory",
          scheduleType: "LABORATORY",
          appointmentDate: "2027-08-02",
          status: "COMPLETED",
        },
        {
          id: "current-laboratory",
          scheduleType: "LABORATORY",
          appointmentDate: "2027-08-03",
          status: "COMPLETED",
        },
      ],
    });
    getCurrentEffectiveAppointmentsForStudent.mockResolvedValue({
      laboratory: {
        id: "current-laboratory",
        scheduleType: "LABORATORY",
        appointmentDate: "2027-08-03",
        status: "COMPLETED",
      },
      physicalExam: {
        id: "current-physical",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2027-08-04",
        status: "COMPLETED",
      },
    });

    render(await StudentResultsPage());

    expect(screen.getByRole("link", { name: /Laboratory.*2027-08-03/i })).toHaveAttribute(
      "href",
      "/student/results/current-laboratory",
    );
    expect(screen.getByRole("link", { name: /Physical Examination.*2027-08-04/i })).toHaveAttribute(
      "href",
      "/student/results/current-physical",
    );
    expect(screen.queryByRole("link", { name: /2027-08-02/i })).not.toBeInTheDocument();
  });
});
