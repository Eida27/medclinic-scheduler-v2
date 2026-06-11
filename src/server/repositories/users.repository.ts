import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
import type { UserRole } from "@/types/roles";

export type UserRecord = {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
};

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
};

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active,
  };
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `SELECT id, full_name, email, password_hash, role, is_active
     FROM users WHERE email = LOWER($1)`,
    [email],
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string, client?: PoolClient): Promise<UserRecord | null> {
  const sql = `SELECT id, full_name, email, password_hash, role, is_active
               FROM users WHERE id = $1`;
  const result = client ? await client.query<UserRow>(sql, [id]) : await query<UserRow>(sql, [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}
