// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { addStudentResultFiles, requireStudent } = vi.hoisted(() => ({
  addStudentResultFiles: vi.fn(),
  requireStudent: vi.fn(),
}));

vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  addStudentResultFiles,
}));

import { POST } from "./route";

const draftId = "10000000-0000-4000-8000-000000000001";
const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const submission = {
  id: draftId,
  appointmentId: "appointment-1",
  studentNumber: student.studentNumber,
  resultType: "LABORATORY",
  status: "DRAFT",
  basedOnSubmissionId: null,
  administratorReplacementReason: null,
  lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
  files: [{
    id: "uploaded-file-1",
    submissionId: draftId,
    storageKey: "private/upload-storage-key.pdf",
    originalFilename: "first.pdf",
    detectedMimeType: "application/pdf",
    extension: "pdf",
    byteSize: 14,
    checksumSha256: "private-upload-checksum",
    uploadedAt: new Date("2026-08-06T08:00:00.000Z"),
  }],
  fileCount: 1,
  totalBytes: 14,
  officialSubmission: null,
};
const context = { params: Promise.resolve({ appointmentId: "appointment-1" }) };

function requestWith(form: FormData) {
  return new Request(
    "http://localhost/api/student/result-submissions/appointment-1/files",
    { method: "POST", body: form },
  );
}

describe("POST /api/student/result-submissions/[appointmentId]/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue(student);
    addStudentResultFiles.mockResolvedValue(submission);
  });

  it("uploads every repeated File entry in one expected-draft service call", async () => {
    const firstPdf = new File(["%PDF-1.7\nfirst"], "first.pdf", { type: "application/pdf" });
    const secondPng = new File([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], "second.png", { type: "image/png" });
    const form = new FormData();
    form.set("submissionId", draftId);
    form.append("file", firstPdf);
    form.append("file", "ignore non-File entries");
    form.append("file", secondPng);

    const response = await POST(requestWith(form), context);

    expect(response.status).toBe(200);
    expect(addStudentResultFiles).toHaveBeenCalledTimes(1);
    expect(addStudentResultFiles).toHaveBeenCalledWith(
      student.studentNumber,
      "appointment-1",
      draftId,
      [
        {
          filename: "first.pdf",
          declaredMimeType: "application/pdf",
          bytes: Buffer.from("%PDF-1.7\nfirst"),
        },
        {
          filename: "second.png",
          declaredMimeType: "image/png",
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      ],
    );
    const body = await response.json();
    expect(body).toEqual({
      data: {
        id: draftId,
        appointmentId: "appointment-1",
        resultType: "LABORATORY",
        status: "DRAFT",
        basedOnSubmissionId: null,
        administratorReplacementReason: null,
        files: [{ id: "uploaded-file-1", originalFilename: "first.pdf", byteSize: 14 }],
        fileCount: 1,
        totalBytes: 14,
        officialSubmission: null,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-upload-(storage-key|checksum)/,
    );
  });

  it("returns 400 when no valid File entries are present", async () => {
    const form = new FormData();
    form.set("submissionId", draftId);
    form.append("file", "not a File");

    const response = await POST(requestWith(form), context);

    expect(response.status).toBe(400);
    expect(addStudentResultFiles).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_FILES_REQUIRED" },
    });
  });

  it.each([
    ["missing", undefined],
    ["invalid", "submission-1"],
  ])("returns 400 for a %s submissionId", async (_label, submissionId) => {
    const form = new FormData();
    if (submissionId) form.set("submissionId", submissionId);
    form.append("file", new File(["%PDF-1.7\nvalid"], "valid.pdf", { type: "application/pdf" }));

    const response = await POST(requestWith(form), context);

    expect(response.status).toBe(400);
    expect(addStudentResultFiles).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESULT_SUBMISSION_ID_INVALID" },
    });
  });

  it("returns a privacy-safe stale conflict without exposing the replacement draft id", async () => {
    addStudentResultFiles.mockRejectedValue(new AppError(
      "RESULT_EDIT_STALE",
      "This result draft changed. Refresh and try again.",
      409,
    ));
    const form = new FormData();
    form.set("submissionId", draftId);
    form.append("file", new File(["%PDF-1.7\nvalid"], "valid.pdf", { type: "application/pdf" }));

    const response = await POST(requestWith(form), context);
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

  it("preserves student authentication before reading upload data", async () => {
    requireStudent.mockRejectedValue(new AppError("UNAUTHORIZED", "Unauthorized", 401));

    const response = await POST(requestWith(new FormData()), context);

    expect(response.status).toBe(401);
    expect(addStudentResultFiles).not.toHaveBeenCalled();
  });
});
