import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireAuthenticatedStaff } from "@/server/auth/current-user";
import { getStaffOnboardingState } from "@/server/services/staff-account-security.service";

export async function GET() {
  try {
    const user = await requireAuthenticatedStaff();
    return dataResponse(await getStaffOnboardingState(user.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
