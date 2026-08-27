import { dataResponse, errorResponse } from "@/lib/api-response";
import { schedulingWorkflowRetiredError } from "@/lib/retired-workflows";
import { isClinicCode } from "@/server/clinics";
import { requireUser } from "@/server/auth/current-user";
import { listScheduleBatches } from "@/server/repositories/coordinator-schedules.repository";

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const clinicCode = params.get("clinicCode");
    return dataResponse(await listScheduleBatches({ clinicCode: isClinicCode(clinicCode) ? clinicCode : undefined }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(_request: Request) {
  try {
    await requireUser();
    throw schedulingWorkflowRetiredError();
  } catch (error) {
    return errorResponse(error);
  }
}
