import {
  currentSubmissionStateLabel,
  formatResultBytes,
  formatResultDateTime,
} from "@/components/admin-results/submission-status";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { AdminResultSubmission } from "@/server/student-results/admin-student-result-profile";

function resultLabel(resultType: AdminResultSubmission["resultType"]) {
  return resultType === "LABORATORY" ? "Laboratory" : "Physical Exam";
}

export function SubmissionHistory({ submissions }: { submissions: AdminResultSubmission[] }) {
  return (
    <section aria-labelledby="submission-history-heading">
      <h2 id="submission-history-heading" className="mb-4 text-xl font-bold text-ink">Submission history</h2>
      {submissions.length ? (
        <div className="grid gap-4">
          {submissions.map((submission, submissionIndex) => {
            const label = resultLabel(submission.resultType);
            const mayDownload = submission.status === "FINALIZED" && submission.files.length > 0;
            return (
              <Card key={submission.id} className="grid gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-ink">{label} · {submission.appointmentDate}</h3>
                    <p className="mt-1 text-xs text-muted">Appointment ID: {submission.appointmentId}</p>
                  </div>
                  <Badge tone={submission.status === "FINALIZED" ? "success" : "danger"}>
                    {currentSubmissionStateLabel(submission.status)}
                  </Badge>
                </div>
                <div className="grid gap-1 text-sm text-muted">
                  <p>Finalized: {formatResultDateTime(submission.finalizedAt)}</p>
                  {submission.invalidatedAt ? (
                    <p>Invalidated: {formatResultDateTime(submission.invalidatedAt)}</p>
                  ) : null}
                  {submission.invalidationReason ? <p>Reason: {submission.invalidationReason}</p> : null}
                  <p>{submission.fileCount} {submission.fileCount === 1 ? "file" : "files"} · {formatResultBytes(submission.totalBytes)}</p>
                </div>
                {mayDownload ? (
                  <div className="grid gap-3">
                    {submission.files.map((file, fileIndex) => (
                      <Card key={file.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                        <div>
                          <p className="font-semibold text-ink">{file.originalFilename}</p>
                          <p className="text-xs text-muted">{formatResultBytes(file.byteSize)}</p>
                        </div>
                        <a
                          href={`/api/admin/student-result-submissions/${submission.id}/files/${file.id}`}
                          aria-label={`Download ${label} history submission ${submissionIndex + 1} file ${fileIndex + 1} for appointment ${submission.appointmentDate}: ${file.originalFilename}`}
                          className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                        >
                          Download {file.originalFilename}
                        </a>
                      </Card>
                    ))}
                    <a
                      href={`/api/admin/student-result-submissions/${submission.id}/zip`}
                      aria-label={`Download ${label} ZIP for appointment ${submission.appointmentDate}, history submission ${submissionIndex + 1}`}
                      className="inline-flex h-11 items-center justify-center rounded-xl bg-cpu-navy px-4 text-sm font-semibold text-white"
                    >
                      Download {label} ZIP
                    </a>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-5 text-sm text-muted">No older submissions yet.</Card>
      )}
    </section>
  );
}
