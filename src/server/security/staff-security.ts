import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const staffEmailSchema = z.string().trim().toLowerCase().email().max(254);
export const staffFullNameSchema = z.string().trim().min(2).max(150);
export const staffPasswordSchema = z.string().min(8).max(100);

export function createSecurityToken() {
  return randomBytes(32).toString("base64url");
}

export function securityTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function addressMetadata(email: string) {
  const normalized = email.trim().toLowerCase();
  const [local = "", domain = ""] = normalized.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return {
    addressMasked: `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`,
    addressHash: createHash("sha256").update(normalized).digest("hex"),
  };
}

export type StaffAccountStatus =
  | "PENDING_VERIFICATION"
  | "PASSWORD_CHANGE_REQUIRED"
  | "ACTIVE";

export function staffAccountStatus(input: {
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
}): StaffAccountStatus {
  if (!input.emailVerifiedAt) return "PENDING_VERIFICATION";
  return input.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "ACTIVE";
}
