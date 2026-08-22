// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { finalizeStudentResultSubmission, requireVerifiedStudent, revalidatePath } = vi.hoisted(() => ({
  finalizeStudentResultSubmission: vi.fn(),
  requireVerifiedStudent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/server/auth/current-student", () => ({ requireVerifiedStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  finalizeStudentResultSubmission,
}));

import { POST } from "./route";

const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const draftId = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ appointmentId: "appointment-1" }) };

function request(body: unknown) {
  return new Request(
    "http://localhost/api/student/result-submissions/appointment-1/finalize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/student/result-submissions/[appointmentId]/finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireVerifiedStudent.mockResolvedValue(student);
    finalizeStudentResultSubmission.mockResolvedValue({
      id: draftId,
      appointmentId: "appointment-1",
      studentNumber: student.studentNumber,
      resultType: "LABORATORY",
      status: "FINALIZED",
      basedOnSubmissionId: null,
      administratorReplacementReason: null,
      lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
      files: [{
        id: "finalized-file-1",
        submissionId: draftId,
        storageKey: "private/finalized-storage-key.pdf",
        originalFilename: "finalized.pdf",
        detectedMimeType: "application/pdf",
        extension: "pdf",
        byteSize: 256,
        checksumSha256: "private-finalized-checksum",
        uploadedAt: new Date("2026-08-06T08:00:00.000Z"),
      }],
      fileCount: 1,
      totalBytes: 256,
      officialSubmission: null,
    });
  });

  it("preserves the response and revalidates the exact list and encoded student paths", async () => {
    const response = await POST(request({ submissionId: draftId }), context);

    expect(finalizeStudentResultSubmission).toHaveBeenCalledWith(
      student.studentNumber,
      "appointment-1",
      draftId,
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(
      1,
      "/settings/student-result-submissions",
    );
    expect(revalidatePath).toHaveBeenNthCalledWith(
      2,
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
    const body = await response.json();
    expect(body).toEqual({
      data: {
        id: draftId,
        appointmentId: "appointment-1",
        resultType: "LABORATORY",
        status: "FINALIZED",
        basedOnSubmissionId: null,
        administratorReplacementReason: null,
        files: [{ id: "finalized-file-1", originalFilename: "finalized.pdf", byteSize: 256 }],
        fileCount: 1,
        totalBytes: 256,
        officialSubmission: null,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-finalized-(storage-key|checksum)/,
    );
  });

  it.each([
    ["missing", {}],
    ["invalid", { submissionId: "submission-1" }],
  ])("returns 400 for a %s submissionId without revalidating", async (_label, body) => {
    const response = await POST(request(body), context);

    expect(response.status).toBe(400);
    expect(finalizeStudentResultSubmission).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_SUBMISSION_ID_INVALID" },
    });
  });

  it("does not revalidate or expose a replacement id for a stale finalization", async () => {
    finalizeStudentResultSubmission.mockRejectedValue(new AppError(
      "RESULT_EDIT_STALE",
      "This result draft changed. Refresh and try again.",
      409,
    ));

    const response = await POST(request({ submissionId: draftId }), context);

    expect(response.status).toBe(409);
    expect(revalidatePath).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "RESULT_EDIT_STALE",
        message: "This result draft changed. Refresh and try again.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("20000000-0000-4000-8000-000000000002");
  });
});
