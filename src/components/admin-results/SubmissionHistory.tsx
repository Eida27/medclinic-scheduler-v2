import {
  formatResultBytes,
  formatResultDateTime,
} from "@/components/admin-results/submission-status";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { AdminResultSubmission } from "@/server/student-results/admin-student-result-profile";

function resultLabel(resultType: AdminResultSubmission["resultType"]) {
  return resultType === "LABORATORY" ? "Laboratory" : "Physical Exam";
}

function historyStatusLabel(status: AdminResultSubmission["status"]) {
  if (status === "SUPERSEDED") return "Superseded";
  if (status === "INVALIDATED") return "Invalidated";
  return "Finalized";
}

function historyStatusTone(status: AdminResultSubmission["status"]) {
  if (status === "FINALIZED") return "success" as const;
  if (status === "SUPERSEDED") return "warning" as const;
  return "danger" as const;
}

export function SubmissionHistory({ submissions }: { submissions: AdminResultSubmission[] }) {
  return (
    <section aria-labelledby="submission-history-heading">
      <h2 id="submission-history-heading" className="mb-4 text-xl font-bold text-ink">Submission history</h2>
      {submissions.length ? (
        <div className="grid gap-4">
          {submissions.map((submission, submissionIndex) => {
            const label = resultLabel(submission.resultType);
            const mayDownload = (
              submission.status === "FINALIZED" || submission.status === "SUPERSEDED"
            ) && submission.files.length > 0;
            return (
              <Card key={submission.id} className="grid min-w-0 gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-ink">{label} · {submission.appointmentDate}</h3>
                    <p className="mt-1 break-all text-xs text-muted">
                      Appointment ID: {submission.appointmentId}
                    </p>
                  </div>
                  <Badge tone={historyStatusTone(submission.status)}>
                    {historyStatusLabel(submission.status)}
                  </Badge>
                </div>
                <div className="grid gap-1 text-sm text-muted">
                  <p>Finalized: {formatResultDateTime(submission.finalizedAt)}</p>
                  {submission.invalidatedAt ? (
                    <p>Invalidated: {formatResultDateTime(submission.invalidatedAt)}</p>
                  ) : null}
                  {submission.invalidationReason ? (
                    <p className="break-words">Reason: {submission.invalidationReason}</p>
                  ) : null}
                  {submission.status === "SUPERSEDED" && submission.supersededAt ? (
                    <p>Superseded: {formatResultDateTime(submission.supersededAt)}</p>
                  ) : null}
                  {submission.status === "SUPERSEDED" && submission.supersededBySubmissionId ? (
                    <p className="break-all">
                      Replacement submission ID: {submission.supersededBySubmissionId}
                    </p>
                  ) : null}
                  <p>{submission.fileCount} {submission.fileCount === 1 ? "file" : "files"} · {formatResultBytes(submission.totalBytes)}</p>
                </div>
                {mayDownload ? (
                  <div className="grid gap-3">
                    {submission.files.map((file, fileIndex) => (
                      <Card key={file.id} className="flex min-w-0 flex-wrap items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-ink">{file.originalFilename}</p>
                          <p className="text-xs text-muted">{formatResultBytes(file.byteSize)}</p>
                        </div>
                        <a
                          href={`/api/admin/student-result-submissions/${submission.id}/files/${file.id}`}
                          aria-label={`Download ${label} history submission ${submissionIndex + 1} file ${fileIndex + 1} for appointment ${submission.appointmentDate}: ${file.originalFilename}`}
                          className="inline-flex h-auto min-h-11 min-w-0 max-w-full items-center whitespace-normal break-all rounded-xl border border-line px-4 text-sm font-semibold"
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
