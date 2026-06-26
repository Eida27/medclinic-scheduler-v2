import "server-only";
import bcrypt from "bcryptjs";
import { AppError } from "@/lib/errors";
import { findUserByEmail, findUserById } from "@/server/repositories/users.repository";
import type { SessionUser, UserRole } from "@/types/roles";

export async function authenticate(email: string, password: string): Promise<SessionUser> {
  const user = await findUserByEmail(email.trim().toLowerCase());
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !user.isActive || !valid) {
    throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }

  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    clinicId: user.clinicId,
    clinicCode: user.clinicCode,
    clinicName: user.clinicName,
  };
}

export async function authorizeSession(user: SessionUser, allowedRoles?: UserRole[]): Promise<SessionUser> {
  const current = await findUserById(user.userId);
  if (!current || !current.isActive) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  if (allowedRoles && !allowedRoles.includes(current.role)) {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
  return {
    userId: current.id,
    fullName: current.fullName,
    email: current.email,
    role: current.role,
    clinicId: current.clinicId,
    clinicCode: current.clinicCode,
    clinicName: current.clinicName,
  };
}
