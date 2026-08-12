import { z } from "zod";

import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import {
  createOvpsaFirstYearBatch,
  listOvpsaFirstYearBatches,
} from "@/server/ovpsa/ovpsa-first-year.service";

const createSchema = z.object({
  scheduleCycleStart: z.number().int().min(2020).max(2100),
  collegeId: z.string().uuid(),
  laboratoryDate: z.iso.date(),
  physicalExamDateOverride: z.iso.date().nullable().default(null),
  physicalExamExceptionReason: z.string().trim().min(3).max(1000).nullable().default(null),
}).strict();

export async function GET() {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await listOvpsaFirstYearBatches());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(
      await createOvpsaFirstYearBatch(createSchema.parse(await request.json()), actor.userId),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
