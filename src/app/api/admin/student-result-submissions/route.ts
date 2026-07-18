import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listAdminStudentResultSubmissions } from "@/server/services/student-result-submissions.service";

export async function GET() {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await listAdminStudentResultSubmissions(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
