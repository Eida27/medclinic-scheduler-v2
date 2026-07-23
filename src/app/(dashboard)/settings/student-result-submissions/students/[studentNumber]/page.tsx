import Link from "next/link";
import { notFound } from "next/navigation";
import { StudentResultSection } from "@/components/admin-results/StudentResultSection";
import { SubmissionHistory } from "@/components/admin-results/SubmissionHistory";
import {
  submissionProgressLabel,
  submissionProgressTone,
} from "@/components/admin-results/submission-status";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getAdminStudentResultProfile } from "@/server/services/student-result-submissions.service";

type Props = { params: Promise<{ studentNumber: string }> };

export default async function AdminStudentResultProfilePage({ params }: Props) {
  const actor = await requireUser(["ADMIN"]);
  const studentNumber = decodeURIComponent((await params).studentNumber);
  const profile = await getAdminStudentResultProfile(studentNumber, actor);
  if (!profile) notFound();

  return (
    <section className="grid gap-6">
      <Link
        href="/settings/student-result-submissions"
        className="text-sm font-semibold text-cpu-navy hover:underline"
      >
        Back to student result submissions
      </Link>
      <PageHeader
        title={profile.studentName}
        description={profile.studentNumber}
        actions={(
          <Badge tone={submissionProgressTone(profile.progress)}>
            {submissionProgressLabel(profile.progress)}
          </Badge>
        )}
      />
      <p className="text-sm text-muted">{profile.collegeName} · {profile.programName}</p>
      <div className="grid gap-5 xl:grid-cols-2">
        <StudentResultSection section={profile.laboratory} />
        <StudentResultSection section={profile.physicalExam} />
      </div>
      <SubmissionHistory submissions={profile.history} />
    </section>
  );
}
