import { redirect } from "next/navigation";
import { ResultDraftManager } from "@/components/student-results/ResultDraftManager";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Props = { params: Promise<{ appointmentId: string }> };

export default async function StudentResultDraftPage({ params }: Props) {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const draft = await getStudentResultSubmission(student.studentNumber, (await params).appointmentId);
  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold">Result submission</h1>
      <ResultDraftManager draft={draft} />
    </section>
  );
}
