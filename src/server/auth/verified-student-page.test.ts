// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { redirect, requireVerifiedStudent } = vi.hoisted(() => ({
  redirect: vi.fn((target: string) => { throw new Error(`REDIRECT:${target}`); }),
  requireVerifiedStudent: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("./current-student", () => ({ requireVerifiedStudent }));

import { requireVerifiedStudentPage } from "./verified-student-page";

describe("requireVerifiedStudentPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("preserves the default verification redirect when no destination was supplied", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError(
      "STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify your email address to continue.", 403,
    ));
    await expect(requireVerifiedStudentPage()).rejects.toThrow("REDIRECT:/student/email-verification");
  });

  it.each([
    ["/student/results/10000000-0000-4000-8000-000000000001", "/student/email-verification?returnTo=%2Fstudent%2Fresults%2F10000000-0000-4000-8000-000000000001"],
    ["https://evil.test", "/student/email-verification?returnTo=%2Fstudent"],
    [["/student/results", "/student"], "/student/email-verification?returnTo=%2Fstudent"],
  ])("constrains verification continuation for %j", async (returnTo, target) => {
    requireVerifiedStudent.mockRejectedValue(new AppError("STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify email.", 403));
    await expect(requireVerifiedStudentPage(returnTo)).rejects.toThrow(`REDIRECT:${target}`);
  });

  it("does not redirect a verified student even with a continuation", async () => {
    const student = { studentNumber: "24-0001", studentName: "Student, Test", email: "student@example.test", emailVerifiedAt: new Date() };
    requireVerifiedStudent.mockResolvedValue(student);
    await expect(requireVerifiedStudentPage("/student/results")).resolves.toBe(student);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated visitors to student login", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in.", 401));
    await expect(requireVerifiedStudentPage()).rejects.toThrow("REDIRECT:/student/login");
  });
});
