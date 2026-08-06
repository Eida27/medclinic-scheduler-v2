// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  beginStudentResultEdit,
  cancelStudentResultEdit,
  requireStudent,
  revalidatePath,
} = vi.hoisted(() => ({
  beginStudentResultEdit: vi.fn(),
  cancelStudentResultEdit: vi.fn(),
  requireStudent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  beginStudentResultEdit,
  cancelStudentResultEdit,
}));

import { DELETE, POST } from "./route";

const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const appointmentId = "appointment-1";
const draftId = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ appointmentId }) };
const edit = {
  id: draftId,
  appointmentId,
  studentNumber: student.studentNumber,
  resultType: "LABORATORY",
  status: "DRAFT",
  basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
  lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
  files: [],
  fileCount: 0,
  totalBytes: 0,
};
const approvedStaleMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

function request(method: "POST" | "DELETE", body?: unknown) {
  return new Request(
    "http://localhost/api/student/result-submissions/appointment-1/edit",
    {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

describe("/api/student/result-submissions/[appointmentId]/edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue(student);
    beginStudentResultEdit.mockResolvedValue(edit);
    cancelStudentResultEdit.mockResolvedValue({ success: true });
  });

  it("starts the same idempotent edit without accepting client-supplied base provenance", async () => {
    const attackerBase = "30000000-0000-4000-8000-000000000003";
    const first = await POST(request("POST", { basedOnSubmissionId: attackerBase }), context);
    const repeated = await POST(request("POST"), context);

    expect(beginStudentResultEdit).toHaveBeenCalledTimes(2);
    expect(beginStudentResultEdit).toHaveBeenNthCalledWith(1, student.studentNumber, appointmentId);
    expect(beginStudentResultEdit).toHaveBeenNthCalledWith(2, student.studentNumber, appointmentId);
    await expect(first.json()).resolves.toEqual({
      data: { ...edit, lastActivityAt: "2026-08-06T08:00:00.000Z" },
    });
    await expect(repeated.json()).resolves.toEqual({
      data: { ...edit, lastActivityAt: "2026-08-06T08:00:00.000Z" },
    });
    expect(JSON.stringify(beginStudentResultEdit.mock.calls)).not.toContain(attackerBase);
    expect(revalidatePath).toHaveBeenCalledTimes(4);
  });

  it("cancels only the expected edit and revalidates administrator result views", async () => {
    const response = await DELETE(request("DELETE", {
      submissionId: draftId,
      studentNumber: "99-9999-99",
    }), context);

    expect(cancelStudentResultEdit).toHaveBeenCalledWith(
      student.studentNumber,
      appointmentId,
      draftId,
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(1, "/settings/student-result-submissions");
    expect(revalidatePath).toHaveBeenNthCalledWith(
      2,
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
    await expect(response.json()).resolves.toEqual({ data: { success: true } });
  });

  it.each([
    ["missing", {}],
    ["invalid", { submissionId: "draft-1" }],
  ])("returns 400 for a %s cancel submissionId", async (_label, body) => {
    const response = await DELETE(request("DELETE", body), context);

    expect(response.status).toBe(400);
    expect(cancelStudentResultEdit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_SUBMISSION_ID_INVALID" },
    });
  });

  it.each([
    ["RESULT_EDIT_STALE"],
    ["RESULT_SUBMISSION_CONFLICT"],
  ])("maps %s to the approved privacy-safe student conflict", async (code) => {
    cancelStudentResultEdit.mockRejectedValue(new AppError(
      code,
      "Internal competing edit detail",
      409,
      undefined,
      { replacementSubmissionId: "40000000-0000-4000-8000-000000000004" },
    ));

    const response = await DELETE(request("DELETE", { submissionId: draftId }), context);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(body).toEqual({
      error: { code: "RESULT_EDIT_STALE", message: approvedStaleMessage },
    });
    expect(JSON.stringify(body)).not.toContain("40000000-0000-4000-8000-000000000004");
  });

  it("maps a competing edit-start conflict to the approved student message", async () => {
    beginStudentResultEdit.mockRejectedValue(new AppError(
      "RESULT_EDIT_STALE",
      "Internal stale base detail",
      409,
    ));

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "RESULT_EDIT_STALE", message: approvedStaleMessage },
    });
  });

  it("authenticates before parsing a cancel body", async () => {
    requireStudent.mockRejectedValue(new AppError("UNAUTHORIZED", "Unauthorized", 401));
    const malformed = new Request(
      "http://localhost/api/student/result-submissions/appointment-1/edit",
      { method: "DELETE", body: "not-json" },
    );

    const response = await DELETE(malformed, context);

    expect(response.status).toBe(401);
    expect(cancelStudentResultEdit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
