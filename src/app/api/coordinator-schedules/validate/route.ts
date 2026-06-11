import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { validateBatch } from "@/server/services/coordinator-schedules.service";

const schema = z.object({ batchId: z.string().uuid() });
export async function POST(request: Request) {
  try { const user = await requireUser(); const input = schema.parse(await request.json()); return dataResponse(await validateBatch(input.batchId, user.userId)); } catch (error) { return errorResponse(error); }
}
