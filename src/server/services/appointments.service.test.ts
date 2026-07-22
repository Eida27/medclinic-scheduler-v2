import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import type { SessionUser } from "@/types/roles";

const {
  changeAppointmentStatusWithClient,
  deletePendingResultPlaceholder,
  getAppointmentResultCorrectionState,
  getAppointmentMutationContext,
  getPublishedAppointment,
  publishBatch,
  rescheduleAppointmentWithClient,
  setAppointmentManualLockWithClient,
  transaction,
  updateCapacitySetting,
  writeAudit,
} = vi.hoisted(() => ({
  changeAppointmentStatusWithClient: vi.fn(),
  deletePendingResultPlaceholder: vi.fn(),
  getAppointmentResultCorrectionState: vi.fn(),
  getAppointmentMutationContext: vi.fn(),
  getPublishedAppointment: vi.fn(),
  publishBatch: vi.fn(),
  rescheduleAppointmentWithClient: vi.fn(),
  setAppointmentManualLockWithClient: vi.fn(),
  transaction: vi.fn(),
  updateCapacitySetting: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/db/pool", () => ({ transaction }));
vi.mock("@/server/repositories/audit.repository", () => ({ writeAudit }));
vi.mock("@/server/repositories/appointments.repository", () => ({
  changeAppointmentStatusWithClient,
  getAppointmentMutationContext,
  getPublishedAppointment,
  publishBatch,
  rescheduleAppointmentWithClient,
  setAppointmentManualLockWithClient,
  updateCapacitySetting,
}));
vi.mock("@/server/repositories/coordinator-schedules.repository", () => ({
  getScheduleBatch: vi.fn(),
}));
vi.mock("@/server/repositories/student-result-submissions.repository", () => ({
  deletePendingResultPlaceholder,
  ensurePendingUploadResult: vi.fn(),
  getAppointmentResultCorrectionState,
}));

import {
  assertStatusTransition,
  completeAppointmentWithClient,
  updateAppointment,
} from "./appointments.service";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const replacementId = "22222222-2222-4222-8222-222222222222";
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

function publishedAppointment(
  status: "PENDING" | "COMPLETED" | "NO_SHOW" = "PENDING",
  clinicId = laboratoryClinicId,
) {
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
    status,
    isPublished: true,
    schedulePairId: "33333333-3333-4333-8333-333333333333",
    scheduleCycleStart: 2026,
    isManuallyLocked: false,
    lockReason: null,
    notes: null,
    rescheduledFrom: null,
    collegeName: "College of Computer Studies",
    programName: "BSIT",
    statusLogs: [],
  };
}

function mutationContext(
  status: "PENDING" | "COMPLETED" | "NO_SHOW" = "PENDING",
  clinicId = laboratoryClinicId,
  latestLog: {
    oldStatus: string | null;
    newStatus: string;
    notes: string | null;
    changedById: string | null;
  } | null = null,
  appointmentDate = "2026-08-18",
) {
  return {
    id: appointmentId,
    batchId: null,
    studentNumber: "2026-0001",
    scheduleType: "LABORATORY",
    appointmentDate,
    status,
    clinicId,
    clinicCode: clinicId === laboratoryClinicId ? "KABALAKA_CLINIC" : "CPU_CLINIC",
    isPublished: true,
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
    ["PENDING", "CANCELLED"],
  ] as const)("allows %s to become %s", (from, to) => {
    expect(() => assertStatusTransition(from, to)).not.toThrow();
  });

  it("keeps completed-to-pending out of the ordinary transition path", () => {
    expect(() => assertStatusTransition("COMPLETED", "PENDING")).toThrow();
  });

  it("rejects manually changing a pending appointment to no-show", () => {
    expect(() => assertStatusTransition("PENDING", "NO_SHOW")).toThrow();
  });
});

