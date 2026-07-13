import { dataResponse, errorResponse, pagination } from "@/lib/api-response";
import {
  parseAppointmentSummarySort,
  type OverallStatus,
} from "@/components/appointments/appointment-summary";
import { requireUser } from "@/server/auth/current-user";
import { isClinicCode } from "@/server/clinics";
import { complianceReport } from "@/server/repositories/tracking.repository";

const publishedComplianceStatuses = new Set(["PENDING", "COMPLETED", "NO_SHOW"]);
const resultStatuses = new Set(["PENDING", "COMPLETED", "REQUIRES_FOLLOW_UP", "NOT_APPLICABLE"]);
const overallStatuses = new Set<OverallStatus>(["FOLLOW_UP", "INCOMPLETE", "COMPLETE"]);

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const paging = pagination(params);
    const clinicCode = params.get("clinicCode");
    const appointmentStatus = params.get("appointmentStatus");
    const physicalExamStatus = params.get("physicalExamStatus");
    const laboratoryStatus = params.get("laboratoryStatus");
    const overallStatus = params.get("overallStatus") as OverallStatus | null;
    const appointmentDate = params.get("appointmentDate");
    return dataResponse({
      ...(await complianceReport({
        ...paging,
        clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined,
        collegeId: params.get("collegeId") || undefined,
        programId: params.get("programId") || undefined,
        priorityGroupId: params.get("priorityGroupId") || undefined,
        appointmentDate: appointmentDate && /^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)
          ? appointmentDate
          : undefined,
        physicalExamStatus: physicalExamStatus && resultStatuses.has(physicalExamStatus)
          ? physicalExamStatus
          : undefined,
        laboratoryStatus: laboratoryStatus && resultStatuses.has(laboratoryStatus)
          ? laboratoryStatus
          : undefined,
        appointmentStatus: appointmentStatus && publishedComplianceStatuses.has(appointmentStatus)
          ? appointmentStatus
          : undefined,
        overallStatus: overallStatus && overallStatuses.has(overallStatus) ? overallStatus : undefined,
        sort: parseAppointmentSummarySort(params.get("sort") || undefined),
        search: params.get("search") || undefined,
      })),
      page: paging.page,
      limit: paging.limit,
    });
  } catch (error) { return errorResponse(error); }
}
