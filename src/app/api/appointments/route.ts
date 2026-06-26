import { dataResponse, errorResponse, pagination } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { isClinicCode } from "@/server/clinics";
import { listAppointments } from "@/server/repositories/appointments.repository";

export async function GET(request: Request) {
  try {
    await requireUser(); const params = new URL(request.url).searchParams; const paging = pagination(params);
    const clinicCode = params.get("clinicCode");
    return dataResponse({ ...(await listAppointments({
      ...paging, appointmentDate: params.get("appointmentDate") || undefined,
      clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined,
      scheduleType: params.get("scheduleType") || undefined, status: params.get("status") || undefined,
      collegeId: params.get("collegeId") || undefined, programId: params.get("programId") || undefined,
      studentNumber: params.get("studentNumber") || undefined,
      isPublished: params.has("isPublished") ? params.get("isPublished") === "true" : undefined,
    })), page: paging.page, limit: paging.limit });
  } catch (error) { return errorResponse(error); }
}
