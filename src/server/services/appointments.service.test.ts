import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import type { SessionUser } from "@/types/roles";

const {
  changeAppointmentStatusWithClient,
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
  getAppointmentLockMutationContext,
  getAppointmentMutationContext,
  getAppointmentMutationScope,
  getPublishedAppointment,
  publishBatch,
  resolveEffectiveAppointmentPair,
  rescheduleAppointmentWithClient,
  setAppointmentManualLockWithClient,
  transaction,
  updateCapacitySetting,
  writeAudit,
} = vi.hoisted(() => ({
  changeAppointmentStatusWithClient: vi.fn(),
  deletePendingResultPlaceholder: vi.fn(),
  ensurePendingUploadResult: vi.fn(),
  getAppointmentResultCorrectionState: vi.fn(),
  getAppointmentLockMutationContext: vi.fn(),
  getAppointmentMutationContext: vi.fn(),
  getAppointmentMutationScope: vi.fn(),
  getPublishedAppointment: vi.fn(),
  publishBatch: vi.fn(),
  resolveEffectiveAppointmentPair: vi.fn(),
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
  getAppointmentLockMutationContext,
  getAppointmentMutationContext,
  getAppointmentMutationScope,
  getPublishedAppointment,
  publishBatch,
  rescheduleAppointmentWithClient,
  setAppointmentManualLockWithClient,
  updateCapacitySetting,
}));
vi.mock("@/server/repositories/coordinator-schedules.repository", () => ({
  getScheduleBatch: vi.fn(),
}));
vi.mock("@/server/repositories/effective-appointment-pair.repository", () => ({
  resolveEffectiveAppointmentPair,
}));
vi.mock("@/server/repositories/student-result-submissions.repository", () => ({
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
}));

import {
  assertStatusTransition,
  changeCapacity,
  completeAppointmentWithClient,
  updateAppointment,
} from "./appointments.service";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const replacementId = "22222222-2222-4222-8222-222222222222";
const laboratoryClinicId = "60000000-0000-4000-8000-000000000001";
const physicalExamClinicId = "60000000-0000-4000-8000-000000000002";
const query = vi.fn();
const client = { query } as unknown as PoolClient;

