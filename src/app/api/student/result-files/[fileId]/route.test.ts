// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { getStudentResultFile, requireVerifiedStudent } = vi.hoisted(() => ({
  getStudentResultFile: vi.fn(),
  requireVerifiedStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireVerifiedStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({ getStudentResultFile }));

import { GET } from "./route";

describe("student result download authorization", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the mandatory-verification 403 before loading private bytes", async () => {
    requireVerifiedStudent.mockRejectedValue(new AppError(
      "STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify your email address to continue.", 403,
    ));
    const response = await GET(new Request("http://localhost/file"), {
      params: Promise.resolve({ fileId: "file-1" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "STUDENT_EMAIL_VERIFICATION_REQUIRED" },
    });
    expect(getStudentResultFile).not.toHaveBeenCalled();
  });
});
