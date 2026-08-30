import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { getPublishedAppointment } from "@/server/repositories/appointments.repository";
import { updateAppointment } from "@/server/services/appointments.service";

type Context = { params: Promise<{ appointmentId: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function assertAppointmentId(appointmentId: string) {
  if (!UUID_PATTERN.test(appointmentId)) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
  }
}

export async function GET(_: Request, context: Context) {
  try {
    await requireUser();
    const { appointmentId } = await context.params;
    assertAppointmentId(appointmentId);
    const item = await getPublishedAppointment(appointmentId);
    if (!item) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
    }
    return dataResponse(item);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const user = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const { appointmentId } = await context.params;
    assertAppointmentId(appointmentId);
    return dataResponse(await updateAppointment(appointmentId, await request.json(), user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(_: Request, context: Context) {
  try {
    await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const { appointmentId } = await context.params;
    assertAppointmentId(appointmentId);
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, PATCH" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
