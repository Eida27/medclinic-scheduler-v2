import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import type { SessionUser } from "@/types/roles";

const {
  changeAppointmentStatus,
  changeAppointmentStatusWithClient,
  getAppointmentMutationContext,
  getPublishedAppointment,
  publishBatch,
  rescheduleAppointment,
  transaction,
  updateCapacitySetting,
  writeAudit,
} = vi.hoisted(() => ({
  changeAppointmentStatus: vi.fn(),
  changeAppointmentStatusWithClient: vi.fn(),
  getAppointmentMutationContext: vi.fn(),
  getPublishedAppointment: vi.fn(),
  publishBatch: vi.fn(),
  rescheduleAppointment: vi.fn(),
  transaction: vi.fn(),
  updateCapacitySetting: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/db/pool", () => ({ transaction }));
vi.mock("@/server/repositories/audit.repository", () => ({ writeAudit }));
vi.mock("@/server/repositories/appointments.repository", () => ({
  changeAppointmentStatus,
  changeAppointmentStatusWithClient,
  getAppointmentMutationContext,
  getPublishedAppointment,
  publishBatch,
  rescheduleAppointment,
  updateCapacitySetting,
}));
vi.mock("@/server/repositories/coordinator-schedules.repository", () => ({
  getScheduleBatch: vi.fn(),
}));

import { assertStatusTransition, updateAppointment } from "./appointments.service";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const laboratoryClinicId = "60000000-0000-4000-8000-000000000001";
const physicalExamClinicId = "60000000-0000-4000-8000-000000000002";
const client = { query: vi.fn() } as unknown as PoolClient;

const admin = {
  userId: "00000000-0000-4000-8000-000000000001",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

const laboratoryStaff = {
  userId: "00000000-0000-4000-8000-000000000002",
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: laboratoryClinicId,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
} satisfies SessionUser;

const coordinator = {
  userId: "00000000-0000-4000-8000-000000000003",
  fullName: "Schedule Coordinator",
  email: "coordinator@medclinic.local",
  role: "COORDINATOR",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

function publishedAppointment(status: "PENDING" | "NO_SHOW" = "PENDING", clinicId = laboratoryClinicId) {
  return {
    id: appointmentId,
    batchId: null,
    studentNumber: "2026-0001",
    studentName: "Appointment Fixture",
    scheduleType: "LABORATORY",
    clinicId,
    clinicCode: clinicId === laboratoryClinicId ? "KABALAKA_CLINIC" : "CPU_CLINIC",
    clinicName: clinicId === laboratoryClinicId ? "KABALAKA Clinic" : "CPU Clinic",
    appointmentDate: "2026-08-18",
    appointmentTime: "09:00:00",
    status,
    isPublished: true,
    notes: null,
    rescheduledFrom: null,
    collegeName: "College of Computer Studies",
    programName: "BSIT",
    statusLogs: [],
  };
}

function mutationContext(
  status: "PENDING" | "NO_SHOW" = "PENDING",
  clinicId = laboratoryClinicId,
  latestLog: {
    oldStatus: string | null;
    newStatus: string;
    notes: string | null;
    changedById: string | null;
  } | null = null,
) {
  return {
    id: appointmentId,
    status,
    clinicId,
    clinicCode: clinicId === laboratoryClinicId ? "KABALAKA_CLINIC" : "CPU_CLINIC",
    latestLog,
  };
}

const automaticNoShowLog = {
  oldStatus: "PENDING",
  newStatus: "NO_SHOW",
  notes: AUTOMATIC_NO_SHOW_NOTE,
  changedById: null,
};

describe("appointment status transitions", () => {
  it.each([
    ["DRAFT", "PENDING"],
    ["PENDING", "COMPLETED"],
    ["PENDING", "NO_SHOW"],
    ["PENDING", "CANCELLED"],
  ] as const)("allows %s to become %s", (from, to) => {
    expect(() => assertStatusTransition(from, to)).not.toThrow();
  });

  it("rejects reopening a completed appointment", () => {
    expect(() => assertStatusTransition("COMPLETED", "PENDING")).toThrow();
  });
});

describe("appointment mutation authorization and automatic no-show correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublishedAppointment.mockResolvedValue(publishedAppointment());
    getAppointmentMutationContext.mockResolvedValue(mutationContext());
    changeAppointmentStatusWithClient.mockResolvedValue(undefined);
    writeAudit.mockResolvedValue(undefined);
    transaction.mockImplementation(async (callback: (transactionClient: PoolClient) => Promise<unknown>) => (
      callback(client)
    ));
  });

  it("completes a pending appointment and audits the change in the same transaction", async () => {
    await updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Visit completed",
    }, admin);

    expect(transaction).toHaveBeenCalledOnce();
    expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
      client,
      appointmentId,
      "PENDING",
      "COMPLETED",
      "Visit completed",
      admin.userId,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      admin.userId,
      "APPOINTMENT_STATUS_CHANGED",
      "appointment",
      appointmentId,
      {
        oldStatus: "PENDING",
        newStatus: "COMPLETED",
        reason: "Visit completed",
        source: "APPOINTMENT_DETAIL",
      },
      client,
    );
  });

  it("lets an administrator correct a canonical automatic no-show when a reason is supplied", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("NO_SHOW"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      "NO_SHOW",
      laboratoryClinicId,
      automaticNoShowLog,
    ));

    await updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Signed clinic record confirms completion",
    }, admin);

    expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
      client,
      appointmentId,
      "NO_SHOW",
      "COMPLETED",
      "Signed clinic record confirms completion",
      admin.userId,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      admin.userId,
      "APPOINTMENT_STATUS_CORRECTED",
      "appointment",
      appointmentId,
      {
        oldStatus: "NO_SHOW",
        newStatus: "COMPLETED",
        reason: "Signed clinic record confirms completion",
        source: "APPOINTMENT_DETAIL",
      },
      client,
    );
  });

  it("lets same-clinic staff correct a canonical automatic no-show", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("NO_SHOW"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      "NO_SHOW",
      laboratoryClinicId,
      automaticNoShowLog,
    ));

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Verified in the laboratory register",
    }, laboratoryStaff)).resolves.toBeDefined();

    expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
      client,
      appointmentId,
      "NO_SHOW",
      "COMPLETED",
      "Verified in the laboratory register",
      laboratoryStaff.userId,
    );
  });

  it.each([
    ["missing", { status: "COMPLETED" }],
    ["empty", { status: "COMPLETED", notes: "" }],
    ["blank", { status: "COMPLETED", notes: "   " }],
  ])("requires a non-blank correction reason when it is %s", async (_, input) => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("NO_SHOW"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      "NO_SHOW",
      laboratoryClinicId,
      automaticNoShowLog,
    ));

    await expect(updateAppointment(appointmentId, input, admin)).rejects.toMatchObject({
      code: "CORRECTION_REASON_REQUIRED",
      status: 422,
    });
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects correction when the canonical latest log is a manual no-show", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("NO_SHOW"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      "NO_SHOW",
      laboratoryClinicId,
      { ...automaticNoShowLog, notes: "Marked manually", changedById: admin.userId },
    ));

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Attempted correction",
    }, admin)).rejects.toMatchObject({
      code: "NO_SHOW_CORRECTION_NOT_ALLOWED",
      status: 422,
    });
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
  });

  it("rejects cross-clinic staff before changing an automatic no-show", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("NO_SHOW", physicalExamClinicId));
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      "NO_SHOW",
      physicalExamClinicId,
      automaticNoShowLog,
    ));

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Attempted cross-clinic correction",
    }, laboratoryStaff)).rejects.toMatchObject({
      code: "CLINIC_ACCESS_DENIED",
      status: 403,
    });
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
  });

  it.each([
    { status: "CANCELLED", notes: "Coordinator status mutation" },
    { appointmentDate: "2026-08-19", appointmentTime: "10:00", notes: "Coordinator reschedule" },
  ])("rejects every coordinator mutation before writing (%o)", async (input) => {
    await expect(updateAppointment(appointmentId, input, coordinator)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(changeAppointmentStatus).not.toHaveBeenCalled();
    expect(rescheduleAppointment).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
