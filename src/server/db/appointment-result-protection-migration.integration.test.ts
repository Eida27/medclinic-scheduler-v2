// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pool } from "./pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

const studentNumber = "MIG-015-LOCK";
const migrationReplayLockKey = 15021023;
afterAll(() => pool.end());

describe("appointment result protection migration", () => {
  it("applies to clean and populated schemas while preserving existing appointment locks", async () => {
    const migration = await readFile(
      join(
        process.cwd(),
        "database/migrations/015_appointment_result_protection.sql",
      ),
      "utf8",
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        migrationReplayLockKey,
      ]);
      await expect(client.query(migration)).resolves.toBeDefined();

      await client.query(
        `INSERT INTO students (
           student_number,first_name,middle_name,last_name,suffix,
           college_id,program_id,year_level,date_of_birth
         ) VALUES ($1,$2,NULL,$3,NULL,$4,$5,$6,NULL)`,
        [
          studentNumber,
          "Migration",
          "Protection",
          TEST_REFERENCE_IDS.college,
          TEST_REFERENCE_IDS.program,
          4,
        ],
      );
      const pairId = randomUUID();
      const appointment = await client.query<{ id: string }>(
        `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES ($1,$2,'LABORATORY','2049-08-12','PENDING',TRUE,$3,2049,
                 TRUE,$4,'2049-08-01T00:00:00.000Z','Preserve this lock')
       RETURNING id::text`,
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          studentNumber,
          pairId,
          TEST_REFERENCE_IDS.adminUser,
        ],
      );
      const closure = await client.query<{ id: string }>(
        `INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ('2049-08-12','2049-08-12','CLOSURE','MIG-015 fixture',$1,$2)
       RETURNING id::text`,
        [TEST_REFERENCE_IDS.adminUser, randomUUID()],
      );
      await client.query(
        `INSERT INTO clinic_closure_manual_cases (
         student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,reason_code,reason_message
       ) VALUES ($1,$2,$3,2049,$4,'APPOINTMENT_MANUALLY_LOCKED','Existing case')`,
        [studentNumber, closure.rows[0].id, pairId, appointment.rows[0].id],
      );

      await expect(client.query(migration)).resolves.toBeDefined();

      await expect(
        client.query(
          `INSERT INTO clinic_closure_manual_cases (
           student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
           affected_laboratory_appointment_id,reason_code,reason_message
         ) VALUES ($1,$2,$3,2049,$4,'DRAFT_RESULT_FILES_EXIST','Draft files exist')`,
          [studentNumber, closure.rows[0].id, pairId, appointment.rows[0].id],
        ),
      ).resolves.toBeDefined();
      const lock = await client.query<{
        is_manually_locked: boolean;
        locked_by: string;
        locked_at: Date;
        lock_reason: string;
      }>(
        `SELECT is_manually_locked,locked_by::text,locked_at,lock_reason
           FROM appointments WHERE id=$1`,
        [appointment.rows[0].id],
      );
      expect(
        lock.rows.map((row) => ({
          ...row,
          locked_at: row.locked_at.toISOString(),
        })),
      ).toEqual([
        {
          is_manually_locked: true,
          locked_by: TEST_REFERENCE_IDS.adminUser,
          locked_at: "2049-08-01T00:00:00.000Z",
          lock_reason: "Preserve this lock",
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
