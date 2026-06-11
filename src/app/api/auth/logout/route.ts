import { cookies } from "next/headers";
import { dataResponse } from "@/lib/api-response";
import { SESSION_COOKIE } from "@/server/auth/session";

export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return dataResponse({ success: true });
}
