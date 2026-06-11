import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";
export async function GET() { try { await requireUser(); return dataResponse(await dashboardMetrics()); } catch (error) { return errorResponse(error); } }
