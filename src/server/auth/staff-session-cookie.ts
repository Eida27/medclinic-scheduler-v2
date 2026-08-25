import "server-only";
import { cookies } from "next/headers";
import type { SessionUser } from "@/types/roles";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "./session";

export async function setCurrentStaffSession(user: SessionUser) {
  const token = await createSessionToken(user);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.APP_URL?.startsWith("https://"),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}
