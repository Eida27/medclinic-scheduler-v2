import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { loadPhysicalExamCompletionContext } from "@/server/medical-certificates/physical-exam-completion-context.service";

type Context = { params: Promise<{ appointmentId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const { appointmentId } = await context.params;
    if (!UUID.test(appointmentId)) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    return dataResponse(await loadPhysicalExamCompletionContext(appointmentId, actor),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
