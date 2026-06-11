import { cookies } from "next/headers";
import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
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
    const user = await authenticate(input.email, input.password);
    const token = await createSessionToken(user);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.APP_URL?.startsWith("https://"),
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
    return dataResponse(user);
  } catch (error) {
    return errorResponse(error);
  }
}
