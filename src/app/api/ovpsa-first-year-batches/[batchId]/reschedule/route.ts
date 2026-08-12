import { z } from "zod";
import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { rescheduleOvpsaFirstYearBatch } from "@/server/ovpsa/ovpsa-first-year.service";

type Context = { params: Promise<{ batchId: string }> };
const schema = z.object({
  optimisticToken: z.string().uuid(),
  laboratoryDate: z.iso.date().nullable().optional(),
  physicalExamDateOverride: z.iso.date().nullable().optional(),
  physicalExamExceptionReason: z.string().trim().min(3).max(1000).nullable().optional(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await rescheduleOvpsaFirstYearBatch(
      (await context.params).batchId,
      schema.parse(await request.json()),
      actor.userId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
