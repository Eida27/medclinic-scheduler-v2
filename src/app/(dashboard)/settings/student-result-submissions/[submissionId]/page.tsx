import { notFound } from "next/navigation";
import { AdminSubmissionActions } from "@/components/admin-results/AdminSubmissionActions";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/server/auth/current-user";
import { getAdminStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Props = { params: Promise<{ submissionId: string }> };

export default async function AdminStudentResultSubmissionPage({ params }: Props) {
  const actor = await requireUser(["ADMIN"]);
  const submissionId = (await params).submissionId;
  const submission = await getAdminStudentResultSubmission(submissionId, actor).catch(() => notFound());
  return (
    <section>
      <h1 className="text-3xl font-bold">Result submission</h1>
      <Card className="mt-6 p-5">
        <p className="font-bold">{submission.studentNumber}</p>
        <p className="text-sm text-muted">{submission.resultType.replaceAll("_", " ")} · {submission.status}</p>
        {submission.invalidationReason ? <p className="mt-3 text-sm">Reason: {submission.invalidationReason}</p> : null}
      </Card>
      {submission.status === "FINALIZED" ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="grid gap-3">
            {submission.files.map((file) => (
              <Card key={file.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div><p className="font-semibold">{file.originalFilename}</p><p className="text-xs text-muted">{file.byteSize} bytes</p></div>
                <a
                  href={`/api/admin/student-result-submissions/${submission.id}/files/${file.id}`}
                  className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                >Download</a>
              </Card>
            ))}
          </div>
          <AdminSubmissionActions submissionId={submission.id} />
        </div>
      ) : null}
    </section>
  );
}
