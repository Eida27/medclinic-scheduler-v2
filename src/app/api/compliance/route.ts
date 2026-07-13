import { dataResponse, errorResponse, pagination } from "@/lib/api-response";
import { parseAppointmentSummarySort } from "@/components/appointments/appointment-summary";
import { requireUser } from "@/server/auth/current-user";
import { complianceReport } from "@/server/repositories/tracking.repository";
import { z } from "zod";

const complianceQuerySchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]).optional(),
  collegeId: z.string().uuid().optional(),
  programId: z.string().uuid().optional(),
  priorityGroupId: z.string().uuid().optional(),
  appointmentDate: z.iso.date().optional(),
  appointmentStatus: z.enum(["PENDING", "COMPLETED", "NO_SHOW"]).optional(),
  physicalExamStatus: z.enum(["PENDING", "COMPLETED", "REQUIRES_FOLLOW_UP", "NOT_APPLICABLE"]).optional(),
  laboratoryStatus: z.enum(["PENDING", "COMPLETED", "REQUIRES_FOLLOW_UP", "NOT_APPLICABLE"]).optional(),
  overallStatus: z.enum(["FOLLOW_UP", "INCOMPLETE", "COMPLETE"]).optional(),
  search: z.string().trim().max(100).optional(),
});

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const paging = pagination(params);
    const input = complianceQuerySchema.parse({
      clinicCode: params.get("clinicCode") || undefined,
      collegeId: params.get("collegeId") || undefined,
      programId: params.get("programId") || undefined,
      priorityGroupId: params.get("priorityGroupId") || undefined,
      appointmentDate: params.get("appointmentDate") || undefined,
      appointmentStatus: params.get("appointmentStatus") || undefined,
      physicalExamStatus: params.get("physicalExamStatus") || undefined,
      laboratoryStatus: params.get("laboratoryStatus") || undefined,
      overallStatus: params.get("overallStatus") || undefined,
      search: params.get("search") || undefined,
    });
    return dataResponse({
      ...(await complianceReport({
        ...paging,
        ...input,
        sort: parseAppointmentSummarySort(params.get("sort") || undefined),
      })),
      page: paging.page,
      limit: paging.limit,
    });
  } catch (error) { return errorResponse(error); }
}
