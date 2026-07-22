import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "KABALAKA Clinic" })).toBeInTheDocument();
    const unavailableDate = screen.getByRole("button", {
      name: "August 19, 2026 — unavailable: Maintenance, Generator testing",
    });
    expect(unavailableDate).toBeEnabled();

    fireEvent.click(unavailableDate);

    const details = screen.getByRole("region", { name: "Unavailable date details" });
    expect(unavailableDate).toHaveAttribute("aria-pressed", "true");
    expect(within(details).getByText("KABALAKA Clinic")).toBeInTheDocument();
    expect(within(details).getByText("Maintenance")).toBeInTheDocument();
    expect(within(details).getByText("Generator testing")).toBeInTheDocument();
    expect(within(details).getByText("August 19, 2026 to August 19, 2026")).toBeInTheDocument();
  });
});
