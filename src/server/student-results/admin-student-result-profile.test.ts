import { describe, expect, it } from "vitest";

import {
  combinedSubmissionProgress,
  currentSubmissionState,
} from "./admin-student-result-profile";

describe("administrator student result profile state", () => {
  it.each([
    ["FINALIZED", "FULLY_SUBMITTED"],
    ["INVALIDATED", "AWAITING_RESUBMISSION"],
    ["NOT_SUBMITTED", "NOT_SUBMITTED"],
  ] as const)("maps Laboratory %s to %s", (laboratory, expected) => {
    expect(combinedSubmissionProgress(laboratory)).toBe(expected);
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

  it("never treats a superseded official version as current", () => {
    expect(currentSubmissionState({ status: "SUPERSEDED" })).toBe("NOT_SUBMITTED");
  });
});
