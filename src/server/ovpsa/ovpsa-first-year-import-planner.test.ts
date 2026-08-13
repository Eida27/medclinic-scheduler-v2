import { describe, expect, it } from "vitest";

import { planFirstYearScheduleImport } from "./ovpsa-first-year-import-planner";

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    studentNumber: `26-${String(index + 1).padStart(4, "0")}-01`,
    sourceRowNumber: index + 2,
  }));
}

describe("First Year schedule import planner", () => {
  it("splits 280 students across capacity-sized PE dates in exact CSV order", () => {
    const plan = planFirstYearScheduleImport({
      laboratoryDate: "2026-09-22",
      cycleStartDate: "2026-08-01",
      cycleEndDate: "2027-07-31",
      physicalExamMaximumCapacity: 150,
      members: members(280),
      laboratoryUnavailableReasons: [],
      physicalExamCandidates: [
        { date: "2026-09-29", unavailableReasons: [], displacementCount: 4 },
        { date: "2026-09-30", unavailableReasons: [], displacementCount: 7 },
      ],
    });

    expect(plan.canPublish).toBe(true);
    expect(plan.firstPhysicalExamCandidate).toBe("2026-09-29");
    expect(plan.allocations).toEqual([
      { date: "2026-09-29", studentCount: 150, capacity: 150, firstPosition: 1, lastPosition: 150 },
      { date: "2026-09-30", studentCount: 130, capacity: 150, firstPosition: 151, lastPosition: 280 },
    ]);
    expect(plan.members[0]).toEqual({
      studentNumber: "26-0001-01",
      sourceRowNumber: 2,
      allocationPosition: 1,
      assignedPhysicalExamDate: "2026-09-29",
    });
    expect(plan.members[279]).toEqual({
      studentNumber: "26-0280-01",
      sourceRowNumber: 281,
      allocationPosition: 280,
      assignedPhysicalExamDate: "2026-09-30",
    });
    expect(plan.displacementTotal).toBe(11);
  });

  it("skips weekend, protected, reserved, and replacement-blocked dates without manual resolution", () => {
    const plan = planFirstYearScheduleImport({
      laboratoryDate: "2026-09-25",
      cycleStartDate: "2026-08-01",
      cycleEndDate: "2027-07-31",
      physicalExamMaximumCapacity: 2,
      members: members(3),
      laboratoryUnavailableReasons: [],
      physicalExamCandidates: [
        { date: "2026-10-02", unavailableReasons: [], displacementCount: 1 },
        { date: "2026-10-03", unavailableReasons: ["NON_SERVICE_DAY"], displacementCount: 0 },
        { date: "2026-10-04", unavailableReasons: ["NON_SERVICE_DAY"], displacementCount: 0 },
        { date: "2026-10-05", unavailableReasons: ["PROTECTED_APPOINTMENT_CONFLICT"], displacementCount: 0 },
        { date: "2026-10-06", unavailableReasons: ["FIRST_YEAR_DATE_RESERVED"], displacementCount: 0 },
        { date: "2026-10-07", unavailableReasons: ["REPLACEMENT_CAPACITY_EXHAUSTED"], displacementCount: 0 },
        { date: "2026-10-08", unavailableReasons: [], displacementCount: 3 },
      ],
    });

    expect(plan.canPublish).toBe(true);
    expect(plan.allocations.map((allocation) => allocation.date)).toEqual([
      "2026-10-02",
      "2026-10-08",
    ]);
    expect(plan.skippedDates).toEqual([
      { date: "2026-10-03", reasons: ["NON_SERVICE_DAY"] },
      { date: "2026-10-04", reasons: ["NON_SERVICE_DAY"] },
      { date: "2026-10-05", reasons: ["PROTECTED_APPOINTMENT_CONFLICT"] },
      { date: "2026-10-06", reasons: ["FIRST_YEAR_DATE_RESERVED"] },
      { date: "2026-10-07", reasons: ["REPLACEMENT_CAPACITY_EXHAUSTED"] },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it("reports a blocker only when capacity or the allowed horizon cannot fit the complete batch", () => {
    const noCapacity = planFirstYearScheduleImport({
      laboratoryDate: "2026-09-22",
      cycleStartDate: "2026-08-01",
      cycleEndDate: "2027-07-31",
      physicalExamMaximumCapacity: 0,
      members: members(2),
      laboratoryUnavailableReasons: [],
      physicalExamCandidates: [],
    });
    expect(noCapacity.blockers).toEqual([{
      code: "FIRST_YEAR_PE_CAPACITY_NOT_CONFIGURED",
      message: "CPU Clinic Physical Examination capacity is not configured.",
    }]);

    const exhausted = planFirstYearScheduleImport({
      laboratoryDate: "2027-07-20",
      cycleStartDate: "2026-08-01",
      cycleEndDate: "2027-07-31",
      physicalExamMaximumCapacity: 2,
      members: members(3),
      laboratoryUnavailableReasons: [],
      physicalExamCandidates: [
        { date: "2027-07-27", unavailableReasons: [], displacementCount: 0 },
        { date: "2027-07-28", unavailableReasons: ["OFFICIAL_CLOSURE"], displacementCount: 0 },
        { date: "2027-07-29", unavailableReasons: ["PROTECTED_APPOINTMENT_CONFLICT"], displacementCount: 0 },
        { date: "2027-07-30", unavailableReasons: ["CPU_CLINIC_UNAVAILABLE"], displacementCount: 0 },
        { date: "2027-07-31", unavailableReasons: ["CPU_CLINIC_UNAVAILABLE"], displacementCount: 0 },
      ],
    });
    expect(exhausted.canPublish).toBe(false);
    expect(exhausted.blockers).toEqual([{
      code: "FIRST_YEAR_PE_HORIZON_EXHAUSTED",
      message: "The academic-year scheduling horizon cannot fit the complete First Year batch.",
      details: { scheduledStudentCount: 2, unscheduledStudentCount: 1 },
    }]);
  });

  it("blocks an unavailable Laboratory date before allocating PE dates", () => {
    const plan = planFirstYearScheduleImport({
      laboratoryDate: "2026-09-22",
      cycleStartDate: "2026-08-01",
      cycleEndDate: "2027-07-31",
      physicalExamMaximumCapacity: 150,
      members: members(1),
      laboratoryUnavailableReasons: ["OFFICIAL_CLOSURE"],
      physicalExamCandidates: [
        { date: "2026-09-29", unavailableReasons: [], displacementCount: 0 },
      ],
    });

    expect(plan.canPublish).toBe(false);
    expect(plan.allocations).toEqual([]);
    expect(plan.blockers[0]).toMatchObject({ code: "FIRST_YEAR_LABORATORY_UNAVAILABLE" });
  });
});
