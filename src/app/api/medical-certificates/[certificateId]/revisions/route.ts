import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { correctMedicalCertificate, listCertificateRevisions } from "@/server/medical-certificates/certificate.service";

type Context = { params: Promise<{ certificateId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
async function certificateIdFrom(context: Context) {
  const { certificateId } = await context.params;
  if (!UUID.test(certificateId)) throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
  return certificateId;
}

export async function GET(_: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    return dataResponse(await listCertificateRevisions(await certificateIdFrom(context), actor),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    return dataResponse(await correctMedicalCertificate(await certificateIdFrom(context), await request.json(), actor),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
