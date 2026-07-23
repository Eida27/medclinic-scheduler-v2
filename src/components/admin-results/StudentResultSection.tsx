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
      <Card className="grid gap-4">
        <h2 id={headingId} className="text-xl font-bold text-ink">{label} results</h2>
        <p className="text-sm text-muted">
          Appointment: {section.appointment
            ? `${operationalStatusLabel(section.appointment.status)} · ${section.appointment.appointmentDate}`
            : "Unscheduled"}
        </p>
        {section.state !== "NOT_SUBMITTED" ? (
          <Badge tone={section.state === "FINALIZED" ? "success" : "danger"}>
            {currentSubmissionStateLabel(section.state)}
          </Badge>
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
          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <div className="grid gap-3">
              <div className="grid gap-1 text-sm text-muted">
                <p>Finalized: {formatResultDateTime(submission.finalizedAt)}</p>
                <p>{submission.fileCount} {submission.fileCount === 1 ? "file" : "files"} · {formatResultBytes(submission.totalBytes)}</p>
              </div>
              {submission.files.map((file) => (
                <Card key={file.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <p className="font-semibold text-ink">{file.originalFilename}</p>
                    <p className="text-xs text-muted">{formatResultBytes(file.byteSize)}</p>
                  </div>
                  <a
                    href={`/api/admin/student-result-submissions/${submission.id}/files/${file.id}`}
                    className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                  >
                    Download {file.originalFilename}
                  </a>
                </Card>
              ))}
            </div>
            <AdminSubmissionActions submissionId={submission.id} resultLabel={label} />
          </div>
        ) : null}
      </Card>
    </section>
  );
}
