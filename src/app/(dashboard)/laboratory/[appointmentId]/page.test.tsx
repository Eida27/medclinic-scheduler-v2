import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { appointmentDetail } = vi.hoisted(() => ({
  appointmentDetail: vi.fn(() => null),
}));

vi.mock("@/components/appointments/AppointmentDetail", () => ({
  AppointmentDetail: appointmentDetail,
}));

import LaboratoryAppointmentPage from "./page";

describe("LaboratoryAppointmentPage", () => {
  it("renders the shared detail in laboratory context", async () => {
    render(await LaboratoryAppointmentPage({
      params: Promise.resolve({ appointmentId: "appointment-1" }),
    }));

    expect(appointmentDetail).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: "appointment-1",
      expectedScheduleType: "LABORATORY",
      source: "LABORATORY",
    }), undefined);
  });
});
