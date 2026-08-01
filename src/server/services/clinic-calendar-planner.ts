import type {
  ClinicCalendarBlockChange,
  ClinicCalendarClosureGroupPreview,
  ClinicManualCaseReason,
} from "@/types/clinic-calendar";
import type { AppointmentResultProtectionState } from "@/server/appointments/appointment-result-protection";

export type ClinicCycleAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  isManuallyLocked: boolean;
  resultProtectionState: AppointmentResultProtectionState;
  schedulePairId: string | null;
  scheduleCycleStart: number;
};

export type ClinicCycleClassification =
  | {
      strategy: "MOVE_COMPLETE_PAIR";
      laboratory: ClinicCycleAppointment;
      physicalExam: ClinicCycleAppointment;
    }
  | {
      strategy: "MOVE_PHYSICAL_ONLY";
      laboratory: ClinicCycleAppointment;
      physicalExam: ClinicCycleAppointment;
    }
  | {
      strategy: "PRESERVE_COMPLETION";
      laboratory: ClinicCycleAppointment;
      physicalExam: ClinicCycleAppointment;
    }
  | {
      strategy: "MANUAL_RESOLUTION_REQUIRED";
      reasonCode: ClinicManualCaseReason;
      reasonMessage: string;
      laboratory: ClinicCycleAppointment | null;
      physicalExam: ClinicCycleAppointment | null;
    };

export type ReplacementCapacity = {
  LABORATORY: number;
  PHYSICAL_EXAM: number;
};

export type UsedReplacementCapacity = {
  LABORATORY: Map<string, number>;
  PHYSICAL_EXAM: Map<string, number>;
};

export class ClinicCalendarPlanningError extends Error {
  readonly reasonCode: ClinicManualCaseReason;

  constructor(reasonCode: ClinicManualCaseReason, message: string) {
    super(message);
    this.name = "ClinicCalendarPlanningError";
    this.reasonCode = reasonCode;
  }
}

export function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isClinicSchedulingWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

export function normalizeClosureReason(reason: string) {
  return reason.trim().replace(/\s+/g, " ");
}

