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

export async function listUsers() {
  const result = await query<{
    id: string; full_name: string; email: string; role: UserRole; is_active: boolean; created_at: Date;
  }>("SELECT id, full_name, email, role, is_active, created_at FROM users ORDER BY full_name");
  return result.rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function insertUser(input: { fullName: string; email: string; passwordHash: string; role: UserRole }) {
  const result = await query<{ id: string }>(
    `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, LOWER($2), $3, $4) RETURNING id`,
    [input.fullName, input.email, input.passwordHash, input.role],
  );
  return findUserById(result.rows[0].id);
}

export async function updateUserRecord(input: { id: string; fullName: string; email: string; role: UserRole; isActive: boolean; passwordHash?: string }) {
  const result = await query<{ id: string }>(
    `UPDATE users SET full_name=$2, email=LOWER($3), role=$4, is_active=$5,
       password_hash=COALESCE($6, password_hash)
     WHERE id=$1 RETURNING id`,
    [input.id, input.fullName, input.email, input.role, input.isActive, input.passwordHash ?? null],
  );
  return result.rows[0] ? findUserById(result.rows[0].id) : null;
}
