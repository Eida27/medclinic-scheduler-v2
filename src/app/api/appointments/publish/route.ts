import { errorResponse } from "@/lib/api-response";
import { schedulingWorkflowRetiredError } from "@/lib/retired-workflows";
import { requireUser } from "@/server/auth/current-user";

export async function POST(request: Request) {
  try {
    await requireUser(["ADMIN"]);
    void request;
    throw schedulingWorkflowRetiredError();
  } catch (error) {
    return errorResponse(error);
  }
}
