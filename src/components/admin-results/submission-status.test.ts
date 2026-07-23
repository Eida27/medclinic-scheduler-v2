import { describe, expect, it } from "vitest";
import {
  currentSubmissionStateLabel,
  formatResultBytes,
  formatResultDateTime,
  submissionProgressLabel,
  submissionProgressTone,
} from "./submission-status";
import {
  parseStudentResultSubmissionPage,
  RESULT_SUBMISSION_PAGE_SIZE,
} from "./student-result-submission-pagination";

describe("student result submission presentation", () => {
  it("uses the approved progress labels and badge tones", () => {
    expect(submissionProgressLabel("FULLY_SUBMITTED")).toBe("Fully submitted");
    expect(submissionProgressLabel("AWAITING_RESUBMISSION")).toBe("Awaiting resubmission");
    expect(submissionProgressLabel("PARTIALLY_SUBMITTED")).toBe("Partially submitted");
    expect(submissionProgressLabel("NOT_SUBMITTED")).toBe("Not submitted");
    expect(submissionProgressTone("AWAITING_RESUBMISSION")).toBe("danger");
    expect(submissionProgressTone("FULLY_SUBMITTED")).toBe("success");
    expect(submissionProgressTone("PARTIALLY_SUBMITTED")).toBe("warning");
    expect(submissionProgressTone("NOT_SUBMITTED")).toBe("neutral");
  });

  it("uses the approved current service state labels", () => {
    expect(currentSubmissionStateLabel("FINALIZED")).toBe("Finalized");
    expect(currentSubmissionStateLabel("INVALIDATED")).toBe("Invalidated — awaiting resubmission");
    expect(currentSubmissionStateLabel("NOT_SUBMITTED")).toBe("Not submitted yet");
  });

  it("formats result sizes with B, KB, and MB at one decimal place at most", () => {
    expect(formatResultBytes(512)).toBe("512 B");
    expect(formatResultBytes(1024)).toBe("1 KB");
    expect(formatResultBytes(1536)).toBe("1.5 KB");
    expect(formatResultBytes(1024 * 1024)).toBe("1 MB");
  });

  it("formats activity timestamps in the project timezone", () => {
    expect(formatResultDateTime(new Date("2026-08-19T16:00:00.000Z")))
      .toBe("Aug 20, 2026, 12:00 AM");
  });
});

describe("student result submission pagination", () => {
  it("uses a page size of 50 and parses only strict positive integers", () => {
    expect(RESULT_SUBMISSION_PAGE_SIZE).toBe(50);
    expect(parseStudentResultSubmissionPage("2")).toBe(2);
    expect(parseStudentResultSubmissionPage()).toBe(1);
    expect(parseStudentResultSubmissionPage("1e3")).toBe(1);
    expect(parseStudentResultSubmissionPage("0")).toBe(1);
    expect(parseStudentResultSubmissionPage("-1")).toBe(1);
    expect(parseStudentResultSubmissionPage(" 2 ")).toBe(1);
    expect(parseStudentResultSubmissionPage("01")).toBe(1);
    expect(parseStudentResultSubmissionPage("9007199254740992")).toBe(1);
  });
});
