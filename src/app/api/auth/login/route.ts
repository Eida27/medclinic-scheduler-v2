import { cookies } from "next/headers";
import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requestIp } from "@/server/security/request-ip";
import { authenticate } from "@/server/services/auth.service";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/server/auth/session";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const user = await authenticate(
      input.email,
      input.password,
      requestIp(request),
    );
    const token = await createSessionToken(user);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.APP_URL?.startsWith("https://"),
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
    return dataResponse({
      ...user,
      nextPath: user.onboardingRequired ? "/account/onboarding" : "/dashboard",
    });
  } catch (error) {
    const response = errorResponse(error);
    if (
      error instanceof AppError
      && error.code === "STAFF_LOGIN_THROTTLED"
      && typeof error.details === "object"
      && error.details !== null
      && "retryAfterSeconds" in error.details
      && typeof error.details.retryAfterSeconds === "number"
    ) {
      response.headers.set("Retry-After", String(error.details.retryAfterSeconds));
    }
    return response;
  }
}
