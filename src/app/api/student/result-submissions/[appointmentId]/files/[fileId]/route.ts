import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { removeStudentResultFile } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string; fileId: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const params = await context.params;
    return dataResponse(await removeStudentResultFile(
      student.studentNumber,
      params.appointmentId,
      params.fileId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
