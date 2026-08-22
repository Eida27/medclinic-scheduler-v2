// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireStudent, requestStudentEmailVerification } = vi.hoisted(() => ({
  requireStudent: vi.fn(),
  requestStudentEmailVerification: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-email.service", () => ({ requestStudentEmailVerification }));

import { POST } from "./route";

describe("POST /api/student/email/request-verification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireStudent.mockResolvedValue({ studentNumber: "24-0001" });
  });

  it("returns expiration and resend timing without exposing the raw token", async () => {
    requestStudentEmailVerification.mockResolvedValue({
      token: "raw-secret",
      expiresAt: new Date("2026-08-22T01:30:00.000Z"),
      resendAvailableAt: new Date("2026-08-22T01:01:00.000Z"),
    });
    const response = await POST(new Request("http://localhost/api/student/email/request-verification", {
      method: "POST",
      body: JSON.stringify({ email: "student@example.test" }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      data: {
        success: true,
        expiresAt: "2026-08-22T01:30:00.000Z",
        resendAvailableAt: "2026-08-22T01:01:00.000Z",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("raw-secret");
  });
});
