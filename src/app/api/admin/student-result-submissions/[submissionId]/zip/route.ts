import { errorResponse } from "@/lib/api-response";
import { Readable } from "node:stream";
import { requireUser } from "@/server/auth/current-user";
import { createAdminSubmissionZipStream } from "@/server/services/student-result-submissions.service";

export const runtime = "nodejs";

type Context = { params: Promise<{ submissionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const submissionId = (await context.params).submissionId;
    const zip = await createAdminSubmissionZipStream(submissionId, actor);
    return new Response(Readable.toWeb(zip) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="result-submission-${submissionId}.zip"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
