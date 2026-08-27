export type ClinicCalendarCategory =
  | "HOLIDAY"
  | "CLOSURE"
  | "EMERGENCY_CLOSURE"
  | "MAINTENANCE"
  | "STAFF_UNAVAILABILITY";

export type ClinicClosureRecoveryMode = "AUTO_ELIGIBLE" | "MANUAL_ALL";

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
  recoveryMode: ClinicClosureRecoveryMode;
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
  recoveryMode?: ClinicClosureRecoveryMode;
  policyEffectiveDate?: string;
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
  automaticRecoveryEligibleCount: number;
  manualResolutionRequiredCount: number;
  completePairMoveEstimate: number;
  laboratoryOnlyMoveEstimate: number;
  physicalOnlyMoveEstimate: number;
  preservedAppointmentCount: number;
  expectedCapacityFallbackCount: number;
  manualReasonGroups: ClinicCalendarReasonCount[];
};

export type ClinicCalendarReasonCount = {
  reasonCode: ClinicManualCaseReason;
  count: number;
};

export type ClinicCalendarOperationResult = {
  requestId: string;
  batchId: string;
  activeUnavailableDates: ClinicUnavailableDateDto[];
  blockedDateCount: number;
  reopenedDateCount: number;
  autoRecoveredStudentCount: number;
  movedStudentCount: number;
  movedAppointmentCount: number;
  preservedAppointmentCount: number;
  manualCaseCount: number;
  capacityFallbackCount: number;
  manualReasonGroups: ClinicCalendarReasonCount[];
  notificationWarningCount: number;
};

export type ClinicManualCaseReason =
  | "EMERGENCY_CLOSURE"
  | "NOTICE_PERIOD_PROTECTED"
  | "OVPSA_LABORATORY_PROTECTED"
  | "ADMIN_CHOSE_MANUAL_RECOVERY"
  | "PHYSICAL_COMPLETED_BEFORE_LABORATORY"
  | "APPOINTMENT_MANUALLY_LOCKED"
  | "DRAFT_RESULT_FILES_EXIST"
  | "PROTECTED_RESULTS_EXIST"
  | "PAIR_MISSING_OR_INCONSISTENT"
  | "NO_REPLACEMENT_CAPACITY"
  | "NO_VALID_REPLACEMENT_WITHIN_CYCLE"
  | "CONCURRENT_APPOINTMENT_CHANGE"
  | "UNSAFE_RESTORATION";

export type ClinicManualCaseSource = "CLINIC_CLOSURE" | "AUTOMATIC_DISPLACEMENT";

export type ClinicManualCaseDto = {
  id: string;
  studentNumber: string;
  studentName: string;
  caseSource: ClinicManualCaseSource;
  closureGroupId: string | null;
  groupStartDate: string | null;
  groupEndDate: string | null;
  reasonCode: ClinicManualCaseReason;
  reasonMessage: string;
  status: "OPEN" | "RESOLVED";
  optimisticToken: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionAction:
    | "ASSIGN_REPLACEMENT"
    | "KEEP_CURRENT_REPLACEMENT"
    | "RESTORE_ORIGINAL"
    | null;
  resolutionDetails: unknown;
  policyMetadata: Record<string, unknown>;
  ovpsaBatchId: string | null;
  ovpsaBatchOptimisticToken: string | null;
  category: ClinicCalendarCategory | null;
  closureReason: string | null;
  laboratory: {
    id: string;
    date: string;
    status: string;
    affected: boolean;
  } | null;
  physicalExam: {
    id: string;
    date: string;
    status: string;
    affected: boolean;
  } | null;
  currentAssignmentBlock: {
    code: "DRAFT_RESULT_FILES_EXIST" | "PROTECTED_RESULTS_EXIST" | "APPOINTMENT_MANUALLY_LOCKED";
    message: string;
  } | null;
};

export type ClinicManualCasePageDto = {
  page: number;
  pageSize: number;
  total: number;
  items: ClinicManualCaseDto[];
};

export type ClinicManualCaseResolutionRequest =
  | {
      action: "ASSIGN_REPLACEMENT";
      expectedOptimisticToken: string;
      laboratoryDate?: string;
      physicalExamDate?: string;
      preserveLaboratory?: boolean;
      preservePhysicalExam?: boolean;
      reason: string;
    }
  | {
      action: "KEEP_CURRENT_REPLACEMENT";
      expectedOptimisticToken: string;
      reason: string;
    };

export type OvpsaClosureBatchCaseToken = {
  caseId: string;
  expectedOptimisticToken: string;
};

export type OvpsaClosureBatchRecoveryAllocation = {
  studentNumber: string;
  currentPhysicalExamDate: string;
  proposedPhysicalExamDate: string;
  physicalExamAction: "PRESERVE" | "MOVE";
};

export type OvpsaClosureBatchRecoveryPreview = {
  batchId: string;
  optimisticToken: string;
  replacementLaboratoryDate: string;
  linkedCaseCount: number;
  preservedPhysicalExamCount: number;
  movedPhysicalExamCount: number;
  allocations: OvpsaClosureBatchRecoveryAllocation[];
};

export type OvpsaClosureBatchRecoveryConfirmation =
  OvpsaClosureBatchRecoveryPreview & {
    revisionId: string;
    revisionNumber: number;
    notificationWarningCount: number;
  };
