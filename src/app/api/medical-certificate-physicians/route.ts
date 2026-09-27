import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listPhysicians } from "@/server/medical-certificates/physician.service";

export async function GET() {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    return dataResponse(await listPhysicians(actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
