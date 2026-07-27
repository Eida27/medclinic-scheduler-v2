import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listClinicClosureManualCases } from "@/server/services/clinic-calendar.service";

export async function GET(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const search = new URL(request.url).searchParams;
    return dataResponse(await listClinicClosureManualCases({
      page: Number(search.get("page") ?? 1),
      pageSize: Number(search.get("pageSize") ?? 20),
      search: search.get("search") ?? undefined,
      reasonCode: search.get("reasonCode") ?? undefined,
      status: search.get("status") ?? undefined,
    }, actor));
  } catch (error) {
    return errorResponse(error);
  }
}
