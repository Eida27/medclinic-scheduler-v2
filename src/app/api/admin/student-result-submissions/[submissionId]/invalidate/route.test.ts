// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { invalidateStudentResultSubmission, requireUser, revalidatePath } = vi.hoisted(() => ({
  invalidateStudentResultSubmission: vi.fn(),
  requireUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  invalidateStudentResultSubmission,
}));

import { POST } from "./route";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};
const context = { params: Promise.resolve({ submissionId: "submission-1" }) };

function request() {
  return new Request(
    "http://localhost/api/admin/student-result-submissions/submission-1/invalidate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Incorrect student document" }),
    },
  );
}

describe("POST /api/admin/student-result-submissions/[submissionId]/invalidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    invalidateStudentResultSubmission.mockResolvedValue({
      id: "submission-1",
      status: "INVALIDATED",
      studentNumber: "23/8200 01",
    });
  });

  it("preserves compatibility fields and revalidates the exact list and encoded student paths", async () => {
    const response = await POST(request(), context);

    expect(invalidateStudentResultSubmission).toHaveBeenCalledWith(
      "submission-1",
      "Incorrect student document",
      admin,
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(
      1,
      "/settings/student-result-submissions",
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(
      2,
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
    await expect(response.json()).resolves.toEqual({
      data: {
        id: "submission-1",
        status: "INVALIDATED",
        studentNumber: "23/8200 01",
      },
    });
  });

  it("returns a stale conflict without revalidating", async () => {
    invalidateStudentResultSubmission.mockRejectedValue(new AppError(
      "RESULT_SUBMISSION_CONFLICT",
      "This result submission is stale and can no longer be invalidated. Refresh the student profile and try again.",
      409,
    ));

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RESULT_SUBMISSION_CONFLICT",
        message: "This result submission is stale and can no longer be invalidated. Refresh the student profile and try again.",
      },
    });
  });
});
