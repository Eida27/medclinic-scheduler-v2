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

import { requireStudent, requireVerifiedStudent } from "./current-student";

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
      message: "Verify your email address before uploading or updating Laboratory documents.",
    });
  });

  it("lets an active student read without an email", async () => {
    const identity = { studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null };
    findActiveStudentIdentity.mockResolvedValue(identity);
    await expect(requireStudent()).resolves.toBe(identity);
    expect(findActiveStudentIdentity).toHaveBeenCalledWith("24-0001");
  });

  it.each([
    { email: "pending@example.test", emailVerifiedAt: null },
    { email: null, emailVerifiedAt: new Date("2026-08-22T00:00:00.000Z") },
  ])("requires both email and verification timestamp for uploading: %j", async (emailState) => {
    findActiveStudentIdentity.mockResolvedValue({ studentNumber: "24-0001", studentName: "Student, Test", ...emailState });
    await expect(requireVerifiedStudent()).rejects.toMatchObject({ code: "STUDENT_EMAIL_VERIFICATION_REQUIRED", status: 403 });
  });

  it("retains verified capability while a replacement address is pending", async () => {
    const identity = { studentNumber: "24-0001", studentName: "Student, Test", email: "existing@example.test",
      emailVerifiedAt: new Date("2026-08-22T00:00:00.000Z"), pendingEmail: "replacement@example.test" };
    findActiveStudentIdentity.mockResolvedValue(identity);
    await expect(requireVerifiedStudent()).resolves.toBe(identity);
  });

  it.each(["missing", "invalid", "inactive"])("returns 401 for a %s student session", async (state) => {
    if (state === "missing") cookies.mockResolvedValue({ get: () => undefined });
    if (state === "invalid") verifyStudentSessionToken.mockRejectedValue(new Error("Invalid session"));
    if (state === "inactive") findActiveStudentIdentity.mockResolvedValue(null);
    await expect(requireStudent()).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(requireVerifiedStudent()).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    if (state !== "inactive") expect(findActiveStudentIdentity).not.toHaveBeenCalled();
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
