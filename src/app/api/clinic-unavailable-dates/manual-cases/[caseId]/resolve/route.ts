import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { resolveClinicClosureManualCase } from "@/server/services/clinic-calendar.service";

type Context = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { caseId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("INVALID_JSON", "The request body must be valid JSON.", 400);
    }
    return dataResponse(await resolveClinicClosureManualCase(caseId, body, actor));
  } catch (error) {
    return errorResponse(error);
  }
}
