export type ClinicCalendarCategory =
  | "HOLIDAY"
  | "CLOSURE"
  | "MAINTENANCE"
  | "STAFF_UNAVAILABILITY";

export type ClinicCalendarBlockChange = {
  action: "BLOCK";
  clinicId: string;
  date: string;
  category: ClinicCalendarCategory;
  reason: string;
};

export type ClinicCalendarUnblockChange = {
  action: "UNBLOCK";
  clinicId: string;
  date: string;
  unavailableDateId: string;
  expectedUpdatedAt: string;
};

export type ClinicCalendarBatchChange =
  | ClinicCalendarBlockChange
  | ClinicCalendarUnblockChange;

export type ClinicCalendarBatchRequest = {
  changes: ClinicCalendarBatchChange[];
};

export type ClinicCalendarBatchIssue = {
  clinicId: string;
  date: string;
  action: ClinicCalendarBatchChange["action"];
  code:
    | "INVALID_CHANGE"
    | "ACTIVE_BLOCK_CONFLICT"
    | "STALE_BLOCK"
    | "PROTECTED_REPLACEMENT"
    | "MISSING_ORIGINAL"
    | "CAPACITY_CONFLICT"
    | "PAIR_INTEGRITY_FAILURE";
  message: string;
  studentNumbers?: string[];
  appointmentIds?: string[];
};

export type ClinicUnavailableDateDto = {
  id: string;
  clinicId: string;
  clinicCode: string;
  clinicName: string;
  startDate: string;
  endDate: string;
  category: ClinicCalendarCategory;
  reason: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type ClinicCalendarDraftChange = ClinicCalendarBatchChange;

export type ClinicCalendarBatchResult = {
  batchId: string;
  activeUnavailableDates: ClinicUnavailableDateDto[];
  blockedDateCount: number;
  unblockedDateCount: number;
  movedStudentCount: number;
  movedAppointmentCount: number;
  restoredStudentCount: number;
  restoredAppointmentCount: number;
};
