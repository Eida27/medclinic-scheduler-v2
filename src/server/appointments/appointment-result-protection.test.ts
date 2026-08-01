import { describe, expect, it } from "vitest";

import {
  getAppointmentResultProtectionState,
  type AppointmentResultProtectionFacts,
} from "./appointment-result-protection";

const clearFacts: AppointmentResultProtectionFacts = {
  finalizedSubmissionId: null,
  activeDraftSubmissionId: null,
  activeDraftFileCount: 0,
  verifiedResult: null,
  pendingPlaceholder: null,
};

describe("getAppointmentResultProtectionState", () => {
  it("returns CLEAR when no result artifacts exist", () => {
    expect(getAppointmentResultProtectionState(clearFacts)).toEqual({ type: "CLEAR" });
  });

  it("returns a harmless pending placeholder", () => {
    expect(
      getAppointmentResultProtectionState({
        ...clearFacts,
        pendingPlaceholder: {
          resultId: "lab-result-1",
          resultTable: "laboratory_results",
        },
      }),
    ).toEqual({
      type: "PENDING_PLACEHOLDER",
      resultId: "lab-result-1",
      resultTable: "laboratory_results",
    });
  });

  it("protects active files attached to a draft submission", () => {
    expect(
      getAppointmentResultProtectionState({
        ...clearFacts,
        activeDraftSubmissionId: "submission-1",
        activeDraftFileCount: 2,
      }),
    ).toEqual({
      type: "PROTECTED",
      reason: "DRAFT_RESULT_FILES_EXIST",
      message: "Draft result files exist for this appointment.",
      submissionId: "submission-1",
      activeFileCount: 2,
    });
  });

  it("does not protect a draft submission with no active files", () => {
    expect(
      getAppointmentResultProtectionState({
        ...clearFacts,
        activeDraftSubmissionId: "submission-1",
      }),
    ).toEqual({ type: "CLEAR" });
  });

  it("protects finalized submissions before other result artifacts", () => {
    expect(
      getAppointmentResultProtectionState({
        ...clearFacts,
        finalizedSubmissionId: "submission-final",
        activeDraftSubmissionId: "submission-draft",
        activeDraftFileCount: 3,
        verifiedResult: {
          resultId: "exam-result-1",
          resultTable: "exam_results",
        },
      }),
    ).toEqual({
      type: "PROTECTED",
      reason: "FINALIZED_RESULT_SUBMISSION",
      message: "A finalized result submission exists for this appointment.",
      submissionId: "submission-final",
    });
  });

  it("protects verified results", () => {
    expect(
      getAppointmentResultProtectionState({
        ...clearFacts,
        verifiedResult: {
          resultId: "lab-result-2",
          resultTable: "laboratory_results",
        },
      }),
    ).toEqual({
      type: "PROTECTED",
      reason: "VERIFIED_RESULT",
      message: "A verified result exists for this appointment.",
    });
  });
});
