export const OVPSA_LABORATORY_LOCATION = "Iloilo Mission Hospital";

export type LowerPriorityCategory = "REGULAR" | "OJT" | "TOUR";
export type ScheduleType = "LABORATORY" | "PHYSICAL_EXAM";

export type OvpsaPlanningStudent = {
  studentNumber: string;
  studentName: string;
  collegeId: string;
  collegeName: string;
  programId: string;
  programCode: string;
  programName: string;
  yearLevel: number | null;
  isActive: boolean;
};

export type OvpsaProtectedConflict = {
  studentNumber: string;
  appointmentId: string;
  scheduleType: ScheduleType;
  appointmentDate: string;
  reasonCode: string;
  message: string;
};

export type OvpsaDisplacement = {
  studentNumber: string;
  category: LowerPriorityCategory;
  acceptedAt: string;
  sourceRowOrder: number;
  oldLaboratoryDate: string | null;
  oldPhysicalExamDate: string | null;
  displacementType: "PAIR" | "PHYSICAL_EXAM_ONLY";
};

export type OvpsaProposedReplacement = {
  studentNumber: string;
  category: LowerPriorityCategory;
  laboratoryDate: string | null;
  physicalExamDate: string;
};

export type OvpsaBatchBlocker = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type OvpsaBatchPreview = {
  scheduleCycleStart: number;
  collegeId: string;
  members: OvpsaPlanningStudent[];
  memberCount: number;
  laboratory: {
    date: string;
    locationName: typeof OVPSA_LABORATORY_LOCATION;
    capacityConsumed: 0;
  };
  physicalExam: {
    date: string;
    defaultDate: string;
    isException: boolean;
    exceptionReason: string | null;
    maximumCapacity: number;
    requiredCapacity: number;
  };
  protectedConflicts: OvpsaProtectedConflict[];
  displacements: OvpsaDisplacement[];
  proposedReplacements: OvpsaProposedReplacement[];
  additionalBlockers?: OvpsaBatchBlocker[];
  blockers: OvpsaBatchBlocker[];
  canPublish: boolean;
};

