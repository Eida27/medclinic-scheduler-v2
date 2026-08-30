import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { listOvpsaFirstYearBatches } from "@/server/ovpsa/ovpsa-first-year.service";

export async function GET() {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await listOvpsaFirstYearBatches());
  } catch (error) {
    return errorResponse(error);
  }
}
