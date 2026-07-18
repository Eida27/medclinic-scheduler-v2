// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionToken } from "./session";
import {
  createStudentSessionToken,
  STUDENT_SESSION_COOKIE,
  verifyStudentSessionToken,
} from "./student-session";

describe("student session tokens", () => {
  it("round-trips only student identity without DOB", async () => {
    const token = await createStudentSessionToken({
      studentNumber: "23-1212-97",
      sessionType: "STUDENT",
    });
    await expect(verifyStudentSessionToken(token)).resolves.toEqual({
      studentNumber: "23-1212-97",
      sessionType: "STUDENT",
    });
    expect(STUDENT_SESSION_COOKIE).toBe("medclinic_student_session");
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload).not.toHaveProperty("dateOfBirth");
  });

  it("keeps staff and student token types separate", async () => {
    const staffToken = await createSessionToken({
      userId: "00000000-0000-4000-8000-000000000001",
      fullName: "System Admin",
      email: "admin@medclinic.local",
      role: "ADMIN",
    });
    await expect(verifyStudentSessionToken(staffToken)).rejects.toThrow();
  });
});
