import "server-only";

export type AppointmentScheduleType = "PHYSICAL_EXAM" | "LABORATORY";
export type CapacityStatus = "VALID" | "CONFLICT";

export type CapacitySetting = {
  clinicId: string;
  scheduleType: AppointmentScheduleType;
  maxDailyCapacity: number;
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

export type StudentCategory = "REGULAR" | "OJT" | "TOUR";

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
