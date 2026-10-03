import "server-only";

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
