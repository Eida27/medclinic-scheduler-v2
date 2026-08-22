// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { removeStudentResultFile, requireVerifiedStudent } = vi.hoisted(() => ({
  removeStudentResultFile: vi.fn(),
  requireVerifiedStudent: vi.fn(),
}));

vi.mock("@/server/auth/current-student", () => ({ requireVerifiedStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  removeStudentResultFile,
}));

import { DELETE } from "./route";

const draftId = "10000000-0000-4000-8000-000000000001";
const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const context = {
  params: Promise.resolve({ appointmentId: "appointment-1", fileId: "file-1" }),
};

function request(body: unknown) {
  return new Request(
    "http://localhost/api/student/result-submissions/appointment-1/files/file-1",
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("DELETE /api/student/result-submissions/[appointmentId]/files/[fileId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireVerifiedStudent.mockResolvedValue(student);
    removeStudentResultFile.mockResolvedValue({ success: true });
  });

  it("requires the expected draft id and removes only the addressed file", async () => {
    const response = await DELETE(request({ submissionId: draftId }), context);

    expect(response.status).toBe(200);
    expect(removeStudentResultFile).toHaveBeenCalledWith(
      student.studentNumber,
      "appointment-1",
      draftId,
      "file-1",
    );
    await expect(response.json()).resolves.toEqual({ data: { success: true } });
  });

  it.each([
    ["missing", {}],
    ["invalid", { submissionId: "submission-1" }],
  ])("returns 400 for a %s submissionId", async (_label, body) => {
    const response = await DELETE(request(body), context);

    expect(response.status).toBe(400);
    expect(removeStudentResultFile).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_SUBMISSION_ID_INVALID" },
    });
  });

  it("returns a privacy-safe stale conflict without addressing the replacement draft", async () => {
    removeStudentResultFile.mockRejectedValue(new AppError(
      "RESULT_EDIT_STALE",
      "This result draft changed. Refresh and try again.",
      409,
    ));

    const response = await DELETE(request({ submissionId: draftId }), context);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "RESULT_EDIT_STALE",
        message: "This result draft changed. Refresh and try again.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("20000000-0000-4000-8000-000000000002");
  });
});