export function groupContiguousClosureChanges(
  changes: ClinicCalendarBlockChange[],
): ClinicCalendarClosureGroupPreview[] {
  const sorted = [...changes]
    .map((change) => ({ ...change, reason: normalizeClosureReason(change.reason) }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const groups: ClinicCalendarClosureGroupPreview[] = [];
  for (const change of sorted) {
    const previous = groups.at(-1);
    if (
      previous
      && addCalendarDays(previous.endDate, 1) === change.date
      && previous.category === change.category
      && previous.reason === change.reason
    ) {
      previous.endDate = change.date;
      previous.dates.push(change.date);
      continue;
    }
    groups.push({
      startDate: change.date,
      endDate: change.date,
      dates: [change.date],
      category: change.category,
      reason: change.reason,
    });
  }
  return groups;
}

function manual(
  reasonCode: ClinicManualCaseReason,
  reasonMessage: string,
  laboratory: ClinicCycleAppointment | null,
  physicalExam: ClinicCycleAppointment | null,
): ClinicCycleClassification {
  return {
    strategy: "MANUAL_RESOLUTION_REQUIRED",
    reasonCode,
    reasonMessage,
    laboratory,
    physicalExam,
  };
}

export function classifyClinicCycle(
  appointments: ClinicCycleAppointment[],
): ClinicCycleClassification {
  const laboratoryRows = appointments.filter((item) => item.scheduleType === "LABORATORY");
  const physicalRows = appointments.filter((item) => item.scheduleType === "PHYSICAL_EXAM");
  const laboratory = laboratoryRows.length === 1 ? laboratoryRows[0] : null;
  const physicalExam = physicalRows.length === 1 ? physicalRows[0] : null;
  if (!laboratory || !physicalExam) {
    return manual(
      "PAIR_MISSING_OR_INCONSISTENT",
      "The current clinic cycle does not contain exactly one Laboratory and one Physical Examination appointment.",
      laboratory,
      physicalExam,
    );
  }
  if (
    laboratory.studentNumber !== physicalExam.studentNumber
    || laboratory.scheduleCycleStart !== physicalExam.scheduleCycleStart
    || laboratory.schedulePairId !== physicalExam.schedulePairId
  ) {
    return manual(
      "PAIR_MISSING_OR_INCONSISTENT",
      "The current Laboratory and Physical Examination appointments do not share one cycle and pair.",
      laboratory,
      physicalExam,
    );
  }
  if (laboratory.isManuallyLocked || physicalExam.isManuallyLocked) {
    return manual(
      "APPOINTMENT_MANUALLY_LOCKED",
      "At least one appointment is manually protected from automatic rescheduling.",
      laboratory,
      physicalExam,
    );
  }
  const protectionStates = [laboratory.resultProtectionState, physicalExam.resultProtectionState];
  if (protectionStates.some(
    (state) => state.type === "PROTECTED" && state.reason === "DRAFT_RESULT_FILES_EXIST",
  )) {
    return manual(
      "DRAFT_RESULT_FILES_EXIST",
      "At least one appointment has active files in a draft result submission.",
      laboratory,
      physicalExam,
    );
  }
  if (protectionStates.some((state) => state.type === "PROTECTED")) {
    return manual(
      "PROTECTED_RESULTS_EXIST",
      "At least one appointment has protected result data.",
      laboratory,
      physicalExam,
    );
  }

  const labCompleted = laboratory.status === "COMPLETED";
  const physicalCompleted = physicalExam.status === "COMPLETED";
  const unfinished = new Set(["DRAFT", "PENDING"]);
  if (labCompleted && physicalCompleted) {
    return { strategy: "PRESERVE_COMPLETION", laboratory, physicalExam };
  }
  if (labCompleted && unfinished.has(physicalExam.status)) {
    return { strategy: "MOVE_PHYSICAL_ONLY", laboratory, physicalExam };
  }
  if (unfinished.has(laboratory.status) && unfinished.has(physicalExam.status)) {
    return { strategy: "MOVE_COMPLETE_PAIR", laboratory, physicalExam };
  }
  if (unfinished.has(laboratory.status) && physicalCompleted) {
    return manual(
      "PHYSICAL_COMPLETED_BEFORE_LABORATORY",
      "Physical Examination is completed while Laboratory remains unfinished.",
      laboratory,
      physicalExam,
    );
  }
  return manual(
    "PAIR_MISSING_OR_INCONSISTENT",
    "The current appointment statuses cannot be safely rescheduled automatically.",
    laboratory,
    physicalExam,
  );
}

function nextCapacityDate(input: {
  afterDate: string;
  scheduleType: keyof ReplacementCapacity;
  blockedDates: Set<string>;
  usedCapacity: UsedReplacementCapacity;
  capacity: ReplacementCapacity;
}) {
  const horizon = addCalendarDays(input.afterDate, 366 * 5);
  for (
    let candidate = addCalendarDays(input.afterDate, 1);
    candidate <= horizon;
    candidate = addCalendarDays(candidate, 1)
  ) {
    if (!isClinicSchedulingWeekday(candidate) || input.blockedDates.has(candidate)) continue;
    if ((input.usedCapacity[input.scheduleType].get(candidate) ?? 0) >= input.capacity[input.scheduleType]) {
      continue;
    }
    return candidate;
  }
  throw new ClinicCalendarPlanningError(
    "NO_REPLACEMENT_CAPACITY",
    `No ${input.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"} capacity is available within five years.`,
  );
}

export function allocateReplacementDates(input: {
  strategy: "MOVE_COMPLETE_PAIR" | "MOVE_PHYSICAL_ONLY";
  afterDate: string;
  blockedDates: Set<string>;
  usedCapacity: UsedReplacementCapacity;
  capacity: ReplacementCapacity;
}) {
  if (input.strategy === "MOVE_PHYSICAL_ONLY") {
    return {
      physicalExamDate: nextCapacityDate({
        ...input,
        scheduleType: "PHYSICAL_EXAM",
      }),
    };
  }
  const laboratoryDate = nextCapacityDate({ ...input, scheduleType: "LABORATORY" });
  const physicalExamDate = nextCapacityDate({
    ...input,
    afterDate: laboratoryDate,
    scheduleType: "PHYSICAL_EXAM",
  });
  return { laboratoryDate, physicalExamDate };
}
