// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseStudentVerificationReturn, studentVerificationHref, studentVerificationReturn } from "./student-verification-return";

describe("student verification continuation", () => {
  it.each([
    ["/student", "/student/email-verification?returnTo=%2Fstudent"],
    ["/student/results", "/student/email-verification?returnTo=%2Fstudent%2Fresults"],
    ["/student/results/10000000-0000-4000-8000-000000000001", "/student/email-verification?returnTo=%2Fstudent%2Fresults%2F10000000-0000-4000-8000-000000000001"],
    ["/student/results/ABCDEF00-1234-5678-9ABC-DEF012345678", "/student/email-verification?returnTo=%2Fstudent%2Fresults%2FABCDEF00-1234-5678-9ABC-DEF012345678"],
  ])("retains the exact allowed path %s", (path, href) => {
    expect(parseStudentVerificationReturn(path)).toBe(path);
    expect(studentVerificationReturn(path)).toBe(path);
    expect(studentVerificationHref(path)).toBe(href);
  });

  it.each([
    undefined, null, "", 1, {}, [], ["/student"], ["/student", "/student/results"],
    "https://evil.test/student", "//evil.test/student", "javascript:alert(1)",
    "student", "/student/", "/student/results/", "/student/notifications", "/student/email-verification",
    "/student/results/not-a-uuid", "/student/results/10000000-0000-4000-8000-000000000001/extra",
    "/student/results/10000000-0000-4000-8000-000000000001/", "/student/results?next=evil", "/student#fragment",
    "/student\\results", "\\student", "/student/results/../", " /student", "/student\n", "/student\u0000",
    "%2Fstudent", "/student%2Fresults", "/student/results/%31%30%30%30%30%30%30%30-0000-4000-8000-000000000001",
    "/student%5cresults", "/student/results/10000000-0000-4000-8000-000000000001?x=1",
    "/student/results/10000000-0000-4000-8000-000000000001#x",
  ])("rejects malformed or unsafe input %j", (value) => {
    expect(parseStudentVerificationReturn(value)).toBeNull();
    expect(studentVerificationReturn(value)).toBe("/student");
    expect(studentVerificationHref(value)).toBe("/student/email-verification?returnTo=%2Fstudent");
  });
});
