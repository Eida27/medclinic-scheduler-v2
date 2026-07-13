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
        page: "invalid",
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
      limit: 150,
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

  it("paginates appointments and preserves active filters in both navigation links", async () => {
    listAppointments.mockResolvedValue({
      items: [{
        id: "appointment-1",
        studentNumber: "23-8200-01",
        studentName: "Aaron Abad",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2026-07-30",
        status: "PENDING",
      }],
      total: 560,
    });

    render(await AppointmentsPage({
      searchParams: Promise.resolve({
        studentNumber: "Aaron",
        appointmentDate: "2026-07-30",
        scheduleType: "PHYSICAL_EXAM",
        status: "PENDING",
        page: "2",
      }),
    }));

    expect(listAppointments).toHaveBeenCalledWith({
      appointmentDate: "2026-07-30",
      scheduleType: "PHYSICAL_EXAM",
      status: "PENDING",
      studentNumber: "Aaron",
      isPublished: true,
      page: 2,
      limit: 150,
      offset: 150,
    });
    expect(screen.getByText("Page 2 of 4")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/appointments?studentNumber=Aaron&appointmentDate=2026-07-30&scheduleType=PHYSICAL_EXAM&status=PENDING&page=1",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/appointments?studentNumber=Aaron&appointmentDate=2026-07-30&scheduleType=PHYSICAL_EXAM&status=PENDING&page=3",
    );
  });

  it.each(["0", "-2", "1.5", "1e3", "Infinity"])(
    "normalizes the malformed page value %s to page one",
    async (page) => {
      render(await AppointmentsPage({ searchParams: Promise.resolve({ page }) }));

      expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({
        page: 1,
        limit: 150,
        offset: 0,
      }));
    },
  );
});
