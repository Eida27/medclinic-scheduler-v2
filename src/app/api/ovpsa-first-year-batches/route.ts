import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { listOvpsaFirstYearBatches } from "@/server/ovpsa/ovpsa-first-year.service";

export async function GET() {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await listOvpsaFirstYearBatches());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST() {
  try {
    await requireUser(["ADMIN"]);
    throw new AppError(
      "FIRST_YEAR_IMPORT_WORKFLOW_RETIRED",
      "Create First Year schedules through Schedule Import.",
      410,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
