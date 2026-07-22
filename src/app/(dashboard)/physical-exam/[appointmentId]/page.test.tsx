import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { appointmentDetail } = vi.hoisted(() => ({
  appointmentDetail: vi.fn(() => null),
}));

vi.mock("@/components/appointments/AppointmentDetail", () => ({
  AppointmentDetail: appointmentDetail,
}));

import PhysicalExamAppointmentPage from "./page";

describe("PhysicalExamAppointmentPage", () => {
  it("renders the shared detail in physical exam context", async () => {
    render(await PhysicalExamAppointmentPage({
      params: Promise.resolve({ appointmentId: "appointment-1" }),
    }));

    expect(appointmentDetail).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: "appointment-1",
      expectedScheduleType: "PHYSICAL_EXAM",
      source: "PHYSICAL_EXAM",
    }), undefined);
  });
});
