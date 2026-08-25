import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { setCurrentStaffSession } from "@/server/auth/staff-session-cookie";
import { changeStaffPassword } from "@/server/services/staff-account-security.service";

const schema = z.object({ currentPassword: z.string(), newPassword: z.string(), confirmPassword: z.string() });

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const changed = await changeStaffPassword(user.userId, schema.parse(await request.json()));
    await setCurrentStaffSession(changed);
    return dataResponse({ account: changed, nextPath: "/account" });
  } catch (error) {
    return errorResponse(error);
  }
}
