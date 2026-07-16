import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";

const { appointmentActions, getPublishedAppointment, notFound, requireUser } = vi.hoisted(() => ({
  appointmentActions: vi.fn(() => null),
  getPublishedAppointment: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));
vi.mock("@/components/appointments/AppointmentActions", () => ({
  AppointmentActions: appointmentActions,
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
    changedById: "admin-1",
    changedByName: "System Admin",
    createdAt: new Date("2026-08-01T08:00:00.000Z"),
  }],
};

describe("AppointmentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({
      userId: "staff-1",
      fullName: "Clinic Staff",
      email: "staff@medclinic.local",
      role: "CLINIC_STAFF",
      clinicId: "clinic-1",
      clinicCode: "KABALAKA_CLINIC",
      clinicName: "KABALAKA Clinic",
    });
    getPublishedAppointment.mockResolvedValue(publishedAppointment);
  });

  it("loads normal detail through the published-only loader and never calls it an internal draft", async () => {
    render(await AppointmentPage({ params: Promise.resolve({ appointmentId: "appointment-1" }) }));

    expect(getPublishedAppointment).toHaveBeenCalledWith("appointment-1");
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(screen.getByRole("heading", { level: 1, name: "Ana Maria Santos Jr." })).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.queryByText("Internal draft")).not.toBeInTheDocument();
    expect(screen.getByText("System Admin · Aug 1, 2026, 4:00 PM")).toBeVisible();
  });

  it("enables correction when the latest log is automatic and staff belongs to the clinic", async () => {
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      status: "NO_SHOW",
      statusLogs: [{
        id: "automatic-log",
        oldStatus: "PENDING",
        newStatus: "NO_SHOW",
        notes: AUTOMATIC_NO_SHOW_NOTE,
        changedById: null,
        changedByName: null,
        createdAt: new Date("2026-08-19T08:00:00.000Z"),
      }],
    });

    render(await AppointmentPage({ params: Promise.resolve({ appointmentId: "appointment-1" }) }));

    expect(appointmentActions).toHaveBeenCalledWith({
      id: "appointment-1",
      status: "NO_SHOW",
      canCorrectNoShow: true,
    }, undefined);
  });

  it("does not enable correction for staff assigned to another clinic", async () => {
    requireUser.mockResolvedValue({
      userId: "staff-1",
      fullName: "Clinic Staff",
      email: "staff@medclinic.local",
      role: "CLINIC_STAFF",
      clinicId: "other-clinic",
      clinicCode: "CPU_CLINIC",
      clinicName: "CPU Clinic",
    });
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      status: "NO_SHOW",
      statusLogs: [{
        id: "automatic-log",
        oldStatus: "PENDING",
        newStatus: "NO_SHOW",
        notes: AUTOMATIC_NO_SHOW_NOTE,
        changedById: null,
        changedByName: null,
        createdAt: new Date("2026-08-19T08:00:00.000Z"),
      }],
    });

    render(await AppointmentPage({ params: Promise.resolve({ appointmentId: "appointment-1" }) }));

    expect(appointmentActions).toHaveBeenCalledWith(expect.objectContaining({
      canCorrectNoShow: false,
    }), undefined);
  });

  it("returns not found when the published-only loader cannot find the appointment", async () => {
    getPublishedAppointment.mockResolvedValue(null);

    await expect(AppointmentPage({
      params: Promise.resolve({ appointmentId: "draft-appointment" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });
});
