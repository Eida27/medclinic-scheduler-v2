import { AppError } from "@/lib/errors";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { addStudentResultFile } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ appointmentId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError("RESULT_FILE_REQUIRED", "Select a result file to upload.", 422);
    }
    const added = await addStudentResultFile(
      student.studentNumber,
      (await context.params).appointmentId,
      {
        filename: file.name,
        declaredMimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      },
    );
    return dataResponse(added, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
