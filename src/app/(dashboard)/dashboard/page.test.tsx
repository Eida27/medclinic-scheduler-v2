import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dashboardMetrics } = vi.hoisted(() => ({
  dashboardMetrics: vi.fn(),
}));

vi.mock("@/server/repositories/tracking.repository", () => ({ dashboardMetrics }));

import DashboardPage from "./page";

describe("DashboardPage", () => {
  beforeEach(() => {
    dashboardMetrics.mockResolvedValue({
      totalStudents: 12,
      pendingAppointments: 4,
      completedPhysicalExams: 3,
      completedLaboratory: 2,
      noShows: 1,
      rescheduled: 1,
      overCapacityWarnings: 0,
    });
  });

  it("keeps administrator-only unpublished import state off the shared dashboard", async () => {
    render(await DashboardPage());

    expect(screen.queryByText("Unpublished batches")).not.toBeInTheDocument();
  });

  it("describes the one-confirmation Students & Schedules workflow", async () => {
    render(await DashboardPage());

    expect(screen.getByText("Open Students & Schedules")).toBeVisible();
    expect(screen.getByText("Choose the CSV and required priority group")).toBeVisible();
    expect(screen.getByText("Review one confirmation and agree to import")).toBeVisible();
    expect(screen.getByText("The system validates, generates, and publishes automatically")).toBeVisible();
    expect(screen.getByText("Administrators resolve any saved review checkpoint")).toBeVisible();
    expect(screen.queryByText("Review and validate the grouped import")).not.toBeInTheDocument();
    expect(screen.queryByText("Encode a coordinator schedule batch")).not.toBeInTheDocument();
  });
});
