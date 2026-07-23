import {
  parseStudentResultSubmissionPage,
  RESULT_SUBMISSION_PAGE_SIZE,
} from "@/components/admin-results/student-result-submission-pagination";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listAdminStudentResultProfiles } from "@/server/services/student-result-submissions.service";

export async function GET(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const page = parseStudentResultSubmissionPage(
      new URL(request.url).searchParams.get("page") ?? undefined,
    );
    return dataResponse(await listAdminStudentResultProfiles(actor, {
      page,
      limit: RESULT_SUBMISSION_PAGE_SIZE,
      offset: (page - 1) * RESULT_SUBMISSION_PAGE_SIZE,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
