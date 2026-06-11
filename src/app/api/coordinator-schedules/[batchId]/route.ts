import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import { editBatch } from "@/server/services/coordinator-schedules.service";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(_: Request, context: Context) {
  try { await requireUser(); const batch = await getScheduleBatch((await context.params).batchId); if (!batch) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404); return dataResponse(batch); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { const user = await requireUser(); return dataResponse(await editBatch((await context.params).batchId, await request.json(), user.userId)); } catch (error) { return errorResponse(error); }
}
