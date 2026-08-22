import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireAdministrator } from "@/server/auth/admin-authorization";
import { listAdminEmailDeliveries } from "@/server/services/admin-email-deliveries.service";
import type { EmailDeliveryState } from "@/server/repositories/admin-email-deliveries.repository";

const states = new Set<EmailDeliveryState>(["Pending", "Sent", "Retrying", "Failed"]);

export async function GET(request: Request) {
  try {
    await requireAdministrator();
    const params = new URL(request.url).searchParams;
    const requestedState = params.get("state") as EmailDeliveryState | null;
    return dataResponse(await listAdminEmailDeliveries({
      scope: params.get("scope") === "history" ? "history" : "actionable",
      ...(requestedState && states.has(requestedState) ? { state: requestedState } : {}),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
