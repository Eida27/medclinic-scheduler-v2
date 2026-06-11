import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { generateBatchAppointments } from "@/server/services/coordinator-schedules.service";

const schema = z.object({ batchId: z.string().uuid(), overrideReason: z.string().max(500).optional() });
export async function POST(request: Request) {
  try { const user = await requireUser(); const input = schema.parse(await request.json()); return dataResponse(await generateBatchAppointments(input.batchId, user, input.overrideReason)); } catch (error) { return errorResponse(error); }
}