describe("appointment mutation authorization and automatic no-show correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublishedAppointment.mockResolvedValue(publishedAppointment());
    getAppointmentMutationContext.mockResolvedValue(mutationContext());
    getAppointmentResultCorrectionState.mockResolvedValue({ type: "CLEAR" });
    changeAppointmentStatusWithClient.mockResolvedValue(undefined);
    deletePendingResultPlaceholder.mockResolvedValue(undefined);
    rescheduleAppointmentWithClient.mockResolvedValue(replacementId);
    writeAudit.mockResolvedValue(undefined);
    transaction.mockImplementation(async (callback: (transactionClient: PoolClient) => Promise<unknown>) => (
      callback(client)
    ));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["PENDING", admin] as const,
    ["NO_SHOW", laboratoryStaff] as const,
  ])("corrects a completed appointment to %s in the guarded audited order", async (target, actor) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T16:30:00.000Z"));
    const steps: string[] = [];
    const locked = mutationContext("COMPLETED", laboratoryClinicId, null, "2026-07-21");
    const placeholder = {
      type: "PENDING_PLACEHOLDER" as const,
      resultId: "44444444-4444-4444-8444-444444444444",
      table: "laboratory_results" as const,
    };
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockImplementation(async () => {
      steps.push("lock");
      return locked;
    });
    getAppointmentResultCorrectionState.mockImplementation(async () => {
      steps.push("inspect");
      return placeholder;
    });
    deletePendingResultPlaceholder.mockImplementation(async () => {
      steps.push("delete");
    });
    changeAppointmentStatusWithClient.mockImplementation(async () => {
      steps.push("change");
    });
    writeAudit.mockImplementation(async () => {
      steps.push("audit");
    });

    await updateAppointment(appointmentId, {
      status: target,
      correctionReason: "  Incorrect student selected  ",
      source: "LABORATORY",
    }, actor);

    expect(steps).toEqual(["lock", "inspect", "delete", "change", "audit"]);
    expect(getAppointmentMutationContext).toHaveBeenCalledWith(appointmentId, client);
    expect(getAppointmentResultCorrectionState).toHaveBeenCalledWith(client, locked);
    expect(deletePendingResultPlaceholder).toHaveBeenCalledWith(client, placeholder);
    expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
      client,
      appointmentId,
      "COMPLETED",
      target,
      "Incorrect student selected",
      actor.userId,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      actor.userId,
      "APPOINTMENT_STATUS_CORRECTED",
      "appointment",
      appointmentId,
      {
        oldStatus: "COMPLETED",
        newStatus: target,
        reason: "Incorrect student selected",
        source: "LABORATORY",
      },
      client,
    );
  });

  it.each([
    ["missing", { status: "PENDING" }],
    ["blank", { status: "PENDING", correctionReason: "   " }],
  ])("requires a correction reason when it is %s", async (_, input) => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

    await expect(updateAppointment(appointmentId, input, admin)).rejects.toMatchObject({
      code: "CORRECTION_REASON_REQUIRED",
      status: 422,
    });
    expect(getAppointmentMutationContext).toHaveBeenCalledWith(appointmentId, client);
    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a completed correction target outside pending and no-show", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      correctionReason: "Incorrect student selected",
      source: "LABORATORY",
    }, admin)).rejects.toMatchObject({ status: 422 });
    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ["today", "2026-07-22"],
    ["future", "2026-07-23"],
  ])("rejects a completed-to-no-show correction dated %s in Manila", async (_, appointmentDate) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T16:30:00.000Z"));
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(
      mutationContext("COMPLETED", laboratoryClinicId, null, appointmentDate),
    );

    await expect(updateAppointment(appointmentId, {
      status: "NO_SHOW",
      correctionReason: "Incorrect student selected",
      source: "LABORATORY",
    }, admin)).rejects.toMatchObject({
      code: "NO_SHOW_REQUIRES_PAST_DATE",
      status: 422,
    });
    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
  });

  it("protects completed result data from status correction", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));
    getAppointmentResultCorrectionState.mockResolvedValue({
      type: "PROTECTED",
      reason: "VERIFIED_RESULT",
    });

    await expect(updateAppointment(appointmentId, {
      status: "PENDING",
      correctionReason: "Incorrect student selected",
      source: "LABORATORY",
    }, admin)).rejects.toMatchObject({
      code: "APPOINTMENT_RESULT_PROTECTED",
      status: 409,
    });
    expect(deletePendingResultPlaceholder).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a completed correction when the locked status is stale", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("PENDING"));

    await expect(updateAppointment(appointmentId, {
      status: "PENDING",
      correctionReason: "Incorrect student selected",
      source: "LABORATORY",
    }, admin)).rejects.toMatchObject({
      code: "APPOINTMENT_STATUS_CONFLICT",
      status: 409,
    });
    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects cross-clinic staff before inspecting a completed correction", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED", physicalExamClinicId));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED", physicalExamClinicId));

    await expect(updateAppointment(appointmentId, {
      status: "PENDING",
      correctionReason: "Incorrect student selected",
      source: "LABORATORY",
    }, laboratoryStaff)).rejects.toMatchObject({
      code: "CLINIC_ACCESS_DENIED",
      status: 403,
    });
    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
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

  it("rejects a manual no-show after locking the current appointment without writing changes", async () => {
    await expect(updateAppointment(appointmentId, {
      status: "NO_SHOW",
      notes: "Marked manually",
    }, admin)).rejects.toMatchObject({
      code: "MANUAL_NO_SHOW_NOT_ALLOWED",
      message: "No-show is assigned automatically at midnight and cannot be set manually.",
      status: 422,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(getAppointmentMutationContext).toHaveBeenCalledWith(appointmentId, client);
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a manual no-show request that also includes a replacement date", async () => {
    await expect(updateAppointment(appointmentId, {
      status: "NO_SHOW",
      appointmentDate: "2026-08-19",
      notes: "Attempted mixed manual no-show",
    }, admin)).rejects.toMatchObject({
      code: "MANUAL_NO_SHOW_NOT_ALLOWED",
      status: 422,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(getAppointmentMutationContext).toHaveBeenCalledWith(appointmentId, client);
    expect(rescheduleAppointmentWithClient).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("returns an already-completed appointment without writing another status transition", async () => {
    const completed = mutationContext("COMPLETED");
    getAppointmentMutationContext.mockResolvedValue(completed);

    await expect(completeAppointmentWithClient(
      appointmentId,
      admin,
      "Already recorded",
      client,
    )).resolves.toEqual(completed);

    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
  });

  it("does not audit an already-completed appointment update as a status change", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

    await updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Already recorded",
    }, admin);

    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects an ordinary status update when the locked appointment completed after preflight", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("PENDING"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Stale cancellation request",
    }, admin)).rejects.toMatchObject({
      code: "INVALID_STATUS_TRANSITION",
      status: 422,
    });

    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a mixed dated request when the locked appointment completed after preflight", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("PENDING"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      appointmentDate: "2026-08-19",
      notes: "Stale reschedule request",
    }, admin)).rejects.toMatchObject({
      code: "INVALID_RESCHEDULE",
      status: 422,
    });

    expect(rescheduleAppointmentWithClient).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "PENDING" as const, null],
    ["manual no-show", "NO_SHOW" as const, {
      ...automaticNoShowLog,
      notes: "Marked manually",
      changedById: admin.userId,
    }],
  ])("keeps reschedule-first behavior for a mixed completed request on a %s appointment", async (
    _,
    status,
    latestLog,
  ) => {
    const current = publishedAppointment(status);
    const replacement = {
      ...publishedAppointment("PENDING"),
      id: replacementId,
      appointmentDate: "2026-08-19",
      rescheduledFrom: appointmentId,
    };
    getPublishedAppointment
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(replacement);
    getAppointmentMutationContext.mockResolvedValue(mutationContext(
      status,
      laboratoryClinicId,
      latestLog,
    ));
    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      appointmentDate: "2026-08-19",
      notes: "Student requested a replacement",
    }, admin)).resolves.toEqual(replacement);

    expect(rescheduleAppointmentWithClient).toHaveBeenCalledWith(
      client,
      mutationContext(status, laboratoryClinicId, latestLog),
      "2026-08-19",
      "Student requested a replacement",
      admin.userId,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      admin.userId,
      "APPOINTMENT_RESCHEDULED",
      "appointment",
      appointmentId,
      { replacementId, appointmentDate: "2026-08-19" },
      client,
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
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
    { appointmentDate: "2026-08-19", notes: "Coordinator reschedule" },
  ])("rejects every coordinator mutation before writing (%o)", async (input) => {
    await expect(updateAppointment(appointmentId, input, coordinator)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(rescheduleAppointmentWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
