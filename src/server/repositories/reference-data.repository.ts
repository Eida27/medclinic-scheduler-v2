import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export type College = { id: string; code: string; name: string; isActive: boolean };
export type Program = { id: string; collegeId: string; collegeName: string; code: string; name: string; isActive: boolean };
type ReferenceType = "college" | "program";

export async function listColleges() {
  const result = await query<College>("SELECT id, code, name, is_active AS \"isActive\" FROM colleges ORDER BY name");
  return result.rows;
}

export async function listPrograms(collegeId?: string) {
  const result = await query<Program>(
    `SELECT p.id, p.college_id AS "collegeId", c.name AS "collegeName", p.code, p.name, p.is_active AS "isActive"
     FROM programs p JOIN colleges c ON c.id = p.college_id
     WHERE ($1::uuid IS NULL OR p.college_id = $1)
     ORDER BY c.name, p.name`,
    [collegeId || null],
  );
  return result.rows;
}

export async function createReference(
  type: ReferenceType,
  input: Record<string, unknown>,
) {
  if (type === "college") {
    return (await query(
      `INSERT INTO colleges (code, name) VALUES ($1, $2)
       RETURNING id, code, name, is_active AS "isActive"`,
      [input.code, input.name],
    )).rows[0];
  }
  return (await query(
    `INSERT INTO programs (college_id, code, name) VALUES ($1, $2, $3)
     RETURNING id, college_id AS "collegeId", code, name, is_active AS "isActive"`,
    [input.collegeId, input.code, input.name],
  )).rows[0];
}

export async function updateReference(
  type: ReferenceType,
  input: Record<string, unknown>,
) {
  if (type === "college") {
    return (await query(
      `UPDATE colleges SET code=$2, name=$3, is_active=$4 WHERE id=$1
       RETURNING id, code, name, is_active AS "isActive"`,
      [input.id, input.code, input.name, input.isActive],
    )).rows[0];
  }
  return (await query(
    `UPDATE programs SET college_id=$2, code=$3, name=$4, is_active=$5 WHERE id=$1
     RETURNING id, college_id AS "collegeId", code, name, is_active AS "isActive"`,
    [input.id, input.collegeId, input.code, input.name, input.isActive],
  )).rows[0];
}

export async function deleteReference(
  type: ReferenceType,
  id: string,
  client?: PoolClient,
) {
  const table = type === "college" ? "colleges" : "programs";
  const sql = `DELETE FROM ${table} WHERE id=$1 RETURNING id`;
  const result = client
    ? await client.query<{ id: string }>(sql, [id])
    : await query<{ id: string }>(sql, [id]);
  return result.rows[0];
}
