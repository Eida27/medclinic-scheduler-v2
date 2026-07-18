import { errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getAdminSubmissionResultFile } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ submissionId: string; fileId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const params = await context.params;
    const result = await getAdminSubmissionResultFile(params.submissionId, params.fileId, actor);
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
