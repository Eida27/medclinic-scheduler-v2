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
  clinicId: string | null;
  clinicCode: string | null;
  clinicName: string | null;
  isActive: boolean;
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
  is_active: boolean;
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
    isActive: row.is_active,
  };
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await query<UserRow>(
    `SELECT u.id, u.full_name, u.email, u.password_hash, u.role, u.clinic_id,
            c.code AS clinic_code, c.name AS clinic_name, u.is_active
     FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id WHERE u.email = LOWER($1)`,
    [email],
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string, client?: PoolClient): Promise<UserRecord | null> {
  const sql = `SELECT u.id, u.full_name, u.email, u.password_hash, u.role, u.clinic_id,
                      c.code AS clinic_code, c.name AS clinic_name, u.is_active
               FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id WHERE u.id = $1`;
  const result = client ? await client.query<UserRow>(sql, [id]) : await query<UserRow>(sql, [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function listUsers() {
  const result = await query<{
    id: string; full_name: string; email: string; role: UserRole; clinic_code: string | null; clinic_name: string | null; is_active: boolean; created_at: Date;
  }>(`SELECT u.id, u.full_name, u.email, u.role, c.code AS clinic_code, c.name AS clinic_name, u.is_active, u.created_at
      FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id ORDER BY u.full_name`);
  return result.rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    clinicCode: row.clinic_code,
    clinicName: row.clinic_name,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function insertUser(input: { fullName: string; email: string; passwordHash: string; role: UserRole; clinicCode?: string | null }) {
  const result = await query<{ id: string }>(
    `INSERT INTO users (full_name, email, password_hash, role, clinic_id)
     VALUES ($1, LOWER($2), $3, $4, (SELECT id FROM clinics WHERE code=$5)) RETURNING id`,
    [input.fullName, input.email, input.passwordHash, input.role, input.clinicCode ?? null],
  );
  return findUserById(result.rows[0].id);
}

export async function updateUserRecord(input: { id: string; fullName: string; email: string; role: UserRole; clinicCode?: string | null; isActive: boolean; passwordHash?: string }) {
  const result = await query<{ id: string }>(
    `UPDATE users SET full_name=$2, email=LOWER($3), role=$4,
       clinic_id=(SELECT id FROM clinics WHERE code=$5), is_active=$6,
       password_hash=COALESCE($7, password_hash)
     WHERE id=$1 RETURNING id`,
    [input.id, input.fullName, input.email, input.role, input.clinicCode ?? null, input.isActive, input.passwordHash ?? null],
  );
  return result.rows[0] ? findUserById(result.rows[0].id) : null;
}
