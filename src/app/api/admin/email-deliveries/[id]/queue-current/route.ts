import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireAdministrator } from "@/server/auth/admin-authorization";
import { queueCurrentAdminEmailDelivery } from "@/server/services/admin-email-deliveries.service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireAdministrator();
    return dataResponse(await queueCurrentAdminEmailDelivery((await context.params).id, actor.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
