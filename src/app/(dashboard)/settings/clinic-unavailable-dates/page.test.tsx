import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";

const { requireUser, listClinicOptions, listClinicUnavailableDateRecords } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listClinicOptions: vi.fn(),
  listClinicUnavailableDateRecords: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/clinic-unavailable-dates.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/clinic-unavailable-dates.repository")>();
  return { ...actual, listClinicOptions, listClinicUnavailableDateRecords };
});

import ClinicUnavailableDatesPage from "./page";

const clinics = [{ id: "60000000-0000-4000-8000-000000000001", name: "KABALAKA Clinic" }];
const unavailableDates: ClinicUnavailableDateRecord[] = [{
  id: "unavailable-1",
  clinicId: clinics[0].id,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: clinics[0].name,
  startDate: "2026-08-19",
  endDate: "2026-08-19",
  category: "MAINTENANCE",
  reason: "Generator testing",
  createdByName: "Clinic Admin",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000000Z",
}];

describe("ClinicUnavailableDatesPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T04:00:00.000Z"));
    requireUser.mockResolvedValue({ userId: "admin-id", role: "ADMIN" });
    listClinicOptions.mockResolvedValue(clinics);
    listClinicUnavailableDateRecords.mockResolvedValue(unavailableDates);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes Manila's current month, clinics, and unavailable records to the calendar", async () => {
    render(await ClinicUnavailableDatesPage());

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listClinicOptions).toHaveBeenCalledOnce();
    expect(listClinicUnavailableDateRecords).toHaveBeenCalledOnce();
    expect(screen.getByText(
      "Configure clinic availability before imports, review all changes, and save once.",
    )).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getByLabelText("Year")).toHaveValue("2026");
    expect(screen.getByRole("option", { name: "2100" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "KABALAKA Clinic" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /September 1, 2026/ })).not.toBeInTheDocument();
    const unavailableDate = screen.getByRole("button", {
      name: "August 19, 2026 — blocked: Maintenance, Generator testing",
    });
    expect(unavailableDate).toBeEnabled();
  });
});
