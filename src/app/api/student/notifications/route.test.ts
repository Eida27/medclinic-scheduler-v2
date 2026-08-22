// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { listStudentNotifications, requireVerifiedStudent } = vi.hoisted(() => ({
  listStudentNotifications: vi.fn(),
  requireVerifiedStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireVerifiedStudent }));
vi.mock("@/server/services/student-notifications.service", () => ({
  listStudentNotifications,
  markStudentNotificationRead: vi.fn(),
}));

import { GET } from "./route";

describe("student notifications authorization", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the mandatory-verification 403 before reading notifications", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError(
      "STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify your email address to continue.", 403,
    ));
    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "STUDENT_EMAIL_VERIFICATION_REQUIRED" },
    });
    expect(listStudentNotifications).not.toHaveBeenCalled();
  });
});
