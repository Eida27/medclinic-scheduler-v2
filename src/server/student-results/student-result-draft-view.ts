import "server-only";
import type { StudentResultDraftView } from "@/components/student-results/ResultDraftManager";
import type { StudentResultSubmission } from "@/server/repositories/student-result-submissions.repository";

export function toStudentResultDraftView(
  submission: StudentResultSubmission,
): StudentResultDraftView {
  return {
    id: submission.id,
    appointmentId: submission.appointmentId,
    resultType: submission.resultType,
    status: submission.status,
    basedOnSubmissionId: submission.basedOnSubmissionId,
    administratorReplacementReason: submission.administratorReplacementReason,
    files: submission.files.map((file) => ({
      id: file.id,
      originalFilename: file.originalFilename,
      byteSize: file.byteSize,
    })),
    fileCount: submission.fileCount,
    totalBytes: submission.totalBytes,
  };
}
