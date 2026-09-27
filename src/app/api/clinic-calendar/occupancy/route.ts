import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { annualCalendarOccupancy } from "@/server/services/calendar-occupancy.service";

export async function GET(request: Request) {
  try {
    await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const year = Number(new URL(request.url).searchParams.get("year"));
    return dataResponse(await annualCalendarOccupancy(year),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
