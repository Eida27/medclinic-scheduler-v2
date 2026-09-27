import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { commitBulkReplacement } from "@/server/appointments/bulk-replacement.service";

export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    return dataResponse(await commitBulkReplacement(await request.json(), actor),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
