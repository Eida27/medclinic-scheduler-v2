import Link from "next/link";
import { StudentResultSubmissionPagination } from "@/components/admin-results/StudentResultSubmissionPagination";
import {
  currentSubmissionStateLabel,
  formatResultDateTime,
  submissionProgressLabel,
  submissionProgressTone,
} from "@/components/admin-results/submission-status";
import {
  parseStudentResultSubmissionPage,
  RESULT_SUBMISSION_PAGE_SIZE,
} from "@/components/admin-results/student-result-submission-pagination";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/server/auth/current-user";
import { listAdminStudentResultProfiles } from "@/server/services/student-result-submissions.service";
import type { CurrentSubmissionState } from "@/server/student-results/admin-student-result-profile";

type StudentResultSubmissionSearchParams = Record<string, string | undefined>;

function serviceSummary(
  label: string,
  state: CurrentSubmissionState,
  fileCount: number,
) {
  const count = state === "FINALIZED"
    ? ` · ${fileCount} ${fileCount === 1 ? "file" : "files"}`
    : "";
  return `${label}: ${currentSubmissionStateLabel(state)}${count}`;
}

export default async function AdminStudentResultSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<StudentResultSubmissionSearchParams>;
}) {
  const actor = await requireUser(["ADMIN"]);
  const params = await searchParams;
  const page = parseStudentResultSubmissionPage(params.page);
  const report = await listAdminStudentResultProfiles(actor, {
    page,
    limit: RESULT_SUBMISSION_PAGE_SIZE,
    offset: (page - 1) * RESULT_SUBMISSION_PAGE_SIZE,
  });

  return (
    <section>
      <h1 className="text-3xl font-bold">Student result submissions</h1>
      <p className="mt-2 text-sm text-muted">Private medical documents are available only to administrators and their owning student.</p>
      <div className="mt-6 grid gap-3">
        {report.items.length ? report.items.map((item) => (
          <Link
            key={item.studentNumber}
            href={`/settings/student-result-submissions/students/${encodeURIComponent(item.studentNumber)}`}
          >
            <Card className="grid gap-4 transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft/35">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-ink">{item.studentName}</p>
                  <p className="font-mono text-xs text-muted">{item.studentNumber}</p>
                  <p className="mt-1 text-xs text-muted">{item.collegeName} · {item.programName}</p>
                </div>
                <Badge tone={submissionProgressTone(item.progress)}>
                  {submissionProgressLabel(item.progress)}
                </Badge>
              </div>
              <div className="grid gap-2 text-sm text-muted sm:grid-cols-2">
                <p>{serviceSummary("Laboratory", item.laboratory.state, item.laboratory.fileCount)}</p>
                <p>{serviceSummary("Physical Exam", item.physicalExam.state, item.physicalExam.fileCount)}</p>
              </div>
              <p className="text-xs text-muted">
                Latest activity: {formatResultDateTime(item.latestActivityAt)}
              </p>
            </Card>
          </Link>
        )) : <Card className="p-5 text-sm text-muted">No student result submissions yet.</Card>}
      </div>
      <StudentResultSubmissionPagination page={page} total={report.total} />
    </section>
  );
}
