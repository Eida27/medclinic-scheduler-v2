import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getAdminStudentResultSubmission } from "@/server/services/student-result-submissions.service";

type Context = { params: Promise<{ submissionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await getAdminStudentResultSubmission((await context.params).submissionId, actor));
  } catch (error) {
    return errorResponse(error);
  }
}
