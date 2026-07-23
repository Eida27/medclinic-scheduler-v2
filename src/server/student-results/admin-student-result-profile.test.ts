import { describe, expect, it } from "vitest";

import {
  combinedSubmissionProgress,
  currentSubmissionState,
} from "./admin-student-result-profile";

describe("administrator student result profile state", () => {
  it.each([
    ["FINALIZED", "FINALIZED", "FULLY_SUBMITTED"],
    ["FINALIZED", "NOT_SUBMITTED", "PARTIALLY_SUBMITTED"],
    ["NOT_SUBMITTED", "FINALIZED", "PARTIALLY_SUBMITTED"],
    ["INVALIDATED", "FINALIZED", "AWAITING_RESUBMISSION"],
    ["FINALIZED", "INVALIDATED", "AWAITING_RESUBMISSION"],
    ["NOT_SUBMITTED", "NOT_SUBMITTED", "NOT_SUBMITTED"],
  ] as const)("maps %s and %s to %s", (laboratory, physicalExam, expected) => {
    expect(combinedSubmissionProgress(laboratory, physicalExam)).toBe(expected);
  });

  it("maps an absent submission to NOT_SUBMITTED", () => {
    expect(currentSubmissionState(null)).toBe("NOT_SUBMITTED");
  });

  it("maps a finalized submission to FINALIZED", () => {
    expect(currentSubmissionState({ status: "FINALIZED" })).toBe("FINALIZED");
  });

  it("maps an invalidated submission to INVALIDATED", () => {
    expect(currentSubmissionState({ status: "INVALIDATED" })).toBe("INVALIDATED");
  });
});
