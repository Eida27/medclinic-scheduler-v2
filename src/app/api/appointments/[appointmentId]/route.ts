import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { getPublishedAppointment } from "@/server/repositories/appointments.repository";
import { updateAppointment } from "@/server/services/appointments.service";

type Context = { params: Promise<{ appointmentId: string }> };
export async function GET(_: Request, context: Context) { try { await requireUser(); const item = await getPublishedAppointment((await context.params).appointmentId); if (!item) throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404); return dataResponse(item); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request, context: Context) { try { const user = await requireUser(["ADMIN", "CLINIC_STAFF"]); return dataResponse(await updateAppointment((await context.params).appointmentId, await request.json(), user)); } catch (error) { return errorResponse(error); } }
