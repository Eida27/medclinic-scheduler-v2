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
      capacityConflicts: 0,
    });
  });

  it("keeps administrator-only unpublished import state off the shared dashboard", async () => {
    render(await DashboardPage());

    expect(screen.queryByText("Unpublished batches")).not.toBeInTheDocument();
  });

  it("describes the one-confirmation Students & Schedules workflow", async () => {
    render(await DashboardPage());

    expect(screen.getByText("Open Students & Schedules")).toBeVisible();
    expect(screen.getByText("Choose the CSV, academic year, and student category")).toBeVisible();
    expect(screen.getByText("Review one confirmation and agree to import")).toBeVisible();
    expect(screen.getByText("The system validates, generates, and publishes automatically")).toBeVisible();
    expect(screen.getByText("Review displacement and the generated date range")).toBeVisible();
    expect(screen.queryByText("Review and validate the grouped import")).not.toBeInTheDocument();
    expect(screen.queryByText("Encode a coordinator schedule batch")).not.toBeInTheDocument();
  });

  it("describes only maximum-capacity conflicts", async () => {
    render(await DashboardPage());

    expect(screen.getByText("Capacity conflicts")).toBeVisible();
    expect(screen.getByText("Service dates above maximum capacity")).toBeVisible();
    expect(screen.queryByText(/warning|recommended|safe capacity/i)).not.toBeInTheDocument();
  });
});
