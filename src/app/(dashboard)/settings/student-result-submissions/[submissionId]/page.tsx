import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { getAdminSubmissionStudentNumber } from "@/server/services/student-result-submissions.service";

type Props = { params: Promise<{ submissionId: string }> };

export default async function AdminStudentResultSubmissionPage({ params }: Props) {
  const actor = await requireUser(["ADMIN"]);
  const submissionId = (await params).submissionId;
  const studentNumber = await getAdminSubmissionStudentNumber(submissionId, actor);
  if (!studentNumber) notFound();
  redirect(
    `/settings/student-result-submissions/students/${encodeURIComponent(studentNumber)}`,
  );
}
