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
  if (!Number.isInteger(user.credentialVersion) || (user.credentialVersion ?? 0) < 1) {
    throw new Error("A positive credential version is required to create a staff session.");
  }
  return new SignJWT({
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    credentialVersion: user.credentialVersion,
    clinicId: user.clinicId ?? null,
    clinicCode: user.clinicCode ?? null,
    clinicName: user.clinicName ?? null,
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
    (payload.role !== "ADMIN" && payload.role !== "COORDINATOR" && payload.role !== "CLINIC_STAFF") ||
    !Number.isInteger(payload.credentialVersion) ||
    (payload.credentialVersion as number) < 1 ||
    (payload.clinicId !== null && payload.clinicId !== undefined && typeof payload.clinicId !== "string") ||
    (payload.clinicCode !== null && payload.clinicCode !== undefined && typeof payload.clinicCode !== "string") ||
    (payload.clinicName !== null && payload.clinicName !== undefined && typeof payload.clinicName !== "string")
  ) {
    throw new Error("Invalid session payload");
  }
  return {
    userId: payload.sub,
    fullName: payload.fullName,
    email: payload.email,
    role: payload.role as UserRole,
    credentialVersion: payload.credentialVersion as number,
    clinicId: typeof payload.clinicId === "string" ? payload.clinicId : null,
    clinicCode: typeof payload.clinicCode === "string" ? payload.clinicCode : null,
    clinicName: typeof payload.clinicName === "string" ? payload.clinicName : null,
  };
}
