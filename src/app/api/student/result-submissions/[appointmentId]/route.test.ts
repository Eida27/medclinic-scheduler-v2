// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStudentResultSubmission, requireStudent } = vi.hoisted(() => ({
  getStudentResultSubmission: vi.fn(),
  requireStudent: vi.fn(),
}));

vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  getStudentResultSubmission,
}));

import { GET } from "./route";

const student = {
  studentNumber: "23/8200 01",
  firstName: "Aaron",
  lastName: "Abad",
};
const rawSubmission = {
  id: "10000000-0000-4000-8000-000000000001",
  appointmentId: "appointment-1",
  studentNumber: student.studentNumber,
  resultType: "LABORATORY",
  status: "DRAFT",
  basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
  administratorReplacementReason: null,
  lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
  files: [{
    id: "file-1",
    submissionId: "10000000-0000-4000-8000-000000000001",
    storageKey: "private/storage-key.pdf",
    originalFilename: "retained.pdf",
    detectedMimeType: "application/pdf",
    extension: "pdf",
    byteSize: 128,
    checksumSha256: "private-checksum",
    uploadedAt: new Date("2026-08-06T08:00:00.000Z"),
  }],
  fileCount: 1,
  totalBytes: 128,
};

describe("GET /api/student/result-submissions/[appointmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue(student);
    getStudentResultSubmission.mockResolvedValue(rawSubmission);
  });

  it("returns only the plain student-facing edit projection", async () => {
    const response = await GET(
      new Request("http://localhost/api/student/result-submissions/appointment-1"),
      { params: Promise.resolve({ appointmentId: "appointment-1" }) },
    );

    expect(response.status).toBe(200);
    expect(getStudentResultSubmission).toHaveBeenCalledWith(student.studentNumber, "appointment-1");
    await expect(response.json()).resolves.toEqual({
      data: {
        id: "10000000-0000-4000-8000-000000000001",
        appointmentId: "appointment-1",
        resultType: "LABORATORY",
        status: "DRAFT",
        basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
        administratorReplacementReason: null,
        files: [{ id: "file-1", originalFilename: "retained.pdf", byteSize: 128 }],
        fileCount: 1,
        totalBytes: 128,
      },
    });
  });
});
