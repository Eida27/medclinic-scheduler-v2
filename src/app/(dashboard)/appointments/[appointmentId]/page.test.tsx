import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPublishedAppointment, notFound } = vi.hoisted(() => ({
  getPublishedAppointment: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));
vi.mock("@/components/appointments/AppointmentActions", () => ({
  AppointmentActions: () => <div />,
}));

import AppointmentPage from "./page";

const publishedAppointment = {
  id: "appointment-1",
  batchId: "batch-1",
  studentNumber: "2026-0001",
  studentName: "Ana Maria Santos Jr.",
  scheduleType: "LABORATORY",
  clinicId: "clinic-1",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
  appointmentDate: "2026-08-18",
  appointmentTime: "09:30:00",
  status: "PENDING",
  isPublished: true,
  notes: null,
  rescheduledFrom: null,
  collegeName: "College of Computer Studies",
  programName: "BSIT",
  statusLogs: [{
    id: "log-1",
    oldStatus: "DRAFT",
    newStatus: "PENDING",
    notes: null,
    changedByName: "System Admin",
    createdAt: new Date("2026-08-01T08:00:00.000Z"),
  }],
};

describe("AppointmentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublishedAppointment.mockResolvedValue(publishedAppointment);
  });

  it("loads normal detail through the published-only loader and never calls it an internal draft", async () => {
    render(await AppointmentPage({ params: Promise.resolve({ appointmentId: "appointment-1" }) }));

    expect(getPublishedAppointment).toHaveBeenCalledWith("appointment-1");
    expect(screen.getByRole("heading", { level: 1, name: "Ana Maria Santos Jr." })).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.queryByText("Internal draft")).not.toBeInTheDocument();
    expect(screen.getByText("System Admin · Aug 1, 2026, 4:00 PM")).toBeVisible();
  });

  it("returns not found when the published-only loader cannot find the appointment", async () => {
    getPublishedAppointment.mockResolvedValue(null);

    await expect(AppointmentPage({
      params: Promise.resolve({ appointmentId: "draft-appointment" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });
});
