import "server-only";

export type CoordinatorScheduleType = "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
export type AppointmentScheduleType = Exclude<CoordinatorScheduleType, "BOTH">;
export type CapacityStatus = "VALID" | "CONFLICT";

export type CapacitySetting = {
  clinicId: string;
  scheduleType: AppointmentScheduleType;
  maxDailyCapacity: number;
};

export type ScheduleItemInput = {
  id: string;
  clinicId: string;
  studentNumber: string;
  scheduleType: CoordinatorScheduleType;
  priorityRank: number;
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
};

export type ExistingLoad = {
  clinicId: string;
  date: string;
  scheduleType: AppointmentScheduleType;
  count: number;
};

export type DraftAppointment = {
  scheduleItemId: string;
  clinicId: string;
  studentNumber: string;
  scheduleType: AppointmentScheduleType;
  appointmentDate: string;
};

export type CapacityCheckResult = {
  status: CapacityStatus;
  clinicId: string;
  date: string;
  scheduleType: AppointmentScheduleType;
  count: number;
  maxCapacity: number;
  message: string;
};

export type UnscheduledItem = {
  scheduleItemId: string;
  studentNumber: string;
  code: "NO_ELIGIBLE_DATE" | "NO_CAPACITY";
  message: string;
};

export type GenerateScheduleInput = {
  items: ScheduleItemInput[];
  capacities: CapacitySetting[];
  existingLoad: ExistingLoad[];
};

export type GenerateScheduleOutput = {
  appointments: DraftAppointment[];
  unscheduledItems: UnscheduledItem[];
  capacityResults: CapacityCheckResult[];
};

export type StudentCategory = "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";

export type PairedScheduleRequest = {
  requestId: string;
  studentNumber: string;
  category: StudentCategory;
  acceptedAt: string;
  sourceRowOrder: number;
  windowStart: string;
};

export type PairedAssignment = {
  requestId: string;
  studentNumber: string;
  schedulePairId: string;
  laboratoryDate: string;
  physicalExamDate: string;
};

export type PairedScheduleCapacity = {
  maxDailyCapacity: number;
};

export type GeneratePairedScheduleInput = {
  requests: PairedScheduleRequest[];
  laboratoryCapacity: PairedScheduleCapacity;
  physicalExamCapacity: PairedScheduleCapacity;
  existingLaboratoryLoad: Record<string, number>;
  existingPhysicalExamLoad: Record<string, number>;
  blockedLaboratoryDates: string[];
  blockedPhysicalExamDates: string[];
  searchEndDate: string;
};

export type GeneratePairedScheduleOutput = {
  assignments: PairedAssignment[];
  unscheduledRequestIds: string[];
};
