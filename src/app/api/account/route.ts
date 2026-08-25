import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getStaffAccountSummary } from "@/server/services/staff-account-security.service";

export async function GET() {
  try {
    const user = await requireUser();
    return dataResponse(await getStaffAccountSummary(user.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
