import "server-only";
import { cookies } from "next/headers";
import { AppError } from "@/lib/errors";
import { authorizeSession } from "@/server/services/auth.service";
import type { UserRole } from "@/types/roles";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export async function requireUser(allowedRoles?: UserRole[]) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401);
  try {
    return await authorizeSession(await verifySessionToken(token), allowedRoles);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401);
  }
}

export async function optionalUser() {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}
