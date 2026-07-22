import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";

const { appointmentActions, appointmentDetail, completedStatusCorrection, getPublishedAppointment, notFound, requireUser } = vi.hoisted(() => ({
  appointmentActions: vi.fn(() => null),
  appointmentDetail: vi.fn(() => null),
  completedStatusCorrection: vi.fn(() => null),
  getPublishedAppointment: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  requireUser: vi.fn(),
}));

vi.mock("@/components/appointments/AppointmentDetail", () => ({
  AppointmentDetail: appointmentDetail,
}));
vi.mock("@/components/appointments/AppointmentActions", () => ({
  AppointmentActions: appointmentActions,
}));
vi.mock("@/components/appointments/CompletedStatusCorrection", () => ({
  CompletedStatusCorrection: completedStatusCorrection,
}));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));

import AppointmentPage from "./page";

describe("AppointmentPage", () => {
  it("delegates rendering to the shared appointment detail", async () => {
    render(await AppointmentPage({ params: Promise.resolve({ appointmentId: "appointment-1" }) }));

    expect(appointmentDetail).toHaveBeenCalledWith({
      appointmentId: "appointment-1",
      source: "APPOINTMENTS",
    }, undefined);
  });
});

const publishedAppointment = {
  id: "appointment-1",
  studentNumber: "2026-0001",
  studentName: "Santos, Ana M. (Jr.)",
  scheduleType: "LABORATORY",
  clinicId: "clinic-1",
  appointmentDate: "2026-08-18",
  status: "PENDING",
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

async function getActualAppointmentDetail() {
  const appointmentDetailModule = await vi.importActual<typeof import("@/components/appointments/AppointmentDetail")>(
    "@/components/appointments/AppointmentDetail",
  );
  return appointmentDetailModule.AppointmentDetail;
}

describe("AppointmentDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ role: "CLINIC_STAFF", clinicId: "clinic-1" });
    getPublishedAppointment.mockResolvedValue(publishedAppointment);
  });

  it("renders a published appointment after enforcing the allowed roles", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId: "appointment-1", source: "APPOINTMENTS" }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(getPublishedAppointment).toHaveBeenCalledWith("appointment-1");
    expect(screen.getByRole("heading", { level: 1, name: "Santos, Ana M. (Jr.)" })).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
  });

  it("returns not found when the published-only loader cannot find the appointment", async () => {
    getPublishedAppointment.mockResolvedValue(null);
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: "draft-appointment",
      source: "APPOINTMENTS",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("enables correction when the latest status log is an automatic no-show", async () => {
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
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId: "appointment-1", source: "APPOINTMENTS" }));

    expect(appointmentActions).toHaveBeenCalledWith({
      id: "appointment-1",
      status: "NO_SHOW",
      canCorrectNoShow: true,
    }, undefined);
  });

  it("renders the separate completed correction with date and route source", async () => {
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      status: "COMPLETED",
    });
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId: "appointment-1", source: "LABORATORY" }));

    expect(completedStatusCorrection).toHaveBeenCalledWith({
      appointmentId: "appointment-1",
      appointmentDate: "2026-08-18",
      source: "LABORATORY",
    }, undefined);
  });

  it("does not render completed correction for an ordinary pending appointment", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId: "appointment-1", source: "APPOINTMENTS" }));

    expect(completedStatusCorrection).not.toHaveBeenCalled();
  });

  it("returns not found when a laboratory appointment is opened from the physical exam route", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: "appointment-1",
      expectedScheduleType: "PHYSICAL_EXAM",
      source: "PHYSICAL_EXAM",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("returns not found when a physical exam appointment is opened from the laboratory route", async () => {
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      scheduleType: "PHYSICAL_EXAM",
    });
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: "appointment-1",
      expectedScheduleType: "LABORATORY",
      source: "LABORATORY",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("returns not found when clinic staff belongs to another clinic", async () => {
    requireUser.mockResolvedValue({ role: "CLINIC_STAFF", clinicId: "clinic-2" });
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: "appointment-1",
      source: "LABORATORY",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("allows an administrator to view an appointment from any clinic", async () => {
    requireUser.mockResolvedValue({ role: "ADMIN", clinicId: null });
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId: "appointment-1", source: "APPOINTMENTS" }));

    expect(screen.getByRole("heading", { level: 1, name: "Santos, Ana M. (Jr.)" })).toBeVisible();
    expect(notFound).not.toHaveBeenCalled();
  });
});
