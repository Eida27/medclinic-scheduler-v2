import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "@/server/laboratory/laboratory-checklist.service";

type Context = { params: Promise<{ appointmentId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function idFrom(context: Context) {
  const { appointmentId } = await context.params;
  if (!UUID.test(appointmentId)) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  return appointmentId;
}

export async function GET(_: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const appointmentId = await idFrom(context);
    return dataResponse(await getLaboratoryChecklist(appointmentId, actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const appointmentId = await idFrom(context);
    return dataResponse(await setLaboratoryTestVerification(appointmentId, await request.json(), actor));
  } catch (error) {
    return errorResponse(error);
  }
}
