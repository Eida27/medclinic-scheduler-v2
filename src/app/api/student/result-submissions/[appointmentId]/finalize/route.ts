import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { finalizeStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    return dataResponse(await finalizeStudentResultSubmission(
      student.studentNumber,
      (await context.params).appointmentId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
