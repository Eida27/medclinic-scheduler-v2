import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAppointments } = vi.hoisted(() => ({ listAppointments: vi.fn() }));

vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));

import AppointmentsPage from "./page";

describe("AppointmentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAppointments.mockResolvedValue({ items: [], total: 0 });
  });

  it("ignores visibility attempts and renders published appointment filters and empty state", async () => {
    render(await AppointmentsPage({
      searchParams: Promise.resolve({
        studentNumber: "Maria Cruz",
        appointmentDate: "2026-08-20",
        scheduleType: "PHYSICAL_EXAM",
        status: "PENDING",
        isPublished: "false",
      }),
    }));

    expect(listAppointments).toHaveBeenCalledWith({
      appointmentDate: "2026-08-20",
      scheduleType: "PHYSICAL_EXAM",
      status: "PENDING",
      studentNumber: "Maria Cruz",
      isPublished: true,
      page: 1,
      limit: 100,
      offset: 0,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Published appointments" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Student name or number" })).toHaveValue("Maria Cruz");
    expect(screen.getByLabelText("Appointment date")).toHaveValue("2026-08-20");
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveValue("PHYSICAL_EXAM");

    const status = screen.getByRole("combobox", { name: "Status" });
    expect(status).toHaveValue("PENDING");
    expect(within(status).queryByRole("option", { name: "DRAFT" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /visibility/i })).not.toBeInTheDocument();
    expect(screen.getByText("No published appointments match these filters.")).toBeVisible();
  });
});
