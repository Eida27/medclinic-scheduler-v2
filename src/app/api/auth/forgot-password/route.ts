import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requestStaffPasswordReset } from "@/server/services/staff-password-recovery.service";

const schema = z.object({ email: z.string() });

export async function POST(request: Request) {
  try {
    const { email } = schema.parse(await request.json());
    return dataResponse(await requestStaffPasswordReset(email));
  } catch (error) {
    return errorResponse(error);
  }
}
