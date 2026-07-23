// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { finalizeStudentResultSubmission, requireStudent, revalidatePath } = vi.hoisted(() => ({
  finalizeStudentResultSubmission: vi.fn(),
  requireStudent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  finalizeStudentResultSubmission,
}));

import { POST } from "./route";

const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const context = { params: Promise.resolve({ appointmentId: "appointment-1" }) };

describe("POST /api/student/result-submissions/[appointmentId]/finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue(student);
    finalizeStudentResultSubmission.mockResolvedValue({
      id: "submission-1",
      studentNumber: student.studentNumber,
      status: "FINALIZED",
    });
  });

  it("preserves the response and revalidates the exact list and encoded student paths", async () => {
    const response = await POST(new Request(
      "http://localhost/api/student/result-submissions/appointment-1/finalize",
      { method: "POST" },
    ), context);

    expect(finalizeStudentResultSubmission).toHaveBeenCalledWith(
      student.studentNumber,
      "appointment-1",
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
        studentNumber: student.studentNumber,
        status: "FINALIZED",
      },
    });
  });

  it("does not revalidate when finalization fails", async () => {
    finalizeStudentResultSubmission.mockRejectedValue(new AppError(
      "RESULT_SUBMISSION_FINALIZED",
      "This result submission is already finalized.",
      409,
    ));

    const response = await POST(new Request(
      "http://localhost/api/student/result-submissions/appointment-1/finalize",
      { method: "POST" },
    ), context);

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RESULT_SUBMISSION_FINALIZED",
        message: "This result submission is already finalized.",
      },
    });
  });
});
