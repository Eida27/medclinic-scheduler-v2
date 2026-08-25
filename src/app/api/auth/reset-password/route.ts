import { dataResponse, errorResponse } from "@/lib/api-response";
import { resetStaffPassword } from "@/server/services/staff-password-recovery.service";

export async function POST(request: Request) {
  try {
    await resetStaffPassword(await request.json());
    return dataResponse({ reset: true, nextPath: "/login" });
  } catch (error) {
    return errorResponse(error);
  }
}
