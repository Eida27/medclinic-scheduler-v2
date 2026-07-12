import { dataResponse, errorResponse, pagination } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { isClinicCode } from "@/server/clinics";
import { complianceReport } from "@/server/repositories/tracking.repository";

const publishedComplianceStatuses = new Set(["PENDING", "COMPLETED", "NO_SHOW"]);

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const paging = pagination(params);
    const clinicCode = params.get("clinicCode");
    const appointmentStatus = params.get("appointmentStatus");
    return dataResponse({
      ...(await complianceReport({
        ...paging,
        clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined,
        collegeId: params.get("collegeId") || undefined,
        programId: params.get("programId") || undefined,
        priorityGroupId: params.get("priorityGroupId") || undefined,
        physicalExamStatus: params.get("physicalExamStatus") || undefined,
        laboratoryStatus: params.get("laboratoryStatus") || undefined,
        appointmentStatus: appointmentStatus && publishedComplianceStatuses.has(appointmentStatus)
          ? appointmentStatus
          : undefined,
        search: params.get("search") || undefined,
      })),
      page: paging.page,
      limit: paging.limit,
    });
  } catch (error) { return errorResponse(error); }
}
