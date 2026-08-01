export type AppointmentResultTable = "laboratory_results" | "exam_results";

export type AppointmentResultProtectionState =
  | { type: "CLEAR" }
  | {
      type: "PENDING_PLACEHOLDER";
      resultId: string;
      resultTable: AppointmentResultTable;
    }
  | {
      type: "PROTECTED";
      reason:
        | "FINALIZED_RESULT_SUBMISSION"
        | "DRAFT_RESULT_FILES_EXIST"
        | "VERIFIED_RESULT";
      message: string;
      submissionId?: string;
      activeFileCount?: number;
    };

export type AppointmentResultProtectionFacts = {
  finalizedSubmissionId: string | null;
  activeDraftSubmissionId: string | null;
  activeDraftFileCount: number;
  verifiedResult: {
    resultId: string;
    resultTable: AppointmentResultTable;
  } | null;
  pendingPlaceholder: {
    resultId: string;
    resultTable: AppointmentResultTable;
  } | null;
};

export function getAppointmentResultProtectionState(
  facts: AppointmentResultProtectionFacts,
): AppointmentResultProtectionState {
  if (facts.finalizedSubmissionId) {
    return {
      type: "PROTECTED",
      reason: "FINALIZED_RESULT_SUBMISSION",
      message: "A finalized result submission exists for this appointment.",
      submissionId: facts.finalizedSubmissionId,
    };
  }

  if (facts.verifiedResult) {
    return {
      type: "PROTECTED",
      reason: "VERIFIED_RESULT",
      message: "A verified result exists for this appointment.",
    };
  }

  if (facts.activeDraftSubmissionId && facts.activeDraftFileCount > 0) {
    return {
      type: "PROTECTED",
      reason: "DRAFT_RESULT_FILES_EXIST",
      message: "Draft result files exist for this appointment.",
      submissionId: facts.activeDraftSubmissionId,
      activeFileCount: facts.activeDraftFileCount,
    };
  }

  if (facts.pendingPlaceholder) {
    return {
      type: "PENDING_PLACEHOLDER",
      ...facts.pendingPlaceholder,
    };
  }

  return { type: "CLEAR" };
}
