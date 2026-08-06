import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireStudent } from "@/server/auth/current-student";
import { submitStudentResultChanges } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string }> };

const bodySchema = z.object({ submissionId: z.string().uuid() });
const approvedStaleMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

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

function editErrorResponse(error: unknown) {
  if (
    error instanceof AppError
    && (error.code === "RESULT_EDIT_STALE" || error.code === "RESULT_SUBMISSION_CONFLICT")
  ) {
    return errorResponse(new AppError("RESULT_EDIT_STALE", approvedStaleMessage, 409));
  }
  return errorResponse(error);
}

export async function POST(request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const submissionId = await parseSubmissionId(request);
    const submission = await submitStudentResultChanges(
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
    return editErrorResponse(error);
  }
}
