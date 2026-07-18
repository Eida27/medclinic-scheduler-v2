import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import {
  createClinicUnavailableDate,
  listClinicUnavailableDates,
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
    return dataResponse(await createClinicUnavailableDate(await request.json(), actor), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
