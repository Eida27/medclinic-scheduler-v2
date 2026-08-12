import { z } from "zod";
import { requireUser } from "@/server/auth/current-user";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { verifyOvpsaExternalLaboratory } from "@/server/ovpsa/external-laboratory-verification.service";

type Context = { params: Promise<{ appointmentId: string }> };
const schema = z.object({ remarks: z.string().trim().max(1000).nullable().default(null) }).strict();

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    return dataResponse(await verifyOvpsaExternalLaboratory(
      (await context.params).appointmentId,
      schema.parse(await request.json()),
      actor,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
