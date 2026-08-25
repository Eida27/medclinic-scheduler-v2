import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
import type { UserRole } from "@/types/roles";
import type { StaffAccountStatus } from "@/server/security/staff-security";

export type UserRecord = {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  clinicId: string | null;
  clinicCode: string | null;
  clinicName: string | null;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  credentialVersion: number;
  status: StaffAccountStatus;
};

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  clinic_id: string | null;
  clinic_code: string | null;
  clinic_name: string | null;
  email_verified_at: Date | null;
  must_change_password: boolean;
  credential_version: number;
};

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    clinicId: row.clinic_id,
    clinicCode: row.clinic_code,
    clinicName: row.clinic_name,
    emailVerifiedAt: row.email_verified_at,
    mustChangePassword: row.must_change_password,
    credentialVersion: row.credential_version,
    status: row.email_verified_at
      ? row.must_change_password ? "PASSWORD_CHANGE_REQUIRED" : "ACTIVE"
      : "PENDING_VERIFICATION",
  };
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `SELECT u.id,u.full_name,u.email,u.password_hash,u.role,u.clinic_id,
            c.code AS clinic_code,c.name AS clinic_name,u.email_verified_at,
            u.must_change_password,u.credential_version
       FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id
      WHERE u.email=LOWER(BTRIM($1)) AND u.deleted_at IS NULL`,
    [email],
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string, client?: PoolClient): Promise<UserRecord | null> {
  const sql = `SELECT u.id,u.full_name,u.email,u.password_hash,u.role,u.clinic_id,
                      c.code AS clinic_code,c.name AS clinic_name,u.email_verified_at,
                      u.must_change_password,u.credential_version
                 FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id
                WHERE u.id=$1 AND u.deleted_at IS NULL`;
  const result = client ? await client.query<UserRow>(sql, [id]) : await query<UserRow>(sql, [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}
