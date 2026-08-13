import { OVPSA_LABORATORY_LOCATION } from "./ovpsa-first-year-planner";

export type FirstYearUnavailableReason =
  | "NON_SERVICE_DAY"
  | "OFFICIAL_CLOSURE"
  | "CPU_CLINIC_UNAVAILABLE"
  | "FIRST_YEAR_DATE_RESERVED"
  | "PROTECTED_APPOINTMENT_CONFLICT"
  | "REPLACEMENT_CAPACITY_EXHAUSTED"
  | "OUTSIDE_SCHEDULING_CYCLE";

export type FirstYearImportPlanningMember = {
  studentNumber: string;
  sourceRowNumber: number;
};

export type FirstYearPhysicalExamCandidate = {
  date: string;
  unavailableReasons: FirstYearUnavailableReason[];
  displacementCount: number;
};

export type FirstYearImportBlocker = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type FirstYearImportPlan = {
  memberCount: number;
  laboratory: {
    date: string;
    locationName: typeof OVPSA_LABORATORY_LOCATION;
  };
  firstPhysicalExamCandidate: string;
  physicalExamMaximumCapacity: number;
  estimatedPhysicalExamDateCount: number;
  members: Array<FirstYearImportPlanningMember & {
    allocationPosition: number;
    assignedPhysicalExamDate: string;
  }>;
  allocations: Array<{
    date: string;
    studentCount: number;
    capacity: number;
    firstPosition: number;
    lastPosition: number;
  }>;
  skippedDates: Array<{
    date: string;
    reasons: FirstYearUnavailableReason[];
  }>;
  displacementTotal: number;
  blockers: FirstYearImportBlocker[];
  canPublish: boolean;
};

type FirstYearImportPlanningInput = {
  laboratoryDate: string;
  cycleStartDate: string;
  cycleEndDate: string;
  physicalExamMaximumCapacity: number;
  members: FirstYearImportPlanningMember[];
  laboratoryUnavailableReasons: FirstYearUnavailableReason[];
  physicalExamCandidates: FirstYearPhysicalExamCandidate[];
};

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function planFirstYearScheduleImport(
  input: FirstYearImportPlanningInput,
): FirstYearImportPlan {
  const orderedMembers = [...input.members].sort(
    (left, right) => left.sourceRowNumber - right.sourceRowNumber,
  );
  const firstPhysicalExamCandidate = addCalendarDays(input.laboratoryDate, 7);
  const estimatedPhysicalExamDateCount = input.physicalExamMaximumCapacity > 0
    ? Math.ceil(orderedMembers.length / input.physicalExamMaximumCapacity)
    : 0;
  const base = {
    memberCount: orderedMembers.length,
    laboratory: {
      date: input.laboratoryDate,
      locationName: OVPSA_LABORATORY_LOCATION,
    },
    firstPhysicalExamCandidate,
    physicalExamMaximumCapacity: input.physicalExamMaximumCapacity,
    estimatedPhysicalExamDateCount,
  };

  const blockers: FirstYearImportBlocker[] = [];
  const laboratoryUnavailableReasons = [...new Set(input.laboratoryUnavailableReasons)];
  if (
    input.laboratoryDate < input.cycleStartDate
    || input.laboratoryDate > input.cycleEndDate
  ) {
    laboratoryUnavailableReasons.push("OUTSIDE_SCHEDULING_CYCLE");
  }
  if (laboratoryUnavailableReasons.length) {
    blockers.push({
      code: "FIRST_YEAR_LABORATORY_UNAVAILABLE",
      message: "The selected First Year Laboratory date is unavailable.",
      details: { reasons: [...new Set(laboratoryUnavailableReasons)] },
    });
  }
  if (input.physicalExamMaximumCapacity <= 0) {
    blockers.push({
      code: "FIRST_YEAR_PE_CAPACITY_NOT_CONFIGURED",
      message: "CPU Clinic Physical Examination capacity is not configured.",
    });
  }
  if (!orderedMembers.length) {
    blockers.push({
      code: "FIRST_YEAR_IMPORT_EMPTY",
      message: "The First Year import must contain at least one student.",
    });
  }
  if (blockers.length) {
    return {
      ...base,
      members: [],
      allocations: [],
      skippedDates: [],
      displacementTotal: 0,
      blockers,
      canPublish: false,
    };
  }

  const allocations: FirstYearImportPlan["allocations"] = [];
  const skippedDates: FirstYearImportPlan["skippedDates"] = [];
  let allocatedCount = 0;
  let displacementTotal = 0;
  const candidates = [...input.physicalExamCandidates]
    .filter((candidate) => (
      candidate.date >= firstPhysicalExamCandidate
      && candidate.date <= input.cycleEndDate
    ))
    .sort((left, right) => left.date.localeCompare(right.date));

  for (const candidate of candidates) {
    if (allocatedCount >= orderedMembers.length) break;
    const reasons = [...new Set(candidate.unavailableReasons)];
    if (reasons.length) {
      skippedDates.push({ date: candidate.date, reasons });
      continue;
    }
    const studentCount = Math.min(
      input.physicalExamMaximumCapacity,
      orderedMembers.length - allocatedCount,
    );
    allocations.push({
      date: candidate.date,
      studentCount,
      capacity: input.physicalExamMaximumCapacity,
      firstPosition: allocatedCount + 1,
      lastPosition: allocatedCount + studentCount,
    });
    allocatedCount += studentCount;
    displacementTotal += candidate.displacementCount;
  }

  if (allocatedCount < orderedMembers.length) {
    blockers.push({
      code: "FIRST_YEAR_PE_HORIZON_EXHAUSTED",
      message: "The academic-year scheduling horizon cannot fit the complete First Year batch.",
      details: {
        scheduledStudentCount: allocatedCount,
        unscheduledStudentCount: orderedMembers.length - allocatedCount,
      },
    });
  }

  const members = blockers.length
    ? []
    : allocations.flatMap((allocation) => orderedMembers
        .slice(allocation.firstPosition - 1, allocation.lastPosition)
        .map((member, index) => ({
          ...member,
          allocationPosition: allocation.firstPosition + index,
          assignedPhysicalExamDate: allocation.date,
        })));

  return {
    ...base,
    members,
    allocations,
    skippedDates,
    displacementTotal,
    blockers,
    canPublish: blockers.length === 0,
  };
}
