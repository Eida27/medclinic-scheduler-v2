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

  it("redirects authenticated unverified students to mandatory onboarding", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError(
      "STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify your email address to continue.", 403,
    ));
    await expect(requireVerifiedStudentPage()).rejects.toThrow("REDIRECT:/student/email-verification");
  });

  it("redirects unauthenticated visitors to student login", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in.", 401));
    await expect(requireVerifiedStudentPage()).rejects.toThrow("REDIRECT:/student/login");
  });
});
