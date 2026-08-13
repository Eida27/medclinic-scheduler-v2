import { requireUser } from "@/server/auth/current-user";
import { errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";

export async function POST() {
  try {
    await requireUser(["ADMIN"]);
    throw new AppError(
      "FIRST_YEAR_IMPORT_WORKFLOW_RETIRED",
      "Publish First Year schedules through Schedule Import.",
      410,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
