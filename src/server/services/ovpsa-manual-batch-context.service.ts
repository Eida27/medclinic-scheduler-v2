import "server-only";

import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import type { SessionUser } from "@/types/roles";

export async function getOvpsaManualBatchContext(batchId: string, actor: SessionUser) {
  if (actor.role !== "ADMIN") throw new AppError("FORBIDDEN", "You do not have permission to view this batch.", 403);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId))
    throw new AppError("INVALID_BATCH_ID", "Choose a valid OVPSA batch.", 400);
  return transaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const batch = (await client.query<{ optimistic_token: string; status: string }>(
      `SELECT optimistic_token::text,status FROM ovpsa_first_year_batches WHERE id=$1`, [batchId],
    )).rows[0];
    if (!batch) throw new AppError("OVPSA_BATCH_NOT_FOUND", "First Year batch not found.", 404);
    if (batch.status !== "RESCHEDULE_REQUIRED") throw new AppError("OVPSA_BATCH_RECOVERY_NOT_REQUIRED", "This batch is not awaiting coordinated recovery.", 409);
    const result = await client.query<{ case_id: string; optimistic_token: string; student_number: string; student_name: string }>(
      `SELECT manual.id::text AS case_id,manual.optimistic_token::text,manual.student_number,
              ${studentDisplayNameSql("student")} AS student_name
         FROM clinic_closure_manual_cases manual
         JOIN students student ON student.student_number=manual.student_number
        WHERE manual.status='OPEN' AND manual.reason_code='OVPSA_LABORATORY_PROTECTED'
          AND manual.policy_metadata->>'ovpsaBatchId'=$1
        ORDER BY manual.id LIMIT 101`, [batchId],
    );
    if (!result.rows.length || result.rows.length > 100)
      throw new AppError("OVPSA_BATCH_MEMBERSHIP_INVALID", "The linked OVPSA membership is missing or exceeds the import limit.", 409);
    return { batchId, optimisticToken: batch.optimistic_token,
      cases: result.rows.map((row) => ({ caseId: row.case_id, expectedOptimisticToken: row.optimistic_token,
        studentNumber: row.student_number, studentName: row.student_name })) };
  });
}
