// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), query: vi.fn(), currentCpuActor: vi.fn(), listPhysicians: vi.fn(),
  getAppointmentMutationScope: vi.fn(), getAppointmentMutationContext: vi.fn(), getPublishedAppointment: vi.fn(),
  lockEffectiveAppointmentScopes: vi.fn(), loadPeLaboratoryCompletionPlan: vi.fn(),
}));
vi.mock("@/server/db/pool", () => ({ transaction: mocks.transaction }));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ currentCpuActor: mocks.currentCpuActor }));
vi.mock("@/server/medical-certificates/physician.service", () => ({ listPhysicians: mocks.listPhysicians }));
vi.mock("@/server/repositories/appointments.repository", () => ({
  getAppointmentMutationScope: mocks.getAppointmentMutationScope, getAppointmentMutationContext: mocks.getAppointmentMutationContext,
  getPublishedAppointment: mocks.getPublishedAppointment,
}));
vi.mock("@/server/repositories/effective-appointment-scope-lock.repository", () => ({ lockEffectiveAppointmentScopes: mocks.lockEffectiveAppointmentScopes }));
vi.mock("@/server/laboratory/pe-linked-laboratory.service", () => ({ loadPeLaboratoryCompletionPlan: mocks.loadPeLaboratoryCompletionPlan }));
import { loadPhysicalExamCompletionContext } from "./physical-exam-completion-context.service";
const actor = { userId: "actor", fullName: "CPU", email: "cpu@test.local", role: "CLINIC_STAFF" as const, clinicCode: "CPU_CLINIC" };
const policy = { mode: "FOURTH_YEAR_OJT", manualTestCodes: ["CBC", "URINE", "STOOL"], peConfirmedTestCodes: ["XRAY"], externalProvider: "Iloilo Mission Hospital" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((callback) => callback({ query: mocks.query }));
  mocks.query.mockResolvedValue({ rows: [{ closingDate: "2096-07-31" }] });
  mocks.currentCpuActor.mockResolvedValue({ cpuClinicId: "cpu", role: "CLINIC_STAFF", fullName: "CPU" });
  mocks.getAppointmentMutationScope.mockResolvedValue({ id: "pe", studentNumber: "student", scheduleType: "PHYSICAL_EXAM", clinicId: "cpu" });
  mocks.getAppointmentMutationContext.mockResolvedValue({ id: "pe", studentNumber: "student", scheduleType: "PHYSICAL_EXAM", clinicId: "cpu",
    isPublished: true, status: "PENDING", scheduleCycleStart: 2095, latestLog: null });
  mocks.loadPeLaboratoryCompletionPlan.mockResolvedValue({ laboratoryAppointmentId: "lab", laboratoryCompleted: false,
    readyForPe: true, missingManualTestCodes: [], completionPolicy: policy, fingerprint: "internal fingerprint", checklistVersionBefore: 4 });
  mocks.getPublishedAppointment.mockResolvedValue({ scheduleType: "PHYSICAL_EXAM", studentName: "Student", studentNumber: "student",
    appointmentDate: "2095-09-29", scheduleCycleStart: 2095, certificateStudentName: "Immutable Student",
    certificateCollegeName: "College", certificateProgramName: "Program", certificateYearLevel: 4, dateOfBirth: "2005-01-01" });
  mocks.listPhysicians.mockResolvedValue([{ id: "physician", version: 1, displayName: "Dr. Test", licenseNumber: "PRC", specialty: null,
    signatureBytes: Buffer.from("private signature") }]);
});

describe("shared PE readiness context", () => {
  it("reports ready OJT separately from persisted Laboratory completion without leaking private planner or signature data", async () => {
    const result = await loadPhysicalExamCompletionContext("pe", actor);
    expect(result.laboratoryReady).toBe(true);
    expect(result.laboratoryCompletion).toEqual({ laboratoryAppointmentId: "lab", laboratoryCompleted: false,
      readyForPe: true, missingManualTestCodes: [], completionPolicy: policy });
    expect(result.physicians).toEqual([{ id: "physician", version: 1, displayName: "Dr. Test", licenseNumber: "PRC", specialty: null }]);
    expect(mocks.lockEffectiveAppointmentScopes.mock.invocationCallOrder[0]).toBeLessThan(mocks.getAppointmentMutationContext.mock.invocationCallOrder[0]);
    expect(mocks.getAppointmentMutationContext.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadPeLaboratoryCompletionPlan.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls.every(([sql]) => String(sql).trimStart().startsWith("SELECT"))).toBe(true);
  });

  it("names the missing OJT manual tests in the form blockers", async () => {
    mocks.loadPeLaboratoryCompletionPlan.mockResolvedValueOnce({ laboratoryAppointmentId: "lab", laboratoryCompleted: false,
      readyForPe: false, missingManualTestCodes: ["CBC", "URINE"], completionPolicy: policy });
    const result = await loadPhysicalExamCompletionContext("pe", actor);
    expect(result.laboratoryReady).toBe(false);
    expect(result.blockers).toContain("Verify the missing Laboratory tests at KABALAKA before this examination: CBC, Urine.");
  });

  it("keeps current PE status and closed-cycle blockers even when external tests are ready", async () => {
    mocks.getAppointmentMutationContext.mockResolvedValueOnce({ id: "pe", studentNumber: "student", scheduleType: "PHYSICAL_EXAM", clinicId: "cpu",
      isPublished: true, status: "NO_SHOW", scheduleCycleStart: 2020, latestLog: { changedById: "manual-actor" } });
    mocks.query.mockResolvedValueOnce({ rows: [{ closingDate: "2021-07-31" }] });
    expect((await loadPhysicalExamCompletionContext("pe", actor)).blockers).toEqual([
      "This examination cannot be completed from its current status.", "This academic year has ended.",
    ]);
  });
});
