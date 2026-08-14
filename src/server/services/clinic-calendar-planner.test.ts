import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  allocateReplacementDates,
  classifyClinicCycle,
  groupContiguousClosureChanges,
  type ClinicCycleAppointment,
} from "./clinic-calendar-planner";

function appointment(
  scheduleType: ClinicCycleAppointment["scheduleType"],
  status: string,
  overrides: Partial<ClinicCycleAppointment> = {},
): ClinicCycleAppointment {
  return {
    id: `${scheduleType}-${status}`,
    studentNumber: "2026-0001",
    scheduleType,
    appointmentDate: scheduleType === "LABORATORY" ? "2027-08-10" : "2027-08-11",
    status,
    isPublished: true,
    isManuallyLocked: false,
    resultProtectionState: { type: "CLEAR" },
    schedulePairId: "10000000-0000-4000-8000-000000000001",
    scheduleCycleStart: 2026,
    ...overrides,
  };
}

describe("unified clinic closure planning", () => {
  it("groups only adjacent dates with matching category and normalized reason", () => {
    expect(groupContiguousClosureChanges([
      { action: "BLOCK", date: "2027-08-13", category: "CLOSURE", reason: "  Typhoon   signal  " },
      { action: "BLOCK", date: "2027-08-11", category: "CLOSURE", reason: "Typhoon signal" },
      { action: "BLOCK", date: "2027-08-12", category: "CLOSURE", reason: "Typhoon signal" },
      { action: "BLOCK", date: "2027-08-14", category: "MAINTENANCE", reason: "Typhoon signal" },
      { action: "BLOCK", date: "2027-08-16", category: "CLOSURE", reason: "Typhoon signal" },
    ])).toEqual([
      {
        startDate: "2027-08-11",
        endDate: "2027-08-13",
        dates: ["2027-08-11", "2027-08-12", "2027-08-13"],
        category: "CLOSURE",
        reason: "Typhoon signal",
      },
      {
        startDate: "2027-08-14",
        endDate: "2027-08-14",
        dates: ["2027-08-14"],
        category: "MAINTENANCE",
        reason: "Typhoon signal",
      },
      {
        startDate: "2027-08-16",
        endDate: "2027-08-16",
        dates: ["2027-08-16"],
        category: "CLOSURE",
        reason: "Typhoon signal",
      },
    ]);
  });

  it.each([
    ["moves the complete unfinished pair", [appointment("LABORATORY", "PENDING"), appointment("PHYSICAL_EXAM", "PENDING")], "MOVE_COMPLETE_PAIR"],
    ["moves only Physical when Laboratory is completed", [appointment("LABORATORY", "COMPLETED"), appointment("PHYSICAL_EXAM", "PENDING")], "MOVE_PHYSICAL_ONLY"],
    ["preserves a completed pair", [appointment("LABORATORY", "COMPLETED"), appointment("PHYSICAL_EXAM", "COMPLETED")], "PRESERVE_COMPLETION"],
    ["routes inverted completion to manual review", [appointment("LABORATORY", "PENDING"), appointment("PHYSICAL_EXAM", "COMPLETED")], "MANUAL_RESOLUTION_REQUIRED"],
    ["routes a locked appointment to manual review", [appointment("LABORATORY", "PENDING", { isManuallyLocked: true }), appointment("PHYSICAL_EXAM", "PENDING")], "MANUAL_RESOLUTION_REQUIRED"],
  ])("%s", (_name, appointments, expected) => {
    expect(classifyClinicCycle(appointments as ClinicCycleAppointment[]).strategy).toBe(expected);
  });

  it("moves only the affected service when the related appointment remains safe", () => {
    const laboratory = appointment("LABORATORY", "PENDING");
    const physicalExam = appointment("PHYSICAL_EXAM", "PENDING", {
      appointmentDate: "2027-09-20",
    });

    expect(classifyClinicCycle([laboratory, physicalExam], {
      affectedAppointmentIds: new Set([physicalExam.id]),
    }).strategy).toBe("MOVE_PHYSICAL_ONLY");
    expect(classifyClinicCycle([laboratory, physicalExam], {
      affectedAppointmentIds: new Set([laboratory.id]),
      proposedLaboratoryDate: "2027-09-01",
    }).strategy).toBe("MOVE_LABORATORY_ONLY");
    expect(classifyClinicCycle([laboratory, physicalExam], {
      affectedAppointmentIds: new Set([laboratory.id]),
      proposedLaboratoryDate: "2027-09-20",
    }).strategy).toBe("MOVE_COMPLETE_PAIR");
  });

  it("reports a specific reason for draft files, protected results, and inconsistent pairs", () => {
    expect(classifyClinicCycle([
      appointment("LABORATORY", "PENDING", {
        resultProtectionState: {
          type: "PROTECTED",
          reason: "DRAFT_RESULT_FILES_EXIST",
          message: "Draft result files exist for this appointment.",
          submissionId: "submission-1",
          activeFileCount: 1,
        },
      }),
      appointment("PHYSICAL_EXAM", "PENDING"),
    ])).toMatchObject({
      strategy: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
    });
    expect(classifyClinicCycle([
      appointment("LABORATORY", "PENDING", {
        resultProtectionState: {
          type: "PROTECTED",
          reason: "FINALIZED_RESULT_SUBMISSION",
          message: "A finalized result submission exists for this appointment.",
        },
      }),
      appointment("PHYSICAL_EXAM", "PENDING"),
    ])).toMatchObject({
      strategy: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "PROTECTED_RESULTS_EXIST",
    });
    expect(classifyClinicCycle([appointment("LABORATORY", "PENDING")])).toMatchObject({
      strategy: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "PAIR_MISSING_OR_INCONSISTENT",
    });
  });

  it("classifies manual locks before draft result files", () => {
    expect(classifyClinicCycle([
      appointment("LABORATORY", "PENDING", { isManuallyLocked: true }),
      appointment("PHYSICAL_EXAM", "PENDING", {
        resultProtectionState: {
          type: "PROTECTED",
          reason: "DRAFT_RESULT_FILES_EXIST",
          message: "Draft result files exist for this appointment.",
        },
      }),
    ])).toMatchObject({
      strategy: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "APPOINTMENT_MANUALLY_LOCKED",
    });
  });

  it("starts after the full closure period and skips weekends, closures, and full dates", () => {
    expect(allocateReplacementDates({
      strategy: "MOVE_COMPLETE_PAIR",
      afterDate: "2027-08-13",
      blockedDates: new Set(["2027-08-16"]),
      usedCapacity: {
        LABORATORY: new Map([["2027-08-17", 2]]),
        PHYSICAL_EXAM: new Map([["2027-08-19", 2]]),
      },
      capacity: { LABORATORY: 2, PHYSICAL_EXAM: 2 },
    })).toEqual({ laboratoryDate: "2027-08-18", physicalExamDate: "2027-08-20" });
  });

  it("allocates a Laboratory-only recovery without consuming Physical capacity", () => {
    expect(allocateReplacementDates({
      strategy: "MOVE_LABORATORY_ONLY",
      afterDate: "2027-08-13",
      blockedDates: new Set(),
      usedCapacity: {
        LABORATORY: new Map(),
        PHYSICAL_EXAM: new Map(),
      },
      capacity: { LABORATORY: 1, PHYSICAL_EXAM: 1 },
    })).toEqual({ laboratoryDate: "2027-08-16" });
  });

  it("allocates deterministically as callers process students in student-number order", () => {
    const usedCapacity = {
      LABORATORY: new Map<string, number>(),
      PHYSICAL_EXAM: new Map<string, number>(),
    };
    const first = allocateReplacementDates({
      strategy: "MOVE_PHYSICAL_ONLY",
      afterDate: "2027-08-13",
      blockedDates: new Set(),
      usedCapacity,
      capacity: { LABORATORY: 1, PHYSICAL_EXAM: 1 },
    });
    if (first.physicalExamDate) usedCapacity.PHYSICAL_EXAM.set(first.physicalExamDate, 1);
    const second = allocateReplacementDates({
      strategy: "MOVE_PHYSICAL_ONLY",
      afterDate: "2027-08-13",
      blockedDates: new Set(),
      usedCapacity,
      capacity: { LABORATORY: 1, PHYSICAL_EXAM: 1 },
    });
    expect([first.physicalExamDate, second.physicalExamDate]).toEqual(["2027-08-16", "2027-08-17"]);
  });

  it("reports a manual capacity fallback when no free weekday exists in the recovery horizon", () => {
    const blockedDates = new Set<string>();
    const afterDate = "2027-08-13";
    const horizon = addCalendarDays(afterDate, 366 * 5);
    for (
      let date = addCalendarDays(afterDate, 1);
      date <= horizon;
      date = addCalendarDays(date, 1)
    ) {
      blockedDates.add(date);
    }
    expect(() => allocateReplacementDates({
      strategy: "MOVE_PHYSICAL_ONLY",
      afterDate,
      blockedDates,
      usedCapacity: { LABORATORY: new Map(), PHYSICAL_EXAM: new Map() },
      capacity: { LABORATORY: 1, PHYSICAL_EXAM: 1 },
    })).toThrow(expect.objectContaining({ reasonCode: "NO_REPLACEMENT_CAPACITY" }));
  });
});
