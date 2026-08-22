import { ResultDraftManager } from "@/components/student-results/ResultDraftManager";
import { requireVerifiedStudentPage } from "@/server/auth/verified-student-page";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { toStudentResultDraftView } from "@/server/student-results/student-result-draft-view";

type Props = { params: Promise<{ appointmentId: string }> };

export default async function StudentResultDraftPage({ params }: Props) {
  const student = await requireVerifiedStudentPage();
  const { appointmentId } = await params;
  const submission = await getStudentResultSubmission(student.studentNumber, appointmentId);
  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold">Result submission</h1>
      <ResultDraftManager draft={toStudentResultDraftView(submission)} />
    </section>
  );
}
