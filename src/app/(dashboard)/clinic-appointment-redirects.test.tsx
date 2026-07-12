import { describe, expect, it, vi } from "vitest";

const { assertClinicAccess, listAppointments, redirect, requireUser } = vi.hoisted(() => ({
  assertClinicAccess: vi.fn(),
  listAppointments: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  redirect: vi.fn(),
  requireUser: vi.fn().mockResolvedValue({
    userId: "staff-1",
    fullName: "Clinic Staff",
    email: "staff@example.com",
    role: "CLINIC_STAFF",
    clinicCode: "KABALAKA_CLINIC",
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/clinic-access", () => ({ assertClinicAccess }));
vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));

import LaboratoryAppointmentsPage from "./laboratory/appointments/page";
import PhysicalExamAppointmentsPage from "./physical-exam/appointments/page";

type LegacyPage = (props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) => unknown;

describe("clinic appointment aliases", () => {
  it("redirects the laboratory appointment alias to the laboratory schedule", async () => {
    await (LaboratoryAppointmentsPage as unknown as LegacyPage)({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith("/laboratory");
  });

  it("redirects the physical examination appointment alias to the physical examination schedule", async () => {
    await (PhysicalExamAppointmentsPage as unknown as LegacyPage)({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith("/physical-exam");
  });
});
