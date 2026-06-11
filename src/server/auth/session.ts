import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { serverEnv } from "@/lib/env";
import type { SessionUser, UserRole } from "@/types/roles";

export const SESSION_COOKIE = "medclinic_session";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function secret(): Uint8Array {
  return new TextEncoder().encode(serverEnv().JWT_SECRET);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({
    fullName: user.fullName,
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<SessionUser> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
  if (
    !payload.sub ||
    typeof payload.fullName !== "string" ||
    typeof payload.email !== "string" ||
    (payload.role !== "ADMIN" && payload.role !== "CLINIC_STAFF")
  ) {
    throw new Error("Invalid session payload");
  }
  return {
    userId: payload.sub,
    fullName: payload.fullName,
    email: payload.email,
    role: payload.role as UserRole,
  };
}
