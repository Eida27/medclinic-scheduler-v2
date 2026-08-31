import "server-only";
import bcrypt from "bcryptjs";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  clearStaffEmailFailures,
  getStaffLoginThrottle,
  lockStaffLoginBuckets,
  pruneExpiredStaffLoginFailures,
  recordStaffLoginFailure,
} from "@/server/repositories/staff-login-throttle.repository";
import {
  findUserByEmail,
  findUserById,
  type UserRecord,
} from "@/server/repositories/users.repository";
import type { SessionUser, UserRole } from "@/types/roles";

const DUMMY_PASSWORD_HASH = "$2b$12$4a9hawc1BbRSN/DBTfpEGe0NNOV3car3dSWB8ULKlJx4k8QqG8JX.";

type AuthenticationOutcome =
  | { type: "success"; user: UserRecord }
  | { type: "invalid" }
  | { type: "throttled"; retryAfterSeconds: number };

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

export async function authenticate(
  email: string,
  password: string,
  ipAddress: string,
): Promise<AuthenticatedStaff> {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedIpAddress = ipAddress.trim();
  if (!normalizedIpAddress) {
    throw new AppError("VALIDATION_ERROR", "IP address is required.", 422);
  }

  const outcome = await transaction<AuthenticationOutcome>(async (client) => {
    await lockStaffLoginBuckets(client, normalizedEmail, normalizedIpAddress);
    await pruneExpiredStaffLoginFailures(client);

    let throttle = await getStaffLoginThrottle(client, normalizedEmail, normalizedIpAddress);
    if (throttle.throttled) {
      return { type: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
    }

    const user = await findUserByEmail(normalizedEmail, client);
    const valid = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !valid) {
      await recordStaffLoginFailure(client, normalizedEmail, normalizedIpAddress);
      throttle = await getStaffLoginThrottle(client, normalizedEmail, normalizedIpAddress);
      return throttle.throttled
        ? { type: "throttled", retryAfterSeconds: throttle.retryAfterSeconds }
        : { type: "invalid" };
    }

    await clearStaffEmailFailures(client, normalizedEmail);
    return { type: "success", user };
  });

  if (outcome.type === "throttled") {
    throw new AppError(
      "STAFF_LOGIN_THROTTLED",
      "Too many sign-in attempts. Try again later.",
      429,
      undefined,
      { retryAfterSeconds: outcome.retryAfterSeconds },
    );
  }
  if (outcome.type === "invalid") {
    throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }
  return sessionUser(outcome.user);
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
