import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/types/roles";

const {
  changeAppointmentStatusWithClient,
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
  getAppointmentLockMutationContext,
  getAppointmentMutationContext,
  getAppointmentMutationScope,
  getManualRescheduleDestinationState,
  getPublishedAppointment,
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
  getManualRescheduleDestinationState: vi.fn(),
  getPublishedAppointment: vi.fn(),
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
  getManualRescheduleDestinationState,
  getPublishedAppointment,
  rescheduleAppointmentWithClient,
  setAppointmentManualLockWithClient,
  updateCapacitySetting,
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
    query.mockResolvedValue({ rows: [] });
    transaction.mockImplementation((callback) => callback(client));
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
      client,
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
      client,
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
    schedulingCategory: null,
    schedulingAcceptedAt: null,
    schedulingSourceRowOrder: null,
    schedulingWindowStart: null,
    schedulingWindowEnd: null,
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

describe("appointment status transitions", () => {
  it("rejects legacy clinical completion payloads before any database write", async () => {
    vi.clearAllMocks();
    for (const payload of [
      { quickStatusAction: "MARK_COMPLETED", expectedStatus: "PENDING" },
      { quickStatusAction: "REVERT_COMPLETION", expectedStatus: "COMPLETED" },
      { status: "COMPLETED" },
    ]) {
      await expect(updateAppointment(appointmentId, payload, admin)).rejects.toMatchObject({
        code: "CLINICAL_COMPLETION_RETIRED",
        status: 422,
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });
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
    getManualRescheduleDestinationState.mockResolvedValue({
      cycleClosingDate: "2100-07-31",
      maxDailyCapacity: 150,
      usedCapacity: 0,
    });
    getAppointmentResultCorrectionState.mockResolvedValue({ type: "CLEAR" });
    resolveEffectiveAppointmentPair.mockResolvedValue(effectivePair());
    changeAppointmentStatusWithClient.mockResolvedValue(undefined);
    deletePendingResultPlaceholder.mockResolvedValue(undefined);
    rescheduleAppointmentWithClient.mockResolvedValue(replacementId);
    setAppointmentManualLockWithClient.mockResolvedValue(true);
    writeAudit.mockResolvedValue(undefined);
    query.mockImplementation(async (statement: unknown) => ({
      rows: typeof statement === "string" && statement.includes("FROM academic_years")
        ? [{ closingDate: "2100-07-31" }]
        : typeof statement === "string" && statement.includes("INSERT INTO appointment_reschedule_events")
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

  it("rejects an ordinary reschedule onto an active First Year OVPSA service reservation", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM academic_years")
        ? [{ closingDate: "2100-07-31" }]
        : sql.includes("ovpsa_first_year_service_reservations")
          ? [{ schedule_type: "LABORATORY", date: "2045-08-21" }]
          : [],
    }));

    await expect(updateAppointment(appointmentId, {
      appointmentDate: "2045-08-21",
      notes: "Student requested a replacement",
    }, admin)).rejects.toMatchObject({
      code: "APPOINTMENT_DATE_BLOCKED",
      status: 409,
    });

    expect(rescheduleAppointmentWithClient).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ovpsa_first_year_service_reservations"),
      ["2045-08-21", "2045-08-21", null, []],
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
      appointmentDate: "2045-08-21",
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
