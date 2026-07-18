import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/server/auth/current-user";
import { listAdminStudentResultSubmissions } from "@/server/services/student-result-submissions.service";

export default async function AdminStudentResultSubmissionsPage() {
  const actor = await requireUser(["ADMIN"]);
  const submissions = await listAdminStudentResultSubmissions(actor);
  return (
    <section>
      <h1 className="text-3xl font-bold">Student result submissions</h1>
      <p className="mt-2 text-sm text-muted">Private medical documents are available only to administrators and their owning student.</p>
      <div className="mt-6 grid gap-3">
        {submissions.length ? submissions.map((submission) => (
          <Link key={submission.id} href={`/settings/student-result-submissions/${submission.id}`}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <p className="font-bold">{submission.studentNumber}</p>
                <p className="text-sm text-muted">{submission.resultType.replaceAll("_", " ")} · {submission.fileCount} files</p>
              </div>
              <span className="text-sm font-semibold">{submission.status}</span>
            </Card>
          </Link>
        )) : <Card className="p-5 text-sm text-muted">No finalized submissions yet.</Card>}
      </div>
    </section>
  );
}
