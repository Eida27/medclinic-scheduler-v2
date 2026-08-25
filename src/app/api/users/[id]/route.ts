import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { deleteStaffUser } from "@/server/services/staff-administration.service";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { id } = await context.params;
    return dataResponse(await deleteStaffUser(actor.userId, id));
  } catch (error) {
    return errorResponse(error);
  }
}
