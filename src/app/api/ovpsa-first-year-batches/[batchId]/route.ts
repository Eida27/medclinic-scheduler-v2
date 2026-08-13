import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { getOvpsaFirstYearBatch } from "@/server/ovpsa/ovpsa-first-year.service";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(_: Request, context: Context) {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await getOvpsaFirstYearBatch((await context.params).batchId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH() {
  try {
    await requireUser(["ADMIN"]);
    throw new AppError(
      "FIRST_YEAR_IMPORT_WORKFLOW_RETIRED",
      "Update First Year schedules through Schedule Import.",
      410,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
