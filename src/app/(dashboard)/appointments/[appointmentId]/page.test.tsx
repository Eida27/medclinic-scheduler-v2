import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";

const { appointmentActions, appointmentDetail, appointmentProtectionPanel, completedStatusCorrection, getPublishedAppointment, notFound, redirect, requireUser } = vi.hoisted(() => ({
  appointmentActions: vi.fn(() => null),
  appointmentDetail: vi.fn(() => null),
  appointmentProtectionPanel: vi.fn(() => null),
  completedStatusCorrection: vi.fn(() => null),
  getPublishedAppointment: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  requireUser: vi.fn(),
}));

vi.mock("@/components/appointments/AppointmentDetail", () => ({
  AppointmentDetail: appointmentDetail,
}));
vi.mock("@/components/appointments/AppointmentActions", () => ({
  AppointmentActions: appointmentActions,
}));
vi.mock("@/components/appointments/AppointmentProtectionPanel", () => ({
  AppointmentProtectionPanel: appointmentProtectionPanel,
}));
vi.mock("@/components/appointments/CompletedStatusCorrection", () => ({
  CompletedStatusCorrection: completedStatusCorrection,
}));
vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));

import AppointmentPage from "./page";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const missingAppointmentId = "22222222-2222-4222-8222-222222222222";

describe("AppointmentPage", () => {
  it("delegates rendering to the shared appointment detail", async () => {
    render(await AppointmentPage({ params: Promise.resolve({ appointmentId }) }));

    expect(appointmentDetail).toHaveBeenCalledWith({
      appointmentId,
      source: "APPOINTMENTS",
    }, undefined);
  });
});

const publishedAppointment = {
  id: appointmentId,
  studentNumber: "2026-0001",
  studentName: "Santos, Ana Maria Angela (Jr.)",
  scheduleType: "LABORATORY",
  clinicId: "clinic-1",
  appointmentDate: "2026-08-18",
  status: "PENDING",
  isManuallyLocked: true,
  lockReason: "Administrator review",
  lockedById: "admin-1",
  lockedByName: "System Admin",
  lockedAt: new Date("2026-08-01T02:30:00.000Z"),
  updatedAt: new Date("2026-08-01T03:00:00.000Z"),
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

  it("returns not found for a non-UUID path segment without querying appointments", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: "coordinator-schedules",
      source: "LABORATORY",
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(requireUser).not.toHaveBeenCalled();
    expect(getPublishedAppointment).not.toHaveBeenCalled();
  });

  it("renders a published appointment after enforcing the allowed roles", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(getPublishedAppointment).toHaveBeenCalledWith(appointmentId);
    expect(screen.getByRole("heading", { level: 1, name: "Santos, Ana Maria Angela (Jr.)" })).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
    expect(appointmentProtectionPanel).toHaveBeenCalledWith({
      appointmentId,
      status: "PENDING",
      isManuallyLocked: true,
      lockReason: "Administrator review",
      lockedByName: "System Admin",
      lockedAt: "2026-08-01T02:30:00.000Z",
      updatedAt: "2026-08-01T03:00:00.000Z",
      canManage: false,
    }, undefined);
  });

  it("marks a tombstoned staff member in the appointment status history", async () => {
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      statusLogs: [{
        ...publishedAppointment.statusLogs[0],
        changedBy: { fullName: "Former Administrator", role: "ADMIN", deleted: true },
      }],
    });
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(screen.getByText(/Former Administrator/)).toBeVisible();
    expect(screen.getByText("Deleted")).toBeVisible();
  });

  it("returns not found when the published-only loader cannot find the appointment", async () => {
    getPublishedAppointment.mockResolvedValue(null);
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId: missingAppointmentId,
      source: "APPOINTMENTS",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPublishedAppointment).toHaveBeenCalledWith(missingAppointmentId);
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

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(screen.getByText("No-show")).toBeVisible();
    expect(screen.getByText("Pending → No-show")).toBeVisible();
    expect(screen.queryByText("NO_SHOW")).not.toBeInTheDocument();
    expect(appointmentActions).toHaveBeenCalledWith({
      id: appointmentId,
      status: "NO_SHOW",
      canCorrectNoShow: true,
      isManuallyLocked: true,
      updatedAt: "2026-08-01T03:00:00.000Z",
      basePath: "/laboratory",
    }, undefined);
  });

  it("renders the separate completed correction with date and route source", async () => {
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment,
      status: "COMPLETED",
    });
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(completedStatusCorrection).toHaveBeenCalledWith({
      appointmentId,
      appointmentDate: "2026-08-18",
      source: "LABORATORY",
    }, undefined);
  });

  it("does not render completed correction for an ordinary pending appointment", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(completedStatusCorrection).not.toHaveBeenCalled();
  });

  it("returns not found when a laboratory appointment is opened from the physical exam route", async () => {
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId,
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
      appointmentId,
      expectedScheduleType: "LABORATORY",
      source: "LABORATORY",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("returns not found when clinic staff belongs to another clinic", async () => {
    requireUser.mockResolvedValue({ role: "CLINIC_STAFF", clinicId: "clinic-2" });
    const AppointmentDetail = await getActualAppointmentDetail();

    await expect(AppointmentDetail({
      appointmentId,
      source: "LABORATORY",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("allows an administrator to view an appointment from any clinic", async () => {
    requireUser.mockResolvedValue({ role: "ADMIN", clinicId: null });
    const AppointmentDetail = await getActualAppointmentDetail();

    render(await AppointmentDetail({ appointmentId, source: "LABORATORY" }));

    expect(screen.getByRole("heading", { level: 1, name: "Santos, Ana Maria Angela (Jr.)" })).toBeVisible();
    expect(notFound).not.toHaveBeenCalled();
    expect(appointmentProtectionPanel).toHaveBeenCalledWith(
      expect.objectContaining({ canManage: true }),
      undefined,
    );
  });

  it.each([
    ["CLINIC_STAFF", "LABORATORY", "clinic-1", `/laboratory/${appointmentId}`],
    ["CLINIC_STAFF", "PHYSICAL_EXAM", "clinic-2", `/physical-exam/${appointmentId}`],
    ["ADMIN", "LABORATORY", null, `/laboratory/${appointmentId}`],
    ["ADMIN", "PHYSICAL_EXAM", null, `/physical-exam/${appointmentId}`],
  ] as const)(
    "redirects %s legacy %s detail access into its operational clinic flow",
    async (role, scheduleType, clinicId, target) => {
      requireUser.mockResolvedValue({ role, clinicId });
      getPublishedAppointment.mockResolvedValue({
        ...publishedAppointment,
        scheduleType,
        clinicId: scheduleType === "LABORATORY" ? "clinic-1" : "clinic-2",
      });
      const AppointmentDetail = await getActualAppointmentDetail();

      await expect(AppointmentDetail({
        appointmentId,
        source: "APPOINTMENTS",
      })).rejects.toThrow("NEXT_REDIRECT");

      expect(redirect).toHaveBeenCalledWith(target);
      expect(appointmentActions).not.toHaveBeenCalled();
    },
  );
});
