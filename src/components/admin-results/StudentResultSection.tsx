import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { AdminSubmissionActions } from "@/components/admin-results/AdminSubmissionActions";
import {
  currentSubmissionStateLabel,
  formatResultBytes,
  formatResultDateTime,
} from "@/components/admin-results/submission-status";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { AdminCurrentResultSection } from "@/server/student-results/admin-student-result-profile";

function resultLabel(resultType: AdminCurrentResultSection["resultType"]) {
  return resultType === "LABORATORY" ? "Laboratory" : "Physical Exam";
}

export function StudentResultSection({ section }: { section: AdminCurrentResultSection }) {
  const label = resultLabel(section.resultType);
  const headingId = `current-${section.resultType.toLowerCase()}-results`;
  const submission = section.submission;

  return (
    <section aria-labelledby={headingId}>
      <Card className="@container grid gap-4">
        <h2 id={headingId} className="text-xl font-bold text-ink">{label} results</h2>
        <p className="text-sm text-muted">
          Appointment: {section.appointment
            ? `${operationalStatusLabel(section.appointment.status)} · ${section.appointment.appointmentDate}`
            : "Unscheduled"}
        </p>
        {section.state !== "NOT_SUBMITTED" ? (
          <div className="justify-self-start">
            <Badge tone={section.state === "FINALIZED" ? "success" : "danger"}>
              {currentSubmissionStateLabel(section.state)}
            </Badge>
          </div>
        ) : null}

        {section.state === "NOT_SUBMITTED" ? (
          <p className="text-sm text-muted">Not submitted yet</p>
        ) : null}

        {section.state === "INVALIDATED" && submission ? (
          <div className="grid gap-2 text-sm text-muted">
            <p>Invalidated: {submission.invalidatedAt
              ? formatResultDateTime(submission.invalidatedAt)
              : "Date unavailable"}</p>
            <p>Reason: {submission.invalidationReason ?? "No reason recorded"}</p>
            <p>{submission.fileCount} {submission.fileCount === 1 ? "file" : "files"} · {formatResultBytes(submission.totalBytes)}</p>
          </div>
        ) : null}

        {section.state === "FINALIZED" && submission ? (
          <div
            data-testid="current-result-content"
            className="grid min-w-0 gap-5 @2xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)]"
          >
            <div className="grid min-w-0 gap-3">
              <div className="grid gap-1 text-sm text-muted">
                <p>Finalized: {formatResultDateTime(submission.finalizedAt)}</p>
                <p>{submission.fileCount} {submission.fileCount === 1 ? "file" : "files"} · {formatResultBytes(submission.totalBytes)}</p>
              </div>
              {submission.files.map((file, fileIndex) => (
                <Card key={file.id} className="grid min-w-0 gap-4 p-4 @sm:grid-cols-[minmax(0,1fr)_auto] @sm:items-center">
                  <div className="min-w-0">
                    <p className="break-words font-semibold text-ink">{file.originalFilename}</p>
                    <p className="text-xs text-muted">{formatResultBytes(file.byteSize)}</p>
                  </div>
                  <a
                    href={`/api/admin/student-result-submissions/${submission.id}/files/${file.id}`}
                    aria-label={`Download ${label} file ${fileIndex + 1} for appointment ${submission.appointmentDate}: ${file.originalFilename}`}
                    className="inline-flex h-11 max-w-full items-center justify-center whitespace-normal break-words rounded-xl border border-line px-4 text-center text-sm font-semibold"
                  >
                    Download {file.originalFilename}
                  </a>
                </Card>
              ))}
            </div>
            <AdminSubmissionActions
              submissionId={submission.id}
              resultLabel={label}
              appointmentDate={submission.appointmentDate}
            />
          </div>
        ) : null}
      </Card>
    </section>
  );
}
