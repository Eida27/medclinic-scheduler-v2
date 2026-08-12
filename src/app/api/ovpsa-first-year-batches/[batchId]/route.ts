import { z } from "zod";

import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import {
  getOvpsaFirstYearBatch,
  updateOvpsaFirstYearDraft,
} from "@/server/ovpsa/ovpsa-first-year.service";

type Context = { params: Promise<{ batchId: string }> };
const updateSchema = z.object({
  optimisticToken: z.string().uuid(),
  laboratoryDate: z.iso.date(),
  physicalExamDateOverride: z.iso.date().nullable().default(null),
  physicalExamExceptionReason: z.string().trim().min(3).max(1000).nullable().default(null),
}).strict();

export async function GET(_: Request, context: Context) {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await getOvpsaFirstYearBatch((await context.params).batchId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await updateOvpsaFirstYearDraft(
      (await context.params).batchId,
      updateSchema.parse(await request.json()),
      actor.userId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
