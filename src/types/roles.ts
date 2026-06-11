export type UserRole = "ADMIN" | "CLINIC_STAFF";

export type SessionUser = {
  userId: string;
  fullName: string;
  email: string;
  role: UserRole;
};
