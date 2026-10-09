// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "./integration-fixtures";

afterAll(async () => { await pool.end(); });

describe("OVPSA fixture cleanup", () => {
  it("removes an owned draft batch without an import source and preserves unrelated batches", async () => {
    const studentNumber = "TEST-CLEAN-OVPSA";
    const cycle = 2097;
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,'2098-07-31',$2,$2)`,
      [cycle, TEST_REFERENCE_IDS.adminUser],
    );
    await insertTestStudent({ studentNumber, firstName: "Cleanup", lastName: "Owner", yearLevel: 3 });
    const batchIds = [randomUUID(), randomUUID()];
    const revisionId = randomUUID();
    const appointmentId = randomUUID();
    await transaction(async (client) => {
      await insertTestAcademicSnapshot(client, {
        studentNumber, academicYearStart: cycle,
        importName: "TEST-OVPSA-CLEANUP import", actor: TEST_REFERENCE_IDS.adminUser,
      });
      await client.query(
        `INSERT INTO ovpsa_first_year_batches
           (id,schedule_cycle_start,college_id,status,created_by,updated_by)
         SELECT id,$2,$3,'DRAFT',$4,$4 FROM UNNEST($1::uuid[]) fixture(id)`,
        [batchIds, cycle, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.adminUser],
      );
      await client.query(
        `INSERT INTO ovpsa_first_year_batch_revisions
           (id,batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by)
         VALUES ($1,$2,1,'DRAFT','2097-09-12','2097-09-19',$3)`,
        [revisionId, batchIds[0], TEST_REFERENCE_IDS.adminUser],
      );
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations
           (batch_id,revision_id,schedule_type,reservation_date,status,created_by)
         VALUES ($1,$2,'LABORATORY','2097-09-12','ACTIVE',$3) RETURNING id::text`,
        [batchIds[0], revisionId, TEST_REFERENCE_IDS.adminUser],
      );
      await client.query(
        `INSERT INTO appointments
           (id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
            schedule_pair_id,schedule_cycle_start,created_by,updated_by,scheduling_category,
            ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id)
         VALUES ($1,$2,$3,'LABORATORY','2097-09-12','PENDING',TRUE,
                 gen_random_uuid(),$4,$5,$5,'REGULAR',$6,$7,$8)`,
        [appointmentId, TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, cycle,
          TEST_REFERENCE_IDS.adminUser, batchIds[0], revisionId, reservation.rows[0].id],
      );
      await linkPublishedLaboratoryAppointments(client, [appointmentId]);
    });

    await cleanupTestFixtures(studentNumber, "TEST-OVPSA-CLEANUP batch%", "TEST-OVPSA-CLEANUP import%");

    expect((await pool.query("SELECT id::text FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])", [batchIds])).rows)
      .toEqual([{ id: batchIds[1] }]);
    expect((await pool.query("SELECT id FROM appointments WHERE id=$1", [appointmentId])).rowCount).toBe(0);
    expect((await pool.query("SELECT student_number FROM students WHERE student_number=$1", [studentNumber])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM schedule_import_groups WHERE import_name LIKE 'TEST-OVPSA-CLEANUP%'")).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN ('laboratory_checklist_events_immutable','laboratory_checklist_links_immutable',
                       'laboratory_checklist_identity_immutable','ovpsa_external_laboratory_verifications_immutable')
         AND tgenabled <> 'O'`,
    )).rows).toEqual([]);

    await pool.query("DELETE FROM ovpsa_first_year_batches WHERE id=$1", [batchIds[1]]);
    await pool.query("DELETE FROM academic_years WHERE start_year=$1", [cycle]);
  });
});
