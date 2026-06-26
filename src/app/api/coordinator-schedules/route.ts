import { dataResponse, errorResponse } from "@/lib/api-response";
import { isClinicCode } from "@/server/clinics";
import { requireUser } from "@/server/auth/current-user";
import { listScheduleBatches } from "@/server/repositories/coordinator-schedules.repository";
import { addScheduleBatch } from "@/server/services/coordinator-schedules.service";

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const clinicCode = params.get("clinicCode");
    return dataResponse(await listScheduleBatches({ clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try { const user = await requireUser(); return dataResponse(await addScheduleBatch(await request.json(), user), { status: 201 }); } catch (error) { return errorResponse(error); }
}
