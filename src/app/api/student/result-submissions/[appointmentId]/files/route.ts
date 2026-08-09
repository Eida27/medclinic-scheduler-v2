import { AppError } from "@/lib/errors";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { addStudentResultFiles } from "@/server/services/student-result-submissions.service";
import { toStudentResultDraftView } from "@/server/student-results/student-result-draft-view";
import { z } from "zod";

type Context = { params: Promise<{ appointmentId: string }> };

const submissionIdSchema = z.string().uuid();

function parseSubmissionId(value: FormDataEntryValue | null) {
  const parsed = submissionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "RESULT_SUBMISSION_ID_INVALID",
      "A valid result submission ID is required.",
      400,
    );
  }
  return parsed.data;
}

export async function POST(request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const form = await request.formData();
    const submissionId = parseSubmissionId(form.get("submissionId"));
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
    if (!files.length) {
      throw new AppError("RESULT_FILES_REQUIRED", "Select at least one result file to upload.", 400);
    }
    const uploads = await Promise.all(files.map(async (file) => ({
      filename: file.name,
      declaredMimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })));
    const submission = await addStudentResultFiles(
      student.studentNumber,
      (await context.params).appointmentId,
      submissionId,
      uploads,
    );
    return dataResponse(toStudentResultDraftView(submission));
  } catch (error) {
    return errorResponse(error);
  }
}
