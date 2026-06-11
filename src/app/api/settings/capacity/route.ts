import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getCapacitySettings } from "@/server/repositories/appointments.repository";
import { changeCapacity } from "@/server/services/appointments.service";

export async function GET() { try { await requireUser(); return dataResponse(await getCapacitySettings()); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request) { try { const user = await requireUser(["ADMIN"]); return dataResponse(await changeCapacity(await request.json(), user.userId)); } catch (error) { return errorResponse(error); } }
