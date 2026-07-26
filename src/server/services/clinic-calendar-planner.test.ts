// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  ClinicCalendarBatchChange,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";
import type {
  ClinicRestorationBundle,
  LockedRestorationAppointment,
} from "@/server/repositories/clinic-calendar-restoration.repository";
import {
  buildFinalBlockedSets,
  planClinicRestoration,
  reserveFirstAvailableDate,
  sortClinicCalendarChanges,
  type ClinicCalendarPlanningContext,
} from "./clinic-calendar-planner";

const laboratoryClinicId = "60000000-0000-4000-8000-000000000001";
const physicalClinicId = "60000000-0000-4000-8000-000000000002";

function activeRecord(overrides: Partial<ClinicUnavailableDateDto>): ClinicUnavailableDateDto {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    clinicId: physicalClinicId,
    clinicCode: "CPU_CLINIC",
    clinicName: "CPU Clinic",
    startDate: "2027-07-15",
    endDate: "2027-07-15",
    category: "CLOSURE",
    reason: "Existing maintenance",
    createdByName: "System Admin",
    createdAt: "2027-07-01T00:00:00.000Z",
    updatedAt: "2027-07-01T00:00:00.000000Z",
    ...overrides,
  };
}

function planningContext(): ClinicCalendarPlanningContext {
  return {
    finalBlockedByClinicCode: new Map([
      ["KABALAKA_CLINIC", new Set<string>()],
      ["CPU_CLINIC", new Set<string>(["2027-07-17"])],
    ]),
    projectedLoadByClinicCode: new Map([
      ["KABALAKA_CLINIC", new Map<string, number>()],
      ["CPU_CLINIC", new Map<string, number>([["2027-07-15", 1]])],
    ]),
    maxCapacityByClinicCode: new Map([
      ["KABALAKA_CLINIC", 2],
      ["CPU_CLINIC", 2],
    ]),
    retiringReplacementIds: new Set(),
    restoringOriginalIds: new Set(),
    searchEndDate: "2027-07-20",
  };
}

function restorationAppointment(
  overrides: Partial<LockedRestorationAppointment>,
): LockedRestorationAppointment {
  return {
    id: "80000000-0000-4000-8000-000000000001",
    clinicId: physicalClinicId,
    studentNumber: "99-9999-99",
    scheduleType: "PHYSICAL_EXAM",
    appointmentDate: "2027-07-15",
    status: "RESCHEDULED",
    isPublished: true,
    schedulePairId: "81000000-0000-4000-8000-000000000001",
    scheduleCycleStart: 2027,
    isManuallyLocked: false,
    hasFinalizedSubmission: false,
    hasProtectedResult: false,
    rescheduledFrom: null,
    hasPublishedReplacement: false,
    publishedReplacementChildren: [],
    activeConflictIds: [],
    ...overrides,
  };
}

function cpuRestorationBundle(): ClinicRestorationBundle {
  const original = restorationAppointment({});
  const replacement = restorationAppointment({
    id: "80000000-0000-4000-8000-000000000002",
    appointmentDate: "2027-07-16",
    status: "PENDING",
    rescheduledFrom: original.id,
  });
  return {
    block: {
      id: "70000000-0000-4000-8000-000000000001",
      clinicId: physicalClinicId,
      startDate: "2027-07-15",
      endDate: "2027-07-15",
      category: "CLOSURE",
      reason: "Existing maintenance",
      createdBy: "90000000-0000-4000-8000-000000000001",
      createdBatchId: "91000000-0000-4000-8000-000000000001",
      updatedAt: "2027-07-01T00:00:00.000000Z",
    },
    clinicCode: "CPU_CLINIC",
    events: [{
      id: "82000000-0000-4000-8000-000000000001",
      studentNumber: original.studentNumber,
      schedulePairId: original.schedulePairId,
      restoredAt: null,
      oldLaboratory: null,
      newLaboratory: null,
      oldPhysicalExam: original,
      newPhysicalExam: replacement,
    }],
  };
}

