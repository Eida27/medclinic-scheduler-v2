import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { generateScheduleImport } from "@/server/services/schedule-imports.service";

const schema = z.object({ overrideReason: z.string().max(500).optional() });
type Context = { params: Promise<{ importId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireUser(["ADMIN"]);
    const body = await request.text();
    const input = schema.parse(body.trim() ? JSON.parse(body) : {});
    return dataResponse(await generateScheduleImport(
      (await context.params).importId,
      user,
      input.overrideReason,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
