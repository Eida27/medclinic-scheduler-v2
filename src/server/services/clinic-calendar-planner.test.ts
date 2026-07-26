// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  ClinicCalendarBatchChange,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";
import {
  buildFinalBlockedSets,
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
});
