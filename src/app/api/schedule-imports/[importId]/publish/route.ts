import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { publishScheduleImport } from "@/server/services/schedule-imports.service";

const schema = z.object({ confirm: z.literal(true) });
type Context = { params: Promise<{ importId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await request.text();
    schema.parse(body.trim() ? JSON.parse(body) : {});
    return dataResponse(await publishScheduleImport((await context.params).importId, user));
  } catch (error) {
    return errorResponse(error);
  }
}
