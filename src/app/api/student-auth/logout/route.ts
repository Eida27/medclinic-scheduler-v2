import { cookies } from "next/headers";
import { dataResponse } from "@/lib/api-response";
import { STUDENT_SESSION_COOKIE } from "@/server/auth/student-session";

export async function POST() {
  (await cookies()).delete(STUDENT_SESSION_COOKIE);
  return dataResponse({ success: true });
}