const admin = {
  userId: "00000000-0000-4000-8000-000000000001",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

describe("capacity settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCapacitySetting.mockResolvedValue({
      scheduleType: "LABORATORY",
      maxDailyCapacity: 125,
    });
    writeAudit.mockResolvedValue(undefined);
  });

  it("changes capacity from a maximum-only payload", async () => {
    await expect(changeCapacity({
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
      maxDailyCapacity: 125,
    }, admin.userId)).resolves.toEqual({
      scheduleType: "LABORATORY",
      maxDailyCapacity: 125,
    });

    expect(updateCapacitySetting).toHaveBeenCalledWith(
      "KABALAKA_CLINIC",
      "LABORATORY",
      125,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      admin.userId,
      "CAPACITY_UPDATED",
      "capacity_setting",
      "KABALAKA_CLINIC:LABORATORY",
      {
        clinicCode: "KABALAKA_CLINIC",
        scheduleType: "LABORATORY",
        maxDailyCapacity: 125,
      },
    );
  });

  it.each([
    ["missing", { clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY" }],
    ["zero", { clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY", maxDailyCapacity: 0 }],
    ["negative", { clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY", maxDailyCapacity: -1 }],
  ])("rejects a %s maximum capacity", async (_, input) => {
    await expect(changeCapacity(input, admin.userId)).rejects.toBeDefined();
    expect(updateCapacitySetting).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

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
    lockedById: null,
    lockedByName: null,
    lockedAt: null,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
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
  completedFromStatus: "PENDING" | "NO_SHOW" | null = null,
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
    schedulePairId: "33333333-3333-4333-8333-333333333333",
    scheduleCycleStart: 2026,
    isManuallyLocked: false,
    lockReason: null,
    lockedById: null,
    lockedAt: null,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    latestLog,
    completedFromStatus,
  };
}

function physicalMutationContext(
  status: "PENDING" | "COMPLETED" | "NO_SHOW" = "PENDING",
  completedFromStatus: "PENDING" | "NO_SHOW" | null = null,
) {
  return {
    ...mutationContext(status, physicalExamClinicId, null, "2026-08-19", completedFromStatus),
    scheduleType: "PHYSICAL_EXAM",
  };
}

function effectivePair(
  laboratoryStatus: "PENDING" | "COMPLETED" | "NO_SHOW" | null = "COMPLETED",
  physicalExamStatus: "PENDING" | "COMPLETED" | "NO_SHOW" | null = "PENDING",
) {
  return {
    laboratory: laboratoryStatus ? {
      ...mutationContext(laboratoryStatus),
      id: "55555555-5555-4555-8555-555555555555",
      appointmentDate: "2026-08-18",
      scheduleType: "LABORATORY" as const,
    } : null,
    physicalExam: physicalExamStatus ? {
      ...physicalMutationContext(physicalExamStatus),
      id: "66666666-6666-4666-8666-666666666666",
      appointmentDate: "2026-08-19",
      scheduleType: "PHYSICAL_EXAM" as const,
    } : null,
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

  it("keeps direct no-show cancellation out of the ordinary transition path", () => {
    expect(() => assertStatusTransition("NO_SHOW", "CANCELLED")).toThrow(
      expect.objectContaining({ code: "INVALID_STATUS_TRANSITION", status: 422 }),
    );
  });
});

describe("appointment mutation authorization and automatic no-show correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublishedAppointment.mockResolvedValue(publishedAppointment());
    getAppointmentLockMutationContext.mockResolvedValue(mutationContext());
    getAppointmentMutationContext.mockResolvedValue(mutationContext());
    getAppointmentMutationScope.mockResolvedValue(mutationContext());
    getAppointmentResultCorrectionState.mockResolvedValue({ type: "CLEAR" });
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair());
    changeAppointmentStatusWithClient.mockResolvedValue(undefined);
    deletePendingResultPlaceholder.mockResolvedValue(undefined);
    rescheduleAppointmentWithClient.mockResolvedValue(replacementId);
    setAppointmentManualLockWithClient.mockResolvedValue(true);
    writeAudit.mockResolvedValue(undefined);
    query.mockImplementation(async (statement: unknown) => ({
      rows: typeof statement === "string" &&
        statement.includes("INSERT INTO appointment_reschedule_events")
        ? [{ id: "44444444-4444-4444-8444-444444444444" }]
        : [],
    }));
    transaction.mockImplementation(async (callback: (transactionClient: PoolClient) => Promise<unknown>) => (
      callback(client)
    ));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("clinic schedule quick status", () => {
    it.each(["PENDING", "NO_SHOW", null] as const)(
      "rejects Physical Examination completion when the effective Laboratory is %s",
      async (laboratoryStatus) => {
        const physical = physicalMutationContext("PENDING");
        getAppointmentMutationContext.mockResolvedValue(physical);
        resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair(laboratoryStatus));

        await expect(updateAppointment(appointmentId, {
          quickStatusAction: "MARK_COMPLETED",
          expectedStatus: "PENDING",
        }, admin)).rejects.toMatchObject({
          code: "LABORATORY_NOT_COMPLETED",
          status: 409,
        });

        expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
        expect(ensurePendingUploadResult).not.toHaveBeenCalled();
        expect(writeAudit).not.toHaveBeenCalled();
      },
    );

    it("completes Physical Examination when the effective Laboratory is completed", async () => {
      const physical = physicalMutationContext("PENDING");
      getAppointmentMutationContext.mockResolvedValue(physical);
      resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("COMPLETED"));

      await updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, admin);

      expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        "PENDING",
        "COMPLETED",
        "Marked completed through the clinic schedule.",
        admin.userId,
      );
    });

    it("rejects Laboratory rollback before inspecting protected results when Physical Examination is completed", async () => {
      const laboratory = mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", "PENDING");
      getAppointmentMutationContext.mockResolvedValue(laboratory);
      resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("COMPLETED", "COMPLETED"));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin)).rejects.toMatchObject({
        code: "PHYSICAL_ALREADY_COMPLETED",
        status: 409,
      });

      expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it("returns the paired Physical Examination guard before legacy completion-history errors", async () => {
      const laboratory = mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", null);
      getAppointmentMutationContext.mockResolvedValue(laboratory);
      resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("COMPLETED", "COMPLETED"));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin)).rejects.toMatchObject({
        code: "PHYSICAL_ALREADY_COMPLETED",
        status: 409,
      });

      expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    });

    it("completes a future pending appointment with the server note and quick-status audit", async () => {
      const locked = mutationContext("PENDING", laboratoryClinicId, null, "2045-08-18");
      getAppointmentMutationContext.mockResolvedValue(locked);

      await updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, admin);

      expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        "PENDING",
        "COMPLETED",
        "Marked completed through the clinic schedule.",
        admin.userId,
      );
      expect(ensurePendingUploadResult).toHaveBeenCalledWith(client, locked);
      expect(writeAudit).toHaveBeenCalledWith(
        admin.userId,
        "APPOINTMENT_STATUS_CHANGED",
        "appointment",
        appointmentId,
        {
          oldStatus: "PENDING",
          newStatus: "COMPLETED",
          quickStatusAction: "MARK_COMPLETED",
          source: "CLINIC_SCHEDULE_QUICK_STATUS",
        },
        client,
      );
    });

    it("corrects only an automatic no-show using the fixed server note", async () => {
      const locked = mutationContext("NO_SHOW", laboratoryClinicId, automaticNoShowLog);
      getAppointmentMutationContext.mockResolvedValue(locked);

      await updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "NO_SHOW",
      }, laboratoryStaff);

      expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        "NO_SHOW",
        "COMPLETED",
        "Automatic no-show corrected to completed through the clinic schedule.",
        laboratoryStaff.userId,
      );
      expect(writeAudit).toHaveBeenCalledWith(
        laboratoryStaff.userId,
        "APPOINTMENT_STATUS_CORRECTED",
        "appointment",
        appointmentId,
        expect.objectContaining({
          oldStatus: "NO_SHOW",
          newStatus: "COMPLETED",
          source: "CLINIC_SCHEDULE_QUICK_STATUS",
        }),
        client,
      );
    });

    it("restores the server-derived pending status and removes only its safe placeholder", async () => {
      const locked = mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", "PENDING");
      const placeholder = {
        type: "PENDING_PLACEHOLDER" as const,
        resultId: "44444444-4444-4444-8444-444444444444",
        table: "laboratory_results" as const,
      };
      getAppointmentMutationContext.mockResolvedValue(locked);
      getAppointmentResultCorrectionState.mockResolvedValue(placeholder);

      await updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin);

      expect(deletePendingResultPlaceholder).toHaveBeenCalledWith(client, placeholder);
      expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        "COMPLETED",
        "PENDING",
        "Clinic schedule completion reverted to pending.",
        admin.userId,
      );
      expect(writeAudit).toHaveBeenCalledWith(
        admin.userId,
        "APPOINTMENT_STATUS_CORRECTED",
        "appointment",
        appointmentId,
        {
          oldStatus: "COMPLETED",
          newStatus: "PENDING",
          quickStatusAction: "REVERT_COMPLETION",
          source: "CLINIC_SCHEDULE_QUICK_STATUS",
        },
        client,
      );
    });

    it("restores the server-derived automatic no-show without re-evaluating the appointment date", async () => {
      const locked = mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", "NO_SHOW");
      getAppointmentMutationContext.mockResolvedValue(locked);

      await updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin);

      expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        "COMPLETED",
        "NO_SHOW",
        "Clinic schedule completion reverted to the previous automatic no-show.",
        admin.userId,
      );
    });

    it("rejects a stale expected status before result inspection or mutation", async () => {
      getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", "PENDING"));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_STATUS_CONFLICT", status: 409 });

      expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it("rejects a manual or legacy no-show", async () => {
      getAppointmentMutationContext.mockResolvedValue(mutationContext("NO_SHOW"));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "NO_SHOW",
      }, admin)).rejects.toMatchObject({ code: "NO_SHOW_CORRECTION_NOT_ALLOWED", status: 422 });

      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    });

    it("rejects a completed appointment whose completion source cannot be established", async () => {
      getAppointmentMutationContext.mockResolvedValue(mutationContext("COMPLETED"));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin)).rejects.toMatchObject({
        code: "APPOINTMENT_COMPLETION_HISTORY_INVALID",
        status: 409,
      });

      expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    });

    it("uses the protected-result quick-status message and leaves the appointment untouched", async () => {
      getAppointmentMutationContext.mockResolvedValue(
        mutationContext("COMPLETED", laboratoryClinicId, null, "2045-08-18", "PENDING"),
      );
      getAppointmentResultCorrectionState.mockResolvedValue({ type: "PROTECTED", reason: "FINALIZED_SUBMISSION" });

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "REVERT_COMPLETION",
        expectedStatus: "COMPLETED",
      }, admin)).rejects.toMatchObject({
        code: "APPOINTMENT_RESULT_PROTECTED",
        message: "This appointment can no longer be reverted because protected result data is linked to it.",
        status: 409,
      });

      expect(deletePendingResultPlaceholder).not.toHaveBeenCalled();
      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it("rejects cross-clinic staff before any quick-status side effect", async () => {
      getAppointmentMutationContext.mockResolvedValue(mutationContext("PENDING", physicalExamClinicId));

      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, laboratoryStaff)).rejects.toMatchObject({ code: "CLINIC_ACCESS_DENIED", status: 403 });

      expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it("rejects mixed quick-status and legacy mutation fields", async () => {
      await expect(updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
        status: "COMPLETED",
      }, admin)).rejects.toMatchObject({ name: "ZodError" });

      expect(transaction).not.toHaveBeenCalled();
    });
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

  it("rejects an ordinary reschedule onto an active First Year OVPSA service reservation", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("ovpsa_first_year_service_reservations")
        ? [{ schedule_type: "LABORATORY", date: "2026-08-19" }]
        : [],
    }));

    await expect(updateAppointment(appointmentId, {
      appointmentDate: "2026-08-19",
      notes: "Student requested a replacement",
    }, admin)).rejects.toMatchObject({
      code: "OVPSA_SERVICE_RESERVATION_CONFLICT",
      status: 409,
    });

    expect(rescheduleAppointmentWithClient).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ovpsa_first_year_service_reservations"),
      ["2026-08-19", "2026-08-19", null],
    );
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

  it("rejects detailed Physical Examination completion when Laboratory is incomplete", async () => {
    const current = {
      ...publishedAppointment("PENDING", physicalExamClinicId),
      scheduleType: "PHYSICAL_EXAM",
    };
    getPublishedAppointment.mockResolvedValue(current);
    getAppointmentMutationContext.mockResolvedValue(physicalMutationContext("PENDING"));
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("PENDING"));

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Visit completed",
    }, admin)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED", status: 409 });

    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects detailed Laboratory rollback when Physical Examination is completed", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("COMPLETED"));
    getAppointmentMutationContext.mockResolvedValue(
      mutationContext("COMPLETED", laboratoryClinicId, null, "2026-07-21", "PENDING"),
    );
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("COMPLETED", "COMPLETED"));

    await expect(updateAppointment(appointmentId, {
      status: "PENDING",
      correctionReason: "Incorrect completion",
      source: "LABORATORY",
    }, admin)).rejects.toMatchObject({ code: "PHYSICAL_ALREADY_COMPLETED", status: 409 });

    expect(getAppointmentResultCorrectionState).not.toHaveBeenCalled();
    expect(changeAppointmentStatusWithClient).not.toHaveBeenCalled();
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

  it("locks the effective appointment scope before an administrator cancellation", async () => {
    getPublishedAppointment.mockResolvedValue(publishedAppointment("PENDING"));
    getAppointmentMutationContext.mockResolvedValue(mutationContext("PENDING"));

    await updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Internal cancellation note",
    }, admin);

    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["medclinic:effective-appointment:v1:LABORATORY:2026-0001"],
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["medclinic:effective-appointment:v1:PHYSICAL_EXAM:2026-0001"],
    );
    const scopeLockIndex = query.mock.calls.findIndex(([, values]) => (
      Array.isArray(values) && values[0] === "medclinic:effective-appointment:v1:LABORATORY:2026-0001"
    ));
    const cancellationIndex = changeAppointmentStatusWithClient.mock.invocationCallOrder[0];
    expect(query.mock.invocationCallOrder[scopeLockIndex]).toBeLessThan(cancellationIndex);
  });

  it.each(["PENDING", "NO_SHOW"] as const)(
    "cascades Laboratory cancellation to a paired %s Physical Examination with one audit per mutation",
    async (physicalExamStatus) => {
      const laboratory = mutationContext("PENDING");
      const pair = effectivePair("PENDING", physicalExamStatus);
      getAppointmentMutationContext.mockResolvedValue(laboratory);
      resolveEffectiveAppointmentPair.mockResolvedValue(pair);

      await updateAppointment(appointmentId, {
        status: "CANCELLED",
        notes: "Cancel unfinished pair",
      }, admin);

      expect(changeAppointmentStatusWithClient).toHaveBeenNthCalledWith(
        1,
        client,
        appointmentId,
        "PENDING",
        "CANCELLED",
        "Cancel unfinished pair",
        admin.userId,
      );
      expect(changeAppointmentStatusWithClient).toHaveBeenNthCalledWith(
        2,
        client,
        pair.physicalExam!.id,
        physicalExamStatus,
        "CANCELLED",
        "Cancel unfinished pair",
        admin.userId,
      );
      expect(writeAudit).toHaveBeenCalledTimes(2);
      expect(writeAudit).toHaveBeenNthCalledWith(
        2,
        admin.userId,
        "APPOINTMENT_STATUS_CHANGED",
        "appointment",
        pair.physicalExam!.id,
        {
          oldStatus: physicalExamStatus,
          newStatus: "CANCELLED",
          cascadeFromAppointmentId: appointmentId,
        },
        client,
      );
    },
  );

  it("does not cascade Physical Examination cancellation to Laboratory", async () => {
    const physical = physicalMutationContext("PENDING");
    getPublishedAppointment.mockResolvedValue({
      ...publishedAppointment("PENDING", physicalExamClinicId),
      scheduleType: "PHYSICAL_EXAM",
    });
    getAppointmentMutationContext.mockResolvedValue(physical);
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("PENDING", "PENDING"));

    await updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Cancel Physical Examination only",
    }, admin);

    expect(changeAppointmentStatusWithClient).toHaveBeenCalledTimes(1);
    expect(changeAppointmentStatusWithClient).toHaveBeenCalledWith(
      client,
      appointmentId,
      "PENDING",
      "CANCELLED",
      "Cancel Physical Examination only",
      admin.userId,
    );
  });

  it("rejects Laboratory cancellation when paired Physical Examination is completed", async () => {
    getAppointmentMutationContext.mockResolvedValue(mutationContext("PENDING"));
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair("PENDING", "COMPLETED"));

    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Attempt inconsistent cancellation",
    }, admin)).rejects.toMatchObject({ code: "PHYSICAL_ALREADY_COMPLETED", status: 409 });

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

  describe("manual appointment protection", () => {
    const expectedUpdatedAt = "2026-08-01T00:00:00.000Z";

    it("locks the row before validating and records a structured audit", async () => {
      const lockedRow = mutationContext();
      getAppointmentLockMutationContext.mockResolvedValue(lockedRow);

      await updateAppointment(appointmentId, {
        lockAction: "LOCK",
        lockReason: "Protect while the clinic reviews this schedule",
        expectedUpdatedAt,
      }, admin);

      expect(getAppointmentLockMutationContext).toHaveBeenCalledWith(appointmentId, client);
      expect(setAppointmentManualLockWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        true,
        admin.userId,
        "Protect while the clinic reviews this schedule",
      );
      expect(writeAudit).toHaveBeenCalledWith(
        admin.userId,
        "APPOINTMENT_LOCKED",
        "appointment",
        appointmentId,
        {
          appointmentId,
          studentNumber: "2026-0001",
          scheduleType: "LABORATORY",
          reason: "Protect while the clinic reviews this schedule",
          previousAppointmentId: null,
        },
        client,
      );
    });

    it("locks the row before rejecting clinic staff authorization", async () => {
      await expect(updateAppointment(appointmentId, {
        lockAction: "LOCK",
        lockReason: null,
      }, laboratoryStaff)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

      expect(getAppointmentLockMutationContext).toHaveBeenCalledWith(appointmentId, client);
      expect(setAppointmentManualLockWithClient).not.toHaveBeenCalled();
    });

    it("rejects a stale optimistic timestamp", async () => {
      await expect(updateAppointment(appointmentId, {
        lockAction: "LOCK",
        lockReason: "Protect this appointment",
        expectedUpdatedAt: "2026-07-31T00:00:00.000Z",
      }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_STALE", status: 409 });
      expect(setAppointmentManualLockWithClient).not.toHaveBeenCalled();
    });

    it("rejects new locks for historical statuses", async () => {
      getAppointmentLockMutationContext.mockResolvedValue(mutationContext("COMPLETED"));
      await expect(updateAppointment(appointmentId, {
        lockAction: "LOCK",
        lockReason: "Too late to create a lock",
        expectedUpdatedAt,
      }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_LOCK_STATUS_INVALID", status: 422 });
    });

    it("allows an administrator to unlock after the status changes", async () => {
      getAppointmentLockMutationContext.mockResolvedValue({
        ...mutationContext("COMPLETED"),
        isManuallyLocked: true,
        lockReason: "Original protection reason",
        lockedById: admin.userId,
        lockedAt: new Date("2026-08-01T00:00:00.000Z"),
      });

      await updateAppointment(appointmentId, {
        lockAction: "UNLOCK",
        expectedUpdatedAt,
      }, admin);

      expect(setAppointmentManualLockWithClient).toHaveBeenCalledWith(
        client,
        appointmentId,
        false,
        admin.userId,
        null,
      );
      expect(writeAudit).toHaveBeenCalledWith(
        admin.userId,
        "APPOINTMENT_UNLOCKED",
        "appointment",
        appointmentId,
        expect.objectContaining({ reason: "Original protection reason" }),
        client,
      );
    });

    it.each([
      ["LOCK", true, "APPOINTMENT_ALREADY_LOCKED"],
      ["UNLOCK", false, "APPOINTMENT_ALREADY_UNLOCKED"],
    ] as const)("rejects %s when the row is already in that state", async (lockAction, isManuallyLocked, code) => {
      getAppointmentLockMutationContext.mockResolvedValue({
        ...mutationContext(),
        isManuallyLocked,
      });
      await expect(updateAppointment(appointmentId, {
        lockAction,
        ...(lockAction === "LOCK" ? { lockReason: "Already protected" } : {}),
        expectedUpdatedAt,
      }, admin)).rejects.toMatchObject({ code, status: 409 });
    });

    it("returns the lock-specific reason error for short input", async () => {
      await expect(updateAppointment(appointmentId, {
        lockAction: "LOCK",
        lockReason: "x",
        expectedUpdatedAt,
      }, admin)).rejects.toMatchObject({ code: "LOCK_REASON_REQUIRED", status: 422 });
      expect(setAppointmentManualLockWithClient).not.toHaveBeenCalled();
    });
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
