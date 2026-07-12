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

  it("describes the unified Students & Schedules workflow", async () => {
    render(await DashboardPage());

    expect(screen.getByText("Open Students & Schedules")).toBeVisible();
    expect(screen.getByText("Import the official schedule CSV")).toBeVisible();
    expect(screen.getByText("Review and validate the grouped import")).toBeVisible();
    expect(screen.queryByText("Encode a coordinator schedule batch")).not.toBeInTheDocument();
  });
});
