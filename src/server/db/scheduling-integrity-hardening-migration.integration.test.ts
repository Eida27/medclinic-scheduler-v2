// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { cleanupTestFixtures, insertTestAcademicSnapshot, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { pool, transaction } from "./pool";

const studentNumber = "MIG-025-CASE";
const closureReason = "MIG-025 fixture";
let createdYear = false;

async function cleanup() {
  await pool.query(
    "DELETE FROM appointment_reschedule_events WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "DELETE FROM clinic_closure_manual_cases WHERE student_number=$1",
    [studentNumber],
  );
  await cleanupTestFixtures("MIG-025-%", "MIG-025%", "MIG-025%");
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason=$1", [closureReason]);
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2049");
  await pool.end();
});

describe("scheduling integrity hardening migration", () => {
  it("generalizes Manual Resolution cases without changing existing closure cases", async () => {
    await insertTestStudent({
      studentNumber,
      firstName: "Migration",
      lastName: "Integrity",
      yearLevel: 4,
    });
    const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
      VALUES (2049,'2050-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser]);
    createdYear = Boolean(year.rowCount);
    const pairId = randomUUID();
    const appointment = await transaction(async (client) => {
      await insertTestAcademicSnapshot(client, {
        studentNumber, academicYearStart: 2049,
        importName: "MIG-025 fixture provenance", actor: TEST_REFERENCE_IDS.adminUser,
      });
      const inserted = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category
       ) VALUES ($1,$2,'LABORATORY','2049-08-12','PENDING',TRUE,$3,2049,'REGULAR')
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId],
      );
      await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
      return inserted;
    });
    const closure = await pool.query<{ id: string }>(
      `INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ('2049-08-12','2049-08-12','CLOSURE',$1,$2,$3)
       RETURNING id::text`,
      [closureReason, TEST_REFERENCE_IDS.adminUser, randomUUID()],
    );
    const existingCase = await pool.query<{ id: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,reason_code,reason_message
       ) VALUES ($1,$2,$3,2049,$4,'NO_REPLACEMENT_CAPACITY','Existing closure case')
       RETURNING id::text`,
      [studentNumber, closure.rows[0].id, pairId, appointment.rows[0].id],
    );

    const migration = await readFile(
      join(process.cwd(), "database/migrations/025_scheduling_integrity_hardening.sql"),
      "utf8",
    );
    await expect(pool.query(migration)).resolves.toBeDefined();

    await expect(pool.query(
      "SELECT case_source FROM clinic_closure_manual_cases WHERE id=$1",
      [existingCase.rows[0].id],
    )).resolves.toMatchObject({ rows: [{ case_source: "CLINIC_CLOSURE" }] });

    const automaticCase = await pool.query<{ id: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,case_source,closure_group_id,schedule_pair_id,
         schedule_cycle_start,affected_laboratory_appointment_id,
         reason_code,reason_message,policy_metadata
       ) VALUES ($1,'AUTOMATIC_DISPLACEMENT',NULL,$2,2049,$3,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE','No same-cycle replacement',$4::jsonb)
       RETURNING id::text`,
      [
        studentNumber,
        pairId,
        appointment.rows[0].id,
        JSON.stringify({ sourceImportGroupId: randomUUID() }),
      ],
    );
    await expect(pool.query(
      `INSERT INTO appointment_reschedule_events (
         student_number,schedule_pair_id,cause,old_laboratory_appointment_id,
         actor_user_id,schedule_cycle_start,strategy,outcome,manual_case_id,
         policy_reason_code,policy_metadata
       ) VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,2049,
                 'MANUAL_RESOLUTION_REQUIRED','AWAITING_RESCHEDULE',$5,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',$6::jsonb)`,
      [
        studentNumber,
        pairId,
        appointment.rows[0].id,
        TEST_REFERENCE_IDS.adminUser,
        automaticCase.rows[0].id,
        JSON.stringify({ originAppointmentIds: [appointment.rows[0].id] }),
      ],
    )).resolves.toBeDefined();

    await expect(pool.query(
      `UPDATE clinic_closure_manual_cases
          SET status='RESOLVED',resolved_at=clock_timestamp(),resolved_by=$2,
              resolution_action='RESTORE_ORIGINAL',
              resolution_details='{"restorationAction":"RESTORE_ORIGINAL"}'::jsonb
        WHERE id=$1`,
      [existingCase.rows[0].id, TEST_REFERENCE_IDS.adminUser],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `SELECT status,resolution_action,resolution_details->>'restorationAction' AS detail_action
         FROM clinic_closure_manual_cases WHERE id=$1`,
      [existingCase.rows[0].id],
    )).resolves.toMatchObject({ rows: [{
      status: "RESOLVED",
      resolution_action: "RESTORE_ORIGINAL",
      detail_action: "RESTORE_ORIGINAL",
    }] });
    await expect(pool.query(
      `UPDATE clinic_closure_manual_cases
          SET resolution_action='RESTORE_ORIGINAL'
        WHERE id=$1`,
      [automaticCase.rows[0].id],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,case_source,closure_group_id,schedule_cycle_start,
         reason_code,reason_message
       ) VALUES ($1,'CLINIC_CLOSURE',NULL,2049,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE','Invalid closure case')`,
      [studentNumber],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
