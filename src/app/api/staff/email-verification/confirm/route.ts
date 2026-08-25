import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { confirmStaffEmail } from "@/server/services/staff-email-verification.service";

const schema = z.object({ token: z.string().min(1).max(256) });

export async function POST(request: Request) {
  try {
    const { token } = schema.parse(await request.json());
    return dataResponse(await confirmStaffEmail(token));
  } catch (error) {
    return errorResponse(error);
  }
}
