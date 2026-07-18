import { cookies } from "next/headers";
import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import {
  createStudentSessionToken,
  STUDENT_SESSION_COOKIE,
  STUDENT_SESSION_MAX_AGE_SECONDS,
} from "@/server/auth/student-session";
import { authenticateStudent } from "@/server/services/student-auth.service";

const loginSchema = z.object({
  studentNumber: z.string().trim().min(1).max(20),
  dateOfBirth: z.iso.date(),
});

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const session = await authenticateStudent({ ...input, ipAddress: requestIp(request).slice(0, 64) });
    const token = await createStudentSessionToken(session);
    (await cookies()).set(STUDENT_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.APP_URL?.startsWith("https://"),
      maxAge: STUDENT_SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
    return dataResponse(session);
  } catch (error) {
    return errorResponse(error);
  }
}
