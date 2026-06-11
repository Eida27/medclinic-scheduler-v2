import "server-only";
import { query } from "@/server/db/pool";

export type College = { id: string; code: string; name: string; isActive: boolean };
export type Program = { id: string; collegeId: string; collegeName: string; code: string; name: string; isActive: boolean };
export type PriorityGroup = { id: string; name: string; rankOrder: number; isActive: boolean };

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

export async function listPriorityGroups() {
  const result = await query<PriorityGroup>(
    `SELECT id, name, rank_order AS "rankOrder", is_active AS "isActive"
     FROM priority_groups ORDER BY rank_order`,
  );
  return result.rows;
}

export async function createReference(
  type: "college" | "program" | "priorityGroup",
  input: Record<string, unknown>,
) {
  if (type === "college") {
    return (await query(
      `INSERT INTO colleges (code, name) VALUES ($1, $2)
       RETURNING id, code, name, is_active AS "isActive"`,
      [input.code, input.name],
    )).rows[0];
  }
  if (type === "program") {
    return (await query(
      `INSERT INTO programs (college_id, code, name) VALUES ($1, $2, $3)
       RETURNING id, college_id AS "collegeId", code, name, is_active AS "isActive"`,
      [input.collegeId, input.code, input.name],
    )).rows[0];
  }
  return (await query(
    `INSERT INTO priority_groups (name, rank_order) VALUES ($1, $2)
     RETURNING id, name, rank_order AS "rankOrder", is_active AS "isActive"`,
    [input.name, input.rankOrder],
  )).rows[0];
}

export async function updateReference(
  type: "college" | "program" | "priorityGroup",
  input: Record<string, unknown>,
) {
  if (type === "college") {
    return (await query(
      `UPDATE colleges SET code=$2, name=$3, is_active=$4 WHERE id=$1
       RETURNING id, code, name, is_active AS "isActive"`,
      [input.id, input.code, input.name, input.isActive],
    )).rows[0];
  }
  if (type === "program") {
    return (await query(
      `UPDATE programs SET college_id=$2, code=$3, name=$4, is_active=$5 WHERE id=$1
       RETURNING id, college_id AS "collegeId", code, name, is_active AS "isActive"`,
      [input.id, input.collegeId, input.code, input.name, input.isActive],
    )).rows[0];
  }
  return (await query(
    `UPDATE priority_groups SET name=$2, rank_order=$3, is_active=$4 WHERE id=$1
     RETURNING id, name, rank_order AS "rankOrder", is_active AS "isActive"`,
    [input.id, input.name, input.rankOrder, input.isActive],
  )).rows[0];
}