type OvpsaBatchPlanningInput = {
  scheduleCycleStart: number;
  cycleStartDate: string;
  cycleEndDate: string;
  collegeId: string;
  laboratoryDate: string;
  physicalExamDateOverride: string | null;
  physicalExamExceptionReason: string | null;
  today: string;
  students: OvpsaPlanningStudent[];
  cpuPhysicalExamMaximumCapacity: number;
  globallyClosedDates: string[];
  reservedLaboratoryDates: string[];
  reservedPhysicalExamDates: string[];
  protectedConflicts: OvpsaProtectedConflict[];
  displacements: OvpsaDisplacement[];
  proposedReplacements: OvpsaProposedReplacement[];
  additionalBlockers?: OvpsaBatchBlocker[];
};

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isWeekday(date: string) {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function pushBlocker(
  blockers: OvpsaBatchBlocker[],
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  blockers.push({ code, message, ...(details ? { details } : {}) });
}

export function buildOvpsaBatchPreview(
  input: OvpsaBatchPlanningInput,
): OvpsaBatchPreview {
  const members = input.students
    .filter((student) => (
      student.isActive
      && student.yearLevel === 1
      && student.collegeId === input.collegeId
    ))
    .sort((left, right) => (
      left.studentName.localeCompare(right.studentName)
      || left.studentNumber.localeCompare(right.studentNumber)
    ));
  const defaultPhysicalExamDate = addCalendarDays(input.laboratoryDate, 7);
  const physicalExamDate = input.physicalExamDateOverride ?? defaultPhysicalExamDate;
  const exceptionReason = input.physicalExamExceptionReason?.trim() || null;
  const blockers: OvpsaBatchBlocker[] = [];
  const closed = new Set(input.globallyClosedDates);

  if (!members.length) {
    pushBlocker(
      blockers,
      "OVPSA_NO_ELIGIBLE_FIRST_YEAR_STUDENTS",
      "The selected college has no active Year 1 students for this cycle.",
    );
  }
  if (input.laboratoryDate < input.today) {
    pushBlocker(
      blockers,
      "OVPSA_LABORATORY_DATE_IN_PAST",
      "The OVPSA Laboratory date must be current or future.",
    );
  }
  if (
    input.laboratoryDate < input.cycleStartDate
    || input.laboratoryDate > input.cycleEndDate
  ) {
    pushBlocker(
      blockers,
      "OVPSA_LABORATORY_DATE_OUTSIDE_CYCLE",
      "The OVPSA Laboratory date must be inside the selected academic cycle.",
    );
  }
  if (closed.has(input.laboratoryDate)) {
    pushBlocker(
      blockers,
      "OVPSA_LABORATORY_DATE_CLOSED",
      "The selected OVPSA Laboratory date is officially closed.",
    );
  }
  if (input.reservedLaboratoryDates.includes(input.laboratoryDate)) {
    pushBlocker(
      blockers,
      "OVPSA_LABORATORY_DATE_RESERVED",
      "Another active First Year batch owns this Laboratory date.",
    );
  }
  if (input.physicalExamDateOverride && physicalExamDate < defaultPhysicalExamDate) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_OVERRIDE_TOO_EARLY",
      "A Physical Examination exception cannot be earlier than Laboratory plus seven days.",
    );
  }
  if (input.physicalExamDateOverride && !exceptionReason) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_EXCEPTION_REASON_REQUIRED",
      "A later Physical Examination date requires an auditable reason.",
    );
  }
  if (!isWeekday(physicalExamDate)) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_WEEKDAY_REQUIRED",
      "The CPU Clinic Physical Examination date must be a weekday.",
    );
  }
  if (physicalExamDate < input.cycleStartDate || physicalExamDate > input.cycleEndDate) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_DATE_OUTSIDE_CYCLE",
      "The Physical Examination date must be inside the selected academic cycle.",
    );
  }
  if (closed.has(physicalExamDate)) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_DATE_CLOSED",
      "The selected CPU Clinic Physical Examination date is officially closed.",
    );
  }
  if (input.reservedPhysicalExamDates.includes(physicalExamDate)) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_DATE_RESERVED",
      "Another active First Year batch owns this Physical Examination date.",
    );
  }
  if (members.length > input.cpuPhysicalExamMaximumCapacity) {
    pushBlocker(
      blockers,
      "OVPSA_PHYSICAL_EXAM_CAPACITY_INSUFFICIENT",
      "CPU Clinic Physical Examination capacity is smaller than the complete batch.",
      {
        requiredCapacity: members.length,
        maximumCapacity: input.cpuPhysicalExamMaximumCapacity,
      },
    );
  }
  if (input.protectedConflicts.length) {
    pushBlocker(
      blockers,
      "OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
      "Protected appointments must be resolved before this First Year batch can publish.",
      { appointmentIds: input.protectedConflicts.map((conflict) => conflict.appointmentId) },
    );
  }
  blockers.push(...(input.additionalBlockers ?? []));

  return {
    scheduleCycleStart: input.scheduleCycleStart,
    collegeId: input.collegeId,
    members,
    memberCount: members.length,
    laboratory: {
      date: input.laboratoryDate,
      locationName: OVPSA_LABORATORY_LOCATION,
      capacityConsumed: 0,
    },
    physicalExam: {
      date: physicalExamDate,
      defaultDate: defaultPhysicalExamDate,
      isException: physicalExamDate !== defaultPhysicalExamDate,
      exceptionReason,
      maximumCapacity: input.cpuPhysicalExamMaximumCapacity,
      requiredCapacity: members.length,
    },
    protectedConflicts: input.protectedConflicts,
    displacements: input.displacements,
    proposedReplacements: input.proposedReplacements,
    blockers,
    canPublish: blockers.length === 0,
  };
}
