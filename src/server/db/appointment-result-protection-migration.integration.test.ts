// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { pool } from "./pool";
import { insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

const studentNumber = "MIG-015-LOCK";
const latestSchedulingMigrationPath = join(
  process.cwd(),
  "database/migrations/025_scheduling_integrity_hardening.sql",
);

async function cleanup() {
  await pool.query(
    "DELETE FROM audit_logs WHERE metadata->>'studentNumber'=$1",
    [studentNumber],
  );
  await pool.query(
    "DELETE FROM clinic_closure_manual_cases WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "DELETE FROM clinic_unavailable_dates WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason='MIG-015 fixture')",
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason='MIG-015 fixture'");
  await pool.query("DELETE FROM appointments WHERE student_number=$1", [studentNumber]);
  await pool.query("DELETE FROM students WHERE student_number=$1", [studentNumber]);
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  try {
    await pool.query(await readFile(latestSchedulingMigrationPath, "utf8"));
  } finally {
    await pool.end();
  }
});

describe("appointment result protection migration", () => {
  it("applies to clean and populated schemas while preserving existing appointment locks", async () => {
    const migration = await readFile(
      join(process.cwd(), "database/migrations/015_appointment_result_protection.sql"),
      "utf8",
    );

    await expect(pool.query(migration)).resolves.toBeDefined();

    await insertTestStudent({
      studentNumber,
      firstName: "Migration",
      lastName: "Protection",
      yearLevel: 4,
    });
    const pairId = randomUUID();
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES ($1,$2,'LABORATORY','2049-08-12','PENDING',TRUE,$3,2049,
                 TRUE,$4,'2049-08-01T00:00:00.000Z','Preserve this lock')
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId, TEST_REFERENCE_IDS.adminUser],
    );
    const closure = await pool.query<{ id: string }>(
      `INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ('2049-08-12','2049-08-12','CLOSURE','MIG-015 fixture',$1,$2)
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.adminUser, randomUUID()],
    );
    await pool.query(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,reason_code,reason_message
       ) VALUES ($1,$2,$3,2049,$4,'APPOINTMENT_MANUALLY_LOCKED','Existing case')`,
      [studentNumber, closure.rows[0].id, pairId, appointment.rows[0].id],
    );

    await expect(pool.query(migration)).resolves.toBeDefined();

    await expect(pool.query(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,reason_code,reason_message
       ) VALUES ($1,$2,$3,2049,$4,'DRAFT_RESULT_FILES_EXIST','Draft files exist')`,
      [studentNumber, closure.rows[0].id, pairId, appointment.rows[0].id],
    )).resolves.toBeDefined();
    const lock = await pool.query<{
      is_manually_locked: boolean;
      locked_by: string;
      locked_at: Date;
      lock_reason: string;
    }>(
      `SELECT is_manually_locked,locked_by::text,locked_at,lock_reason
         FROM appointments WHERE id=$1`,
      [appointment.rows[0].id],
    );
    expect(lock.rows.map((row) => ({ ...row, locked_at: row.locked_at.toISOString() }))).toEqual([{
      is_manually_locked: true,
      locked_by: TEST_REFERENCE_IDS.adminUser,
      locked_at: "2049-08-01T00:00:00.000Z",
      lock_reason: "Preserve this lock",
    }]);
  });
});
