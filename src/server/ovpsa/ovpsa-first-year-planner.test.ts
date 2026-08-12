import { describe, expect, it } from "vitest";

import {
  buildOvpsaBatchPreview,
  type OvpsaPlanningStudent,
} from "./ovpsa-first-year-planner";

const students: OvpsaPlanningStudent[] = [
  {
    studentNumber: "26-0001-01",
    studentName: "First, Ana Maria",
    collegeId: "college-1",
    collegeName: "College One",
    programId: "program-1",
    programCode: "BS-ONE",
    programName: "Program One",
    yearLevel: 1,
    isActive: true,
  },
  {
    studentNumber: "26-0002-02",
    studentName: "Second, Ben",
    collegeId: "college-1",
    collegeName: "College One",
    programId: "program-1",
    programCode: "BS-ONE",
    programName: "Program One",
    yearLevel: 2,
    isActive: true,
  },
  {
    studentNumber: "26-0003-03",
    studentName: "Inactive, Cara",
    collegeId: "college-1",
    collegeName: "College One",
    programId: "program-1",
    programCode: "BS-ONE",
    programName: "Program One",
    yearLevel: 1,
    isActive: false,
  },
  {
    studentNumber: "26-0004-04",
    studentName: "Other, Dan",
    collegeId: "college-2",
    collegeName: "College Two",
    programId: "program-2",
    programCode: "BS-TWO",
    programName: "Program Two",
    yearLevel: 1,
    isActive: true,
  },
];

function preview(overrides: Record<string, unknown> = {}) {
  return buildOvpsaBatchPreview({
    scheduleCycleStart: 2026,
    cycleStartDate: "2026-08-01",
    cycleEndDate: "2027-07-31",
    collegeId: "college-1",
    laboratoryDate: "2026-09-06",
    physicalExamDateOverride: null,
    physicalExamExceptionReason: null,
    today: "2026-08-12",
    students,
    cpuPhysicalExamMaximumCapacity: 10,
    globallyClosedDates: [],
    reservedLaboratoryDates: [],
    reservedPhysicalExamDates: [],
    protectedConflicts: [],
    displacements: [],
    proposedReplacements: [],
    ...overrides,
  });
}

describe("First Year OVPSA planner", () => {
  it("selects only active current Year 1 students in the chosen college", () => {
    const result = preview();

    expect(result.members).toEqual([students[0]]);
    expect(result.memberCount).toBe(1);
    expect(result.laboratory).toEqual({
      date: "2026-09-06",
      locationName: "Iloilo Mission Hospital",
      capacityConsumed: 0,
    });
  });

  it("accepts an OVPSA weekend Laboratory date and defaults PE to exactly +7", () => {
    const result = preview();

    expect(new Date(`${result.laboratory.date}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(result.physicalExam.date).toBe("2026-09-13");
    expect(result.physicalExam.isException).toBe(false);
    expect(result.blockers).toEqual([expect.objectContaining({
      code: "OVPSA_PHYSICAL_EXAM_WEEKDAY_REQUIRED",
    })]);
    expect(result.canPublish).toBe(false);
  });

  it("accepts only a later weekday PE override with an auditable reason", () => {
    const valid = preview({
      physicalExamDateOverride: "2026-09-14",
      physicalExamExceptionReason: "CPU Clinic approved the Monday exception.",
    });
    expect(valid.physicalExam).toEqual({
      date: "2026-09-14",
      defaultDate: "2026-09-13",
      isException: true,
      exceptionReason: "CPU Clinic approved the Monday exception.",
      maximumCapacity: 10,
      requiredCapacity: 1,
    });
    expect(valid.canPublish).toBe(true);

    expect(preview({
      physicalExamDateOverride: "2026-09-12",
      physicalExamExceptionReason: "Too early.",
    }).blockers).toContainEqual(expect.objectContaining({
      code: "OVPSA_PHYSICAL_EXAM_OVERRIDE_TOO_EARLY",
    }));
    expect(preview({
      physicalExamDateOverride: "2026-09-14",
      physicalExamExceptionReason: " ",
    }).blockers).toContainEqual(expect.objectContaining({
      code: "OVPSA_PHYSICAL_EXAM_EXCEPTION_REASON_REQUIRED",
    }));
  });

  it("blocks closed dates, matching-service reservations, and PE over-capacity", () => {
    const result = preview({
      physicalExamDateOverride: "2026-09-14",
      physicalExamExceptionReason: "Approved.",
      globallyClosedDates: ["2026-09-06"],
      reservedLaboratoryDates: ["2026-09-06"],
      reservedPhysicalExamDates: ["2026-09-14"],
      cpuPhysicalExamMaximumCapacity: 0,
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "OVPSA_LABORATORY_DATE_CLOSED",
      "OVPSA_LABORATORY_DATE_RESERVED",
      "OVPSA_PHYSICAL_EXAM_DATE_RESERVED",
      "OVPSA_PHYSICAL_EXAM_CAPACITY_INSUFFICIENT",
    ]);
  });

  it("keeps actionable protected conflicts and displacement details serializable", () => {
    const protectedConflict = {
      studentNumber: "26-0099-99",
      appointmentId: "appointment-protected",
      scheduleType: "LABORATORY" as const,
      appointmentDate: "2026-09-06",
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
      message: "Draft result files must be resolved before publication.",
    };
    const displacement = {
      studentNumber: "25-0001-01",
      category: "TOUR" as const,
      acceptedAt: "2026-08-01T00:00:00.000Z",
      sourceRowOrder: 1,
      oldLaboratoryDate: "2026-09-06",
      oldPhysicalExamDate: "2026-09-08",
      displacementType: "PAIR" as const,
    };
    const replacement = {
      studentNumber: "25-0001-01",
      category: "TOUR" as const,
      laboratoryDate: "2026-09-07",
      physicalExamDate: "2026-09-09",
    };
    const result = preview({
      physicalExamDateOverride: "2026-09-14",
      physicalExamExceptionReason: "Approved.",
      protectedConflicts: [protectedConflict],
      displacements: [displacement],
      proposedReplacements: [replacement],
    });

    expect(result.protectedConflicts).toEqual([protectedConflict]);
    expect(result.displacements).toEqual([displacement]);
    expect(result.proposedReplacements).toEqual([replacement]);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
    }));
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
