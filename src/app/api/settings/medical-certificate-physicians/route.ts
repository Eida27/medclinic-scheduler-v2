import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { listPhysicians, savePhysicianRevision } from "@/server/medical-certificates/physician.service";

function profileFrom(form: FormData) {
  return {
    displayName: form.get("displayName"),
    licenseNumber: form.get("licenseNumber"),
    specialty: form.get("specialty") || null,
    active: form.get("active") === "true",
  };
}

async function signatureFrom(form: FormData) {
  const file = form.get("signature");
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError("SIGNATURE_REQUIRED", "Upload the physician's authorized signature.", 422);
  }
  if (file.size > 1024 * 1024) throw new AppError("SIGNATURE_INVALID", "The signature is too large.", 422);
  return { signatureBytes: Buffer.from(await file.arrayBuffer()), signatureMediaType: file.type };
}

export async function GET() {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await listPhysicians(actor, true), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const form = await request.formData();
    return dataResponse(await savePhysicianRevision({ profile: profileFrom(form), ...await signatureFrom(form) }, actor));
  } catch (error) { return errorResponse(error); }
}

export { profileFrom };
