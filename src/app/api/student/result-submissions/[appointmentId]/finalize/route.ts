import { revalidatePath } from "next/cache";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { finalizeStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const submission = await finalizeStudentResultSubmission(
      student.studentNumber,
      (await context.params).appointmentId,
    );
    revalidatePath("/settings/student-result-submissions");
    revalidatePath(
      `/settings/student-result-submissions/students/${encodeURIComponent(student.studentNumber)}`,
    );
    return dataResponse(submission);
  } catch (error) {
    return errorResponse(error);
  }
}
