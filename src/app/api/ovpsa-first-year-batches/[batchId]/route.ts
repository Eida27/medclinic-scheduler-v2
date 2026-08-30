import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
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
