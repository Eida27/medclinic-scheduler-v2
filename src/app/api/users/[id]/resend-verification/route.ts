import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { resendStaffVerification } from "@/server/services/staff-administration.service";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { id } = await context.params;
    return dataResponse(await resendStaffVerification(id, actor.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
