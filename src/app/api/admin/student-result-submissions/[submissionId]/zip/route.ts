import { errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { createAdminSubmissionZip } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ submissionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const submissionId = (await context.params).submissionId;
    const zip = await createAdminSubmissionZip(submissionId, actor);
    return new Response(Uint8Array.from(zip), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(zip.byteLength),
        "content-disposition": `attachment; filename="result-submission-${submissionId}.zip"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
