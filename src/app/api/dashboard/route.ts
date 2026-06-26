import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { isClinicCode } from "@/server/clinics";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";
export async function GET(request: Request) {
  try {
    await requireUser();
    const clinicCode = new URL(request.url).searchParams.get("clinicCode");
    return dataResponse(await dashboardMetrics({ clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined }));
  } catch (error) { return errorResponse(error); }
}
