import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listScheduleBatches } from "@/server/repositories/coordinator-schedules.repository";
import { addScheduleBatch } from "@/server/services/coordinator-schedules.service";

export async function GET() {
  try { await requireUser(); return dataResponse(await listScheduleBatches()); } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try { const user = await requireUser(); return dataResponse(await addScheduleBatch(await request.json(), user.userId), { status: 201 }); } catch (error) { return errorResponse(error); }
}
