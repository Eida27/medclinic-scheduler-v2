import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { toStudentResultDraftView } from "@/server/student-results/student-result-draft-view";

type Context = { params: Promise<{ appointmentId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const submission = await getStudentResultSubmission(
      student.studentNumber,
      (await context.params).appointmentId,
    );
    return dataResponse(toStudentResultDraftView(submission));
  } catch (error) {
    return errorResponse(error);
  }
}
