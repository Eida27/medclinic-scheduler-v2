// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireStudent, redirect } = vi.hoisted(() => ({
  requireStudent: vi.fn(),
  redirect: vi.fn((target: string) => { throw new Error(`REDIRECT:${target}`); }),
}));
vi.mock("./current-student", () => ({ requireStudent }));
vi.mock("next/navigation", () => ({ redirect }));
import { requireStudentPage } from "./student-page";

describe("requireStudentPage", () => {
  beforeEach(() => vi.resetAllMocks());
  it("admits an active student without email verification", async () => {
    const student = { studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null };
    requireStudent.mockResolvedValue(student);
    await expect(requireStudentPage()).resolves.toBe(student);
    expect(redirect).not.toHaveBeenCalled();
  });
  it("redirects invalid student sessions to student login", async () => {
    requireStudent.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in.", 401));
    await expect(requireStudentPage()).rejects.toThrow("REDIRECT:/student/login");
  });
});
