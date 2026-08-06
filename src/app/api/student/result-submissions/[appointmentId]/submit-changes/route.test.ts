// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireStudent, revalidatePath, submitStudentResultChanges } = vi.hoisted(() => ({
  requireStudent: vi.fn(),
  revalidatePath: vi.fn(),
  submitStudentResultChanges: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  submitStudentResultChanges,
}));

import { POST } from "./route";

const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const appointmentId = "appointment-1";
const draftId = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ appointmentId }) };
const promoted = {
  id: draftId,
  appointmentId,
  studentNumber: student.studentNumber,
  resultType: "LABORATORY",
  status: "FINALIZED",
  basedOnSubmissionId: null,
  lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
  files: [],
  fileCount: 0,
  totalBytes: 0,
};
const approvedStaleMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

function request(body: unknown) {
  return new Request(
    "http://localhost/api/student/result-submissions/appointment-1/submit-changes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/student/result-submissions/[appointmentId]/submit-changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue(student);
    submitStudentResultChanges.mockResolvedValue(promoted);
  });

  it("submits only the expected edit and revalidates administrator result views", async () => {
    const response = await POST(request({
      submissionId: draftId,
      studentNumber: "99-9999-99",
    }), context);

    expect(submitStudentResultChanges).toHaveBeenCalledWith(
      student.studentNumber,
      appointmentId,
      draftId,
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(1, "/settings/student-result-submissions");
    expect(revalidatePath).toHaveBeenNthCalledWith(
      2,
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
    await expect(response.json()).resolves.toEqual({
      data: { ...promoted, lastActivityAt: "2026-08-06T08:00:00.000Z" },
    });
  });

  it.each([
    ["missing", {}],
    ["invalid", { submissionId: "draft-1" }],
  ])("returns 400 for a %s submissionId", async (_label, body) => {
    const response = await POST(request(body), context);

    expect(response.status).toBe(400);
    expect(submitStudentResultChanges).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_SUBMISSION_ID_INVALID" },
    });
  });

  it.each([
    ["RESULT_EDIT_STALE"],
    ["RESULT_SUBMISSION_CONFLICT"],
  ])("maps %s to the approved privacy-safe student conflict", async (code) => {
    submitStudentResultChanges.mockRejectedValue(new AppError(
      code,
      "Internal promotion conflict detail",
      409,
      undefined,
      { replacementSubmissionId: "40000000-0000-4000-8000-000000000004" },
    ));

    const response = await POST(request({ submissionId: draftId }), context);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(body).toEqual({
      error: { code: "RESULT_EDIT_STALE", message: approvedStaleMessage },
    });
    expect(JSON.stringify(body)).not.toContain("40000000-0000-4000-8000-000000000004");
  });

  it("preserves non-conflict validation errors", async () => {
    submitStudentResultChanges.mockRejectedValue(new AppError(
      "RESULT_FILES_REQUIRED",
      "Add at least one file before submitting changes.",
      422,
    ));

    const response = await POST(request({ submissionId: draftId }), context);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RESULT_FILES_REQUIRED",
        message: "Add at least one file before submitting changes.",
      },
    });
  });

  it("authenticates before parsing the expected edit id", async () => {
    requireStudent.mockRejectedValue(new AppError("UNAUTHORIZED", "Unauthorized", 401));
    const malformed = new Request(
      "http://localhost/api/student/result-submissions/appointment-1/submit-changes",
      { method: "POST", body: "not-json" },
    );

    const response = await POST(malformed, context);

    expect(response.status).toBe(401);
    expect(submitStudentResultChanges).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
