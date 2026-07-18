import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    return dataResponse(await getStudentResultSubmission(
      student.studentNumber,
      (await context.params).appointmentId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
