import { errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { downloadMedicalCertificateRevision } from "@/server/medical-certificates/certificate.service";

type Context = { params: Promise<{ certificateId: string; revisionId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function GET(_: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
    const { certificateId, revisionId } = await context.params;
    if (!UUID.test(certificateId) || !UUID.test(revisionId)) {
      throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate revision not found.", 404);
    }
    const result = await downloadMedicalCertificateRevision(certificateId, revisionId, actor);
    return new Response(new Uint8Array(result.jpegBytes), { headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="medical-certificate-${result.studentNumber.replace(/[^a-z0-9-]/giu, "")}-r${result.revisionNumber}.jpg"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
