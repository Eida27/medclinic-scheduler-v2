// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStudentEmailVerificationStatus, requireStudent } = vi.hoisted(() => ({
  getStudentEmailVerificationStatus: vi.fn(),
  requireStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-email.service", () => ({ getStudentEmailVerificationStatus }));

import { GET } from "./route";

describe("GET /api/student/email/status", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires a student session and returns the current active identity status", async () => {
    requireStudent.mockResolvedValue({ studentNumber: "24-0001" });
    getStudentEmailVerificationStatus.mockResolvedValue({
      verified: false,
      verifiedEmail: null,
      pendingEmailMasked: "s***@example.test",
      expiresAt: new Date("2026-08-22T01:30:00.000Z"),
      resendAvailableAt: new Date("2026-08-22T01:01:00.000Z"),
      retryAfterSeconds: 42,
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(getStudentEmailVerificationStatus).toHaveBeenCalledWith("24-0001");
    expect(await response.json()).toMatchObject({ data: { verified: false, retryAfterSeconds: 42 } });
  });
});
