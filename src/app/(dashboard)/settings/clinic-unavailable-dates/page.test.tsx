import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";

const { requireUser, listClinicUnavailableDateRecords, listClinicClosureManualCases } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listClinicUnavailableDateRecords: vi.fn(),
  listClinicClosureManualCases: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/clinic-unavailable-dates.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/clinic-unavailable-dates.repository")>();
  return { ...actual, listClinicUnavailableDateRecords };
});
vi.mock("@/server/services/clinic-calendar.service", () => ({ listClinicClosureManualCases }));

import ClinicUnavailableDatesPage from "./page";

const unavailableDates: ClinicUnavailableDateRecord[] = [{
  id: "70000000-0000-4000-8000-000000000001",
  closureGroupId: "71000000-0000-4000-8000-000000000001",
  blockedDate: "2026-08-19",
  groupStartDate: "2026-08-19",
  groupEndDate: "2026-08-19",
  category: "MAINTENANCE",
  reason: "Generator testing",
  createdByName: "Clinic Admin",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000000Z",
}];

describe("ClinicUnavailableDatesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T04:00:00.000Z"));
    listClinicUnavailableDateRecords.mockResolvedValue(unavailableDates);
    listClinicClosureManualCases.mockResolvedValue({ total: 4, items: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the unified editable year and open-case count for administrators", async () => {
    requireUser.mockResolvedValue({ userId: "admin-id", role: "ADMIN" });
    render(await ClinicUnavailableDatesPage());

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(listClinicUnavailableDateRecords).toHaveBeenCalledOnce();
    expect(listClinicClosureManualCases).toHaveBeenCalledWith(
      { page: 1, pageSize: 1, status: "OPEN" },
      expect.objectContaining({ role: "ADMIN" }),
    );
    expect(screen.getByText("4 open manual cases")).toBeVisible();
    expect(screen.getByRole("heading", { name: "August" })).toBeVisible();
    expect(screen.getByLabelText("Calendar year")).toHaveValue("2026");
    expect(screen.getByLabelText("Closure category")).toBeVisible();
  });

  it("renders the same route read-only for clinic staff", async () => {
    requireUser.mockResolvedValue({ userId: "staff-id", role: "CLINIC_STAFF" });
    render(await ClinicUnavailableDatesPage());

    expect(listClinicClosureManualCases).not.toHaveBeenCalled();
    expect(screen.getByText("This calendar is read-only for clinic staff.")).toBeVisible();
    expect(screen.queryByLabelText("Closure category")).not.toBeInTheDocument();
  });
});
