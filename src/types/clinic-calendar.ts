export type ClinicCalendarCategory =
  | "HOLIDAY"
  | "CLOSURE"
  | "EMERGENCY_CLOSURE"
  | "MAINTENANCE"
  | "STAFF_UNAVAILABILITY";

export type ClinicCalendarBlockChange = {
  action: "BLOCK";
  date: string;
  category: ClinicCalendarCategory;
  reason: string;
};

export type ClinicCalendarReopenChange = {
  action: "REOPEN";
  date: string;
  unavailableDateId: string;
  expectedUpdatedAt: string;
};

export type ClinicCalendarChange = ClinicCalendarBlockChange | ClinicCalendarReopenChange;

export type ClinicCalendarOperationRequest = {
  requestId: string;
  changes: ClinicCalendarChange[];
  emergencyAcknowledged: boolean;
};

export type ClinicCalendarIssue = {
  date: string;
  action: ClinicCalendarChange["action"];
  code:
    | "INVALID_CHANGE"
    | "ACTIVE_BLOCK_CONFLICT"
    | "STALE_BLOCK"
    | "EMERGENCY_ACKNOWLEDGMENT_REQUIRED"
    | "WEEKEND_NOT_EDITABLE"
    | "PAST_DATE_NOT_EDITABLE"
    | "MANUAL_RESOLUTION_REQUIRED";
  message: string;
  studentNumbers?: string[];
  appointmentIds?: string[];
};

export type ClinicUnavailableDateDto = {
  id: string;
  closureGroupId: string;
  blockedDate: string;
  groupStartDate: string;
  groupEndDate: string;
  category: ClinicCalendarCategory;
  reason: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type ClinicCalendarClosureGroupPreview = {
  startDate: string;
  endDate: string;
  dates: string[];
  category: ClinicCalendarCategory;
  reason: string;
};

export type ClinicCalendarPreviewResult = {
  requestId: string;
  closureGroups: ClinicCalendarClosureGroupPreview[];
  datesBeingReopened: string[];
  affectedStudentCount: number;
  completePairMoveCount: number;
  physicalOnlyMoveCount: number;
  preservedCompletionCount: number;
  expectedManualCaseCount: number;
  expectedRestorationCount: number;
  retainedReplacementCount: number;
};

export type ClinicCalendarOperationResult = {
  requestId: string;
  batchId: string;
  activeUnavailableDates: ClinicUnavailableDateDto[];
  blockedDateCount: number;
  reopenedDateCount: number;
  movedStudentCount: number;
  movedAppointmentCount: number;
  preservedCompletionCount: number;
  manualCaseCount: number;
  restoredStudentCount: number;
  restoredAppointmentCount: number;
};

export type ClinicManualCaseReason =
  | "PHYSICAL_COMPLETED_BEFORE_LABORATORY"
  | "APPOINTMENT_MANUALLY_LOCKED"
  | "DRAFT_RESULT_FILES_EXIST"
  | "PROTECTED_RESULTS_EXIST"
  | "PAIR_MISSING_OR_INCONSISTENT"
  | "NO_REPLACEMENT_CAPACITY"
  | "CONCURRENT_APPOINTMENT_CHANGE"
  | "UNSAFE_RESTORATION";

export type ClinicManualCaseResolutionRequest =
  | {
      action: "ASSIGN_REPLACEMENT";
      expectedOptimisticToken: string;
      laboratoryDate?: string;
      physicalExamDate?: string;
      reason: string;
    }
  | {
      action: "KEEP_CURRENT_REPLACEMENT";
      expectedOptimisticToken: string;
      reason: string;
    };
