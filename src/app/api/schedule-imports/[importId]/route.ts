import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getScheduleImport } from "@/server/services/schedule-imports.service";

type Context = { params: Promise<{ importId: string }> };

export async function GET(_: Request, context: Context) {
  try {
    const user = await requireUser(["ADMIN"]);
    return dataResponse(await getScheduleImport((await context.params).importId, user));
  } catch (error) {
    return errorResponse(error);
  }
}
