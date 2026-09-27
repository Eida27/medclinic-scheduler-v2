import { errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { previewPhysicalExam } from "@/server/medical-certificates/certificate.service";

type Context = { params: Promise<{ appointmentId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const { appointmentId } = await context.params;
    if (!UUID.test(appointmentId)) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    const bytes = await previewPhysicalExam(appointmentId, await request.json(), actor);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
