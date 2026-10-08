import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { appointmentDetail, getPublishedAppointment, loadLaboratoryChecklist, loadPhysicalExamCompletionContext } = vi.hoisted(() => ({
  appointmentDetail: vi.fn(() => null),
  getPublishedAppointment: vi.fn(), loadLaboratoryChecklist: vi.fn(), loadPhysicalExamCompletionContext: vi.fn(),
}));

vi.mock("@/components/appointments/AppointmentDetail", () => ({
  AppointmentDetail: appointmentDetail,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: () => { throw new Error("not found"); } }));
vi.mock("@/server/auth/current-user", () => ({ requireUser: async () => ({ role: "CLINIC_STAFF", clinicId: "cpu" }) }));
vi.mock("@/server/db/pool", () => ({ transaction: async (fn: (client: unknown) => unknown) => fn({}) }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getPublishedAppointment }));
vi.mock("@/server/laboratory/laboratory-checklist.repository", () => ({ loadLaboratoryChecklist }));
vi.mock("@/server/medical-certificates/physical-exam-completion-context.service", () => ({ loadPhysicalExamCompletionContext }));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ issuedCertificateForAppointment: async () => null, certificateHistoryForAppointment: async () => [] }));
vi.mock("@/server/medical-certificates/physician.service", () => ({ listPhysicians: async () => [] }));
vi.mock("@/components/appointments/AppointmentActions", () => ({ AppointmentActions: () => null }));
vi.mock("@/components/appointments/AppointmentProtectionPanel", () => ({ AppointmentProtectionPanel: () => null }));

import PhysicalExamAppointmentPage from "./page";

describe("PhysicalExamAppointmentPage", () => {
  it.each(["FOURTH_YEAR_OJT", "FIRST_YEAR_EXTERNAL"] as const)("renders eligible %s detail with a wholly read-only paired checklist", async (mode) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const policy = { mode, manualTestCodes: mode === "FOURTH_YEAR_OJT" ? ["CBC", "URINE", "STOOL"] : [],
      peConfirmedTestCodes: mode === "FOURTH_YEAR_OJT" ? ["XRAY"] : ["CBC", "URINE", "STOOL", "XRAY"], externalProvider: "Iloilo Mission Hospital" };
    getPublishedAppointment.mockResolvedValue({ id, studentName: "Student", studentNumber: "S1", scheduleType: "PHYSICAL_EXAM",
      clinicId: "cpu", status: "PENDING", appointmentDate: "2026-10-08", isOvpsaFirstYear: mode === "FIRST_YEAR_EXTERNAL",
      pairedLaboratoryAppointmentId: "lab", statusLogs: [], updatedAt: new Date() });
    loadLaboratoryChecklist.mockResolvedValue({ checklistId: "checklist", appointmentId: "lab", appointmentStatus: "PENDING", version: 4,
      totalCount: 4, verifiedCount: mode === "FOURTH_YEAR_OJT" ? 3 : 0, completionPolicy: policy,
      items: ["CBC", "URINE", "STOOL", "XRAY"].map((testCode) => ({ testCode,
        verifiedAt: mode === "FOURTH_YEAR_OJT" && testCode !== "XRAY" ? new Date() : null, verifiedBy: null, verificationSource: null })) });
    loadPhysicalExamCompletionContext.mockResolvedValue({ appointmentId: id, studentName: "Student", studentNumber: "S1",
      appointmentDate: "2026-10-08", scheduleCycleStart: 2026, dateOfBirth: "2005-01-01",
      studentAcademicSnapshot: { studentName: "Student", collegeName: "College", programName: "Program", yearLevel: mode === "FOURTH_YEAR_OJT" ? 4 : 1 },
      physicians: [{ id: "physician", version: 1, displayName: "Dr Test", licenseNumber: "123", specialty: null }], blockers: [],
      laboratoryCompletion: { laboratoryAppointmentId: "lab", laboratoryCompleted: false, readyForPe: true, missingManualTestCodes: [], completionPolicy: policy } });
    const { AppointmentDetail } = await vi.importActual<typeof import("@/components/appointments/AppointmentDetail")>("@/components/appointments/AppointmentDetail");
    render(await AppointmentDetail({ appointmentId: id, expectedScheduleType: "PHYSICAL_EXAM", source: "PHYSICAL_EXAM" }));
    for (const box of screen.getAllByRole("checkbox").filter((box) => !box.hasAttribute("required"))) expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    expect(screen.queryByText(/one test at a time/)).not.toBeInTheDocument();
  });

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
