// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookies, findActiveStudentIdentity, verifyStudentSessionToken } = vi.hoisted(() => ({
  cookies: vi.fn(),
  findActiveStudentIdentity: vi.fn(),
  verifyStudentSessionToken: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/server/repositories/student-portal.repository", () => ({ findActiveStudentIdentity }));
vi.mock("./student-session", () => ({
  STUDENT_SESSION_COOKIE: "medclinic_student_session",
  verifyStudentSessionToken,
}));

import { requireVerifiedStudent } from "./current-student";

describe("requireVerifiedStudent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cookies.mockResolvedValue({ get: () => ({ value: "student-token" }) });
    verifyStudentSessionToken.mockResolvedValue({ studentNumber: "24-0001", sessionType: "STUDENT" });
  });

  it("rejects an authenticated student whose current active identity is not verified", async () => {
    findActiveStudentIdentity.mockResolvedValue({
      studentNumber: "24-0001",
      studentName: "Student, Test",
      email: null,
      emailVerifiedAt: null,
    });

    await expect(requireVerifiedStudent()).rejects.toMatchObject({
      code: "STUDENT_EMAIL_VERIFICATION_REQUIRED",
      status: 403,
    });
  });

  it("returns a student only when the current active identity has a verified email", async () => {
    const identity = {
      studentNumber: "24-0001",
      studentName: "Student, Test",
      email: "student@example.test",
      emailVerifiedAt: new Date("2026-08-22T00:00:00.000Z"),
    };
    findActiveStudentIdentity.mockResolvedValue(identity);

    await expect(requireVerifiedStudent()).resolves.toBe(identity);
  });
});
