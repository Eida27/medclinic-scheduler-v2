// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getPublishedAppointment, updateAppointment } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getPublishedAppointment: vi.fn(),
  updateAppointment: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));
vi.mock("@/server/services/appointments.service", () => ({ updateAppointment }));

import { GET, PATCH } from "./route";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ appointmentId }) };
const clinicStaff = {
  userId: "staff-user",
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF" as const,
  clinicId: "60000000-0000-4000-8000-000000000001",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
};

describe("/api/appointments/[appointmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(clinicStaff);
    getPublishedAppointment.mockResolvedValue({ id: appointmentId, isPublished: true });
    updateAppointment.mockResolvedValue({ id: appointmentId, status: "COMPLETED" });
  });

  it("loads normal appointment detail through the published-only repository path", async () => {
    const response = await GET(
      new Request(`http://localhost/api/appointments/${appointmentId}`),
      context,
    );

    expect(response.status).toBe(200);
    expect(getPublishedAppointment).toHaveBeenCalledWith(appointmentId);
  });

  it("returns not found when the published-only detail path cannot see the ID", async () => {
    getPublishedAppointment.mockResolvedValue(null);

    const response = await GET(
      new Request(`http://localhost/api/appointments/${appointmentId}`),
      context,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "APPOINTMENT_NOT_FOUND",
        message: "Appointment not found.",
      },
    });
  });

  it("restricts PATCH to appointment operators and passes the full session to the service", async () => {
    const response = await PATCH(new Request(
      `http://localhost/api/appointments/${appointmentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      },
    ), context);

    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(updateAppointment).toHaveBeenCalledWith(
      appointmentId,
      { status: "COMPLETED" },
      clinicStaff,
    );
  });
});
