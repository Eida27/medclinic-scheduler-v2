import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentResultDraftView } from "@/components/student-results/ResultDraftManager";

const { getStudentResultSubmission, redirect, requireStudent } = vi.hoisted(() => ({
  getStudentResultSubmission: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT:${location}`); }),
  requireStudent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  getStudentResultSubmission,
}));

import StudentResultDraftPage from "./page";

const rawSubmission = {
  id: "10000000-0000-4000-8000-000000000001",
  appointmentId: "appointment-1",
  studentNumber: "23/8200 01",
  resultType: "PHYSICAL_EXAM",
  status: "DRAFT",
  basedOnSubmissionId: null,
  administratorReplacementReason: "Upload the complete signed page.",
  lastActivityAt: new Date("2026-08-06T08:00:00.000Z"),
  files: [{
    id: "file-1",
    submissionId: "10000000-0000-4000-8000-000000000001",
    storageKey: "private/storage-key.pdf",
    originalFilename: "replacement.pdf",
    detectedMimeType: "application/pdf",
    extension: "pdf",
    byteSize: 256,
    checksumSha256: "private-checksum",
    uploadedAt: new Date("2026-08-06T08:00:00.000Z"),
  }],
  fileCount: 1,
  totalBytes: 256,
};

describe("StudentResultDraftPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue({ studentNumber: "23/8200 01" });
    getStudentResultSubmission.mockResolvedValue(rawSubmission);
  });

  it("awaits params and passes only a serializable plain projection to the client manager", async () => {
    const page = await StudentResultDraftPage({
      params: Promise.resolve({ appointmentId: "appointment-1" }),
    });
    const manager = page.props.children[1] as ReactElement<{ draft: StudentResultDraftView }>;

    expect(isValidElement(manager)).toBe(true);
    expect(getStudentResultSubmission).toHaveBeenCalledWith("23/8200 01", "appointment-1");
    expect(manager.props.draft).toEqual({
      id: "10000000-0000-4000-8000-000000000001",
      appointmentId: "appointment-1",
      resultType: "PHYSICAL_EXAM",
      status: "DRAFT",
      basedOnSubmissionId: null,
      administratorReplacementReason: "Upload the complete signed page.",
      files: [{ id: "file-1", originalFilename: "replacement.pdf", byteSize: 256 }],
      fileCount: 1,
      totalBytes: 256,
    });
    expect(JSON.stringify(manager.props.draft)).not.toContain("private/storage-key.pdf");
    expect(JSON.stringify(manager.props.draft)).not.toContain("private-checksum");
  });
});
