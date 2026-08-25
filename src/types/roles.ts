export type UserRole = "ADMIN" | "COORDINATOR" | "CLINIC_STAFF";

export type HistoricalStaffActor = {
  fullName: string;
  role: UserRole;
  deleted: boolean;
};

export function isImportOperatorRole(role: UserRole): role is "ADMIN" | "COORDINATOR" {
  return role === "ADMIN" || role === "COORDINATOR";
}

export type SessionUser = {
  userId: string;
  fullName: string;
  email: string;
  role: UserRole;
  credentialVersion?: number;
  clinicId?: string | null;
  clinicCode?: string | null;
  clinicName?: string | null;
};
