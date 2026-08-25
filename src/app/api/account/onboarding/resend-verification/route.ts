import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireAuthenticatedStaff } from "@/server/auth/current-user";
import { resendOwnStaffVerification } from "@/server/services/staff-email-verification.service";

export async function POST() {
  try {
    const user = await requireAuthenticatedStaff();
    return dataResponse(await resendOwnStaffVerification(user.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
