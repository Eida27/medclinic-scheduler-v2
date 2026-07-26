import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import {
  listClinicUnavailableDates,
  saveClinicCalendarChanges,
} from "@/server/services/clinic-calendar.service";

export async function GET() {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await listClinicUnavailableDates(actor));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("INVALID_JSON", "The request body must be valid JSON.", 400);
    }
    return dataResponse(await saveClinicCalendarChanges(body, actor), { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
