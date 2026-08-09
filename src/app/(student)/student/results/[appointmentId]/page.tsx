import { redirect } from "next/navigation";
import { ResultDraftManager } from "@/components/student-results/ResultDraftManager";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { toStudentResultDraftView } from "@/server/student-results/student-result-draft-view";

type Props = { params: Promise<{ appointmentId: string }> };

export default async function StudentResultDraftPage({ params }: Props) {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const { appointmentId } = await params;
  const submission = await getStudentResultSubmission(student.studentNumber, appointmentId);
  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold">Result submission</h1>
      <ResultDraftManager draft={toStudentResultDraftView(submission)} />
    </section>
  );
}
