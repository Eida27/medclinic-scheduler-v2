import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { validateScheduleImport } from "@/server/services/schedule-imports.service";

type Context = { params: Promise<{ importId: string }> };

export async function POST(_: Request, context: Context) {
  try {
    const user = await requireUser(["ADMIN"]);
    return dataResponse(await validateScheduleImport((await context.params).importId, user));
  } catch (error) {
    return errorResponse(error);
  }
}
