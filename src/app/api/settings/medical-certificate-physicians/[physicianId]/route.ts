import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { savePhysicianRevision } from "@/server/medical-certificates/physician.service";
import { profileFrom } from "../route";

type Context = { params: Promise<{ physicianId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { physicianId } = await context.params;
    if (!UUID.test(physicianId)) throw new AppError("PHYSICIAN_NOT_FOUND", "Physician profile not found.", 404);
    const form = await request.formData();
    const version = Number(form.get("expectedVersion"));
    if (!Number.isInteger(version) || version < 1) {
      throw new AppError("PHYSICIAN_STALE", "Reload the physician profile before editing.", 409);
    }
    const file = form.get("signature");
    if (file instanceof File && file.size > 1024 * 1024) {
      throw new AppError("SIGNATURE_INVALID", "The signature is too large.", 422);
    }
    return dataResponse(await savePhysicianRevision({
      physicianId, expectedVersion: version, profile: profileFrom(form),
      ...(file instanceof File && file.size > 0
        ? { signatureBytes: Buffer.from(await file.arrayBuffer()), signatureMediaType: file.type }
        : {}),
    }, actor));
  } catch (error) { return errorResponse(error); }
}
