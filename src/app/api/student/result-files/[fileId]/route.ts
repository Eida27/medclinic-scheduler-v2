import { errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentResultFile } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ fileId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const student = await requireStudent();
    const result = await getStudentResultFile(student.studentNumber, (await context.params).fileId);
    return new Response(Uint8Array.from(result.bytes), {
      headers: {
        "content-type": result.mimeType,
        "content-length": String(result.bytes.byteLength),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
