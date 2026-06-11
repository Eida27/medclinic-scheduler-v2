import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";

export async function GET() {
  try {
    return dataResponse(await requireUser());
  } catch (error) {
    return errorResponse(error);
  }
}
