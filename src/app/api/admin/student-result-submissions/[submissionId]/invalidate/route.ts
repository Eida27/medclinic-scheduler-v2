import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { invalidateStudentResultSubmission } from "@/server/services/student-result-submissions.service";

const schema = z.object({ reason: z.string().trim().min(3).max(1000) });
type Context = { params: Promise<{ submissionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { reason } = schema.parse(await request.json());
    return dataResponse(await invalidateStudentResultSubmission(
      (await context.params).submissionId,
      reason,
      actor,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
