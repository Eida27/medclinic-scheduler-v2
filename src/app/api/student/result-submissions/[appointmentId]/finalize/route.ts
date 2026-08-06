import { revalidatePath } from "next/cache";
import { AppError } from "@/lib/errors";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { finalizeStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { z } from "zod";

type Context = { params: Promise<{ appointmentId: string }> };

const bodySchema = z.object({ submissionId: z.string().uuid() });

async function parseSubmissionId(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError(
      "RESULT_SUBMISSION_ID_INVALID",
      "A valid result submission ID is required.",
      400,
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      "RESULT_SUBMISSION_ID_INVALID",
      "A valid result submission ID is required.",
      400,
    );
  }
  return parsed.data.submissionId;
}

export async function POST(request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const submissionId = await parseSubmissionId(request);
    const submission = await finalizeStudentResultSubmission(
      student.studentNumber,
      (await context.params).appointmentId,
      submissionId,
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
