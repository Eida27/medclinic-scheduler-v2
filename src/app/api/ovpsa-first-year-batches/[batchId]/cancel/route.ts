import { z } from "zod";
import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { cancelOvpsaFirstYearBatch } from "@/server/ovpsa/ovpsa-first-year.service";

type Context = { params: Promise<{ batchId: string }> };
const schema = z.object({
  optimisticToken: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await cancelOvpsaFirstYearBatch(
      (await context.params).batchId,
      schema.parse(await request.json()),
      actor.userId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
