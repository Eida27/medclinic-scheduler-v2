export type UserRole = "ADMIN" | "COORDINATOR" | "CLINIC_STAFF";

export function isImportOperatorRole(role: UserRole): role is "ADMIN" | "COORDINATOR" {
  return role === "ADMIN" || role === "COORDINATOR";
}

export type SessionUser = {
  userId: string;
  fullName: string;
  email: string;
  role: UserRole;
  clinicId?: string | null;
  clinicCode?: string | null;
  clinicName?: string | null;
};
