import "server-only";
import bcrypt from "bcryptjs";
import { AppError } from "@/lib/errors";
import { findUserByEmail, findUserById } from "@/server/repositories/users.repository";
import type { SessionUser, UserRole } from "@/types/roles";

export type AuthenticatedStaff = SessionUser & {
  emailVerifiedAt: string | null;
  mustChangePassword: boolean;
  status: "PENDING_VERIFICATION" | "PASSWORD_CHANGE_REQUIRED" | "ACTIVE";
  onboardingRequired: boolean;
};

function sessionUser(user: Awaited<ReturnType<typeof findUserById>>): AuthenticatedStaff {
  if (!user) throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    clinicId: user.clinicId,
    clinicCode: user.clinicCode,
    clinicName: user.clinicName,
    credentialVersion: user.credentialVersion,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    mustChangePassword: user.mustChangePassword,
    status: user.status,
    onboardingRequired: user.status !== "ACTIVE",
  };
}

export async function authenticate(email: string, password: string): Promise<AuthenticatedStaff> {
  const user = await findUserByEmail(email.trim().toLowerCase());
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !valid) {
    throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }
  return sessionUser(user);
}

export async function authorizeAuthenticatedStaff(
  user: SessionUser,
  allowedRoles?: UserRole[],
): Promise<AuthenticatedStaff> {
  const current = await findUserById(user.userId);
  if (!current || current.credentialVersion !== user.credentialVersion) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  if (allowedRoles && !allowedRoles.includes(current.role)) {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
  return sessionUser(current);
}

export async function authorizeSession(user: SessionUser, allowedRoles?: UserRole[]) {
  const current = await authorizeAuthenticatedStaff(user, allowedRoles);
  if (current.onboardingRequired) {
    throw new AppError(
      "ONBOARDING_REQUIRED",
      "Complete account security onboarding before using MedClinic.",
      403,
      undefined,
      { nextPath: "/account/onboarding", status: current.status },
    );
  }
  return current;
}