describe("clinic calendar block planning", () => {
  it("computes final blocked dates after applying both unblock and block changes", () => {
    const existing = activeRecord({});
    const changes: ClinicCalendarBatchChange[] = [
      {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: existing.id,
        expectedUpdatedAt: existing.updatedAt,
      },
      {
        action: "BLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-18",
        category: "CLOSURE",
        reason: "Maintenance",
      },
    ];

    const sets = buildFinalBlockedSets([existing], changes);

    expect(sets.get(physicalClinicId)).not.toContain("2027-07-15");
    expect(sets.get(physicalClinicId)).toContain("2027-07-18");
  });

  it("orders changes deterministically by date and then clinic id", () => {
    const changes: ClinicCalendarBatchChange[] = [
      {
        action: "BLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-20",
        category: "CLOSURE",
        reason: "Third",
      },
      {
        action: "BLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-19",
        category: "CLOSURE",
        reason: "Second",
      },
      {
        action: "BLOCK",
        clinicId: laboratoryClinicId,
        date: "2027-07-19",
        category: "CLOSURE",
        reason: "First",
      },
    ];

    expect(sortClinicCalendarChanges(changes).map((change) => (
      change.action === "BLOCK" ? change.reason : change.action
    ))).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("reserves projected load so later moves cannot overbook the same date", () => {
    const context = planningContext();

    expect(reserveFirstAvailableDate(context, "CPU_CLINIC", "2027-07-15"))
      .toBe("2027-07-15");
    expect(reserveFirstAvailableDate(context, "CPU_CLINIC", "2027-07-15"))
      .toBe("2027-07-16");
    expect(context.projectedLoadByClinicCode.get("CPU_CLINIC")).toEqual(new Map([
      ["2027-07-15", 2],
      ["2027-07-16", 1],
    ]));
  });

  it("plans CPU restoration by retiring the generated PE before restoring its original load", () => {
    const context = planningContext();
    context.projectedLoadByClinicCode.get("CPU_CLINIC")!.set("2027-07-16", 1);
    const bundle = cpuRestorationBundle();

    const plan = planClinicRestoration(bundle, {
      ...context,
      change: {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: bundle.block.id,
        expectedUpdatedAt: bundle.block.updatedAt,
      },
    });

    expect(plan.moves).toEqual([expect.objectContaining({
      eventId: bundle.events[0].id,
      scheduleType: "PHYSICAL_EXAM",
      originalAppointmentId: bundle.events[0].oldPhysicalExam!.id,
      replacementAppointmentId: bundle.events[0].newPhysicalExam!.id,
    })]);
    expect(context.retiringReplacementIds).toContain(bundle.events[0].newPhysicalExam!.id);
    expect(context.restoringOriginalIds).toContain(bundle.events[0].oldPhysicalExam!.id);
    expect(context.projectedLoadByClinicCode.get("CPU_CLINIC")).toEqual(new Map([
      ["2027-07-15", 2],
      ["2027-07-16", 0],
    ]));
  });

  it("rejects an active uniqueness conflict without changing projected restoration state", () => {
    const context = planningContext();
    const bundle = cpuRestorationBundle();
    bundle.events[0].oldPhysicalExam!.activeConflictIds = [
      bundle.events[0].newPhysicalExam!.id,
      "80000000-0000-4000-8000-000000000099",
    ];
    const beforeLoad = new Map(context.projectedLoadByClinicCode.get("CPU_CLINIC"));

    expect(() => planClinicRestoration(bundle, {
      ...context,
      change: {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: bundle.block.id,
        expectedUpdatedAt: bundle.block.updatedAt,
      },
    })).toThrow(expect.objectContaining({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      details: { issues: [expect.objectContaining({ code: "PROTECTED_REPLACEMENT" })] },
    }));
    expect(context.projectedLoadByClinicCode.get("CPU_CLINIC")).toEqual(beforeLoad);
    expect(context.retiringReplacementIds.size).toBe(0);
    expect(context.restoringOriginalIds.size).toBe(0);
  });

  it("rejects an original date that remains in the final blocked set", () => {
    const context = planningContext();
    const bundle = cpuRestorationBundle();
    context.finalBlockedByClinicCode.get("CPU_CLINIC")!.add("2027-07-15");

    expect(() => planClinicRestoration(bundle, {
      ...context,
      change: {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: bundle.block.id,
        expectedUpdatedAt: bundle.block.updatedAt,
      },
    })).toThrow(expect.objectContaining({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      details: { issues: [expect.objectContaining({ code: "PROTECTED_REPLACEMENT" })] },
    }));
    expect(context.retiringReplacementIds.size).toBe(0);
    expect(context.restoringOriginalIds.size).toBe(0);
  });

  it("rejects appointment lineage that moves a generated PE into the wrong clinic", () => {
    const context = planningContext();
    const bundle = cpuRestorationBundle();
    bundle.events[0].newPhysicalExam!.clinicId = laboratoryClinicId;

    expect(() => planClinicRestoration(bundle, {
      ...context,
      change: {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: bundle.block.id,
        expectedUpdatedAt: bundle.block.updatedAt,
      },
    })).toThrow(expect.objectContaining({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      details: { issues: [expect.objectContaining({ code: "PAIR_INTEGRITY_FAILURE" })] },
    }));
    expect(context.retiringReplacementIds.size).toBe(0);
    expect(context.restoringOriginalIds.size).toBe(0);
  });

  it("rejects duplicate event provenance before projected load is changed", () => {
    const context = planningContext();
    context.maxCapacityByClinicCode.set("CPU_CLINIC", 10);
    const bundle = cpuRestorationBundle();
    bundle.events.push({ ...bundle.events[0], id: "82000000-0000-4000-8000-000000000002" });
    const beforeLoad = new Map(context.projectedLoadByClinicCode.get("CPU_CLINIC"));

    expect(() => planClinicRestoration(bundle, {
      ...context,
      change: {
        action: "UNBLOCK",
        clinicId: physicalClinicId,
        date: "2027-07-15",
        unavailableDateId: bundle.block.id,
        expectedUpdatedAt: bundle.block.updatedAt,
      },
    })).toThrow(expect.objectContaining({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      details: { issues: [expect.objectContaining({ code: "PAIR_INTEGRITY_FAILURE" })] },
    }));
    expect(context.projectedLoadByClinicCode.get("CPU_CLINIC")).toEqual(beforeLoad);
    expect(context.retiringReplacementIds.size).toBe(0);
    expect(context.restoringOriginalIds.size).toBe(0);
  });
});
