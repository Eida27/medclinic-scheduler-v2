// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  lockEligibleRegularPairs,
  lockEligibleRegularPhysicalExams,
} from "@/server/repositories/priority-displacement.repository";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { publishDisplacedRegularReplacements } from "./priority-displacement.service";

const studentPattern = "99-94%";
const importPattern = "TEST-DISPLACE-UNIFIED%";
let capacityFixture: CapacityFixtureLock | null = null;

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-DISPLACE%')`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-DISPLACE%'");
}

async function fixture(studentNumber: string) {
  await insertTestStudent({
    studentNumber,
    firstName: "Priority",
    lastName: "Displacement",
    yearLevel: 4,
  });
  const importGroup = await pool.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       import_name,source_filename,total_rows,created_by,student_category,academic_year_start
     ) VALUES ($1,$1,1,$2,'REGULAR',2027) RETURNING id::text`,
    [`${importPattern.replace("%", "")}-${studentNumber}`, TEST_REFERENCE_IDS.adminUser],
  );
  const batches = await pool.query<{ id: string; clinicId: string }>(
    `INSERT INTO schedule_batches (
       clinic_id,batch_name,status,created_by,import_group_id
     ) VALUES
       ($1,$3,'PUBLISHED',$4,$5),
       ($2,$3,'PUBLISHED',$4,$5)
     RETURNING id::text,clinic_id::text AS "clinicId"`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      `${importPattern.replace("%", "")}-${studentNumber}`,
      TEST_REFERENCE_IDS.adminUser,
      importGroup.rows[0].id,
    ],
  );
  const laboratoryBatchId = batches.rows.find(
    (batch) => batch.clinicId === TEST_REFERENCE_IDS.laboratoryClinic,
  )!.id;
  const physicalExamBatchId = batches.rows.find(
    (batch) => batch.clinicId === TEST_REFERENCE_IDS.physicalExamClinic,
  )!.id;
  const pairId = randomUUID();
  const appointments = await pool.query<{
    id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
  }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,batch_id,created_by,updated_by
     ) VALUES
       ($1,$3,'LABORATORY','2027-08-30','RESCHEDULED',FALSE,$4,2027,$5,$7,$7),
       ($2,$3,'PHYSICAL_EXAM','2027-08-31','RESCHEDULED',FALSE,$4,2027,$6,$7,$7)
     RETURNING id::text,schedule_type,appointment_date::text`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      pairId,
      laboratoryBatchId,
      physicalExamBatchId,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const laboratory = appointments.rows.find((appointment) => appointment.schedule_type === "LABORATORY")!;
  const physicalExam = appointments.rows.find((appointment) => appointment.schedule_type === "PHYSICAL_EXAM")!;
  return { importGroupId: importGroup.rows[0].id, pairId, laboratory, physicalExam };
}

async function eligibleFixture(studentNumber: string) {
  const created = await fixture(studentNumber);
  await pool.query(
    `UPDATE appointments
        SET status='PENDING', is_published=TRUE
      WHERE id=ANY($1::uuid[])`,
    [[created.laboratory.id, created.physicalExam.id]],
  );
  return created;
}

async function addActiveDraftFile(appointmentId: string, studentNumber: string) {
  const submission = await pool.query<{ id: string }>(
    `INSERT INTO student_result_submissions (appointment_id,student_number,result_type)
     SELECT id,student_number,schedule_type FROM appointments WHERE id=$1
     RETURNING id::text`,
    [appointmentId],
  );
  await pool.query(
    `INSERT INTO student_result_files (
       submission_id,storage_key,original_filename,detected_mime_type,
       extension,byte_size,checksum_sha256
     ) VALUES ($1,$2,$3,'application/pdf','pdf',32,$4)`,
    [submission.rows[0].id, `priority/${studentNumber}.pdf`, `${studentNumber}.pdf`, "c".repeat(64)],
  );
}

async function insertUnifiedDate(date: string, reopened: boolean) {
  await pool.query(
    `WITH closure AS (
       INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ($1,$1,'CLOSURE','TEST-DISPLACE unified block',$2,gen_random_uuid())
       RETURNING id
     )
     INSERT INTO clinic_unavailable_dates (
       closure_group_id,blocked_date,reopened_at,reopened_by,reopening_batch_id
     ) SELECT id,$1,
              CASE WHEN $3 THEN NOW() END,
              CASE WHEN $3 THEN $2::uuid END,
              CASE WHEN $3 THEN gen_random_uuid() END
         FROM closure`,
    [date, TEST_REFERENCE_IDS.adminUser, reopened],
  );
}

async function publish(studentNumber: string) {
  const created = await fixture(studentNumber);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await publishDisplacedRegularReplacements({
      candidates: [{
        displacementType: "PAIR",
        studentNumber,
        schedulePairId: created.pairId,
        laboratoryAppointmentId: created.laboratory.id,
        laboratoryDate: created.laboratory.appointment_date,
        physicalExamAppointmentId: created.physicalExam.id,
        physicalExamDate: created.physicalExam.appointment_date,
        acceptedAt: new Date("2027-07-01T00:00:00.000Z"),
        sourceRowOrder: 0,
        scheduleCycleStart: 2027,
      }],
      sourceImportGroupId: created.importGroupId,
      actorUserId: TEST_REFERENCE_IDS.adminUser,
      replacementWindowStart: "2027-09-01",
      searchEndDate: "2027-09-30",
    }, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
});
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, cleanup);
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("priority displacement with the unified closure calendar", () => {
  it("excludes a pair when either appointment has an active draft result file", async () => {
    const created = await eligibleFixture("99-9403-03");
    await addActiveDraftFile(created.laboratory.id, "99-9403-03");

    await expect(transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-08-01",
      windowEnd: "2027-09-30",
      limit: 10,
    }))).resolves.toEqual([]);
  });

  it("excludes a Physical-only candidate with an active draft result file", async () => {
    const created = await eligibleFixture("99-9404-04");
    await addActiveDraftFile(created.physicalExam.id, "99-9404-04");

    await expect(transaction((client) => lockEligibleRegularPhysicalExams(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-08-01",
      windowEnd: "2027-09-30",
      limit: 10,
    }))).resolves.toEqual([]);
  });

  it("skips the same active blocked dates for both replacement services", async () => {
    await insertUnifiedDate("2027-09-01", false);
    await insertUnifiedDate("2027-09-02", false);
    await expect(publish("99-9401-01")).resolves.toEqual([
      expect.objectContaining({ laboratoryDate: "2027-09-03", physicalExamDate: "2027-09-06" }),
    ]);
  });

  it("allows a reopened date to be allocated again", async () => {
    await insertUnifiedDate("2027-09-01", true);
    await expect(publish("99-9402-02")).resolves.toEqual([
      expect.objectContaining({ laboratoryDate: "2027-09-01", physicalExamDate: "2027-09-02" }),
    ]);
    const notification = await pool.query(
      `SELECT notification_type,event_key,metadata->>'sourceType' AS source_type,
              metadata->>'sourceId' AS source_id,message
         FROM student_portal_notifications WHERE student_number='99-9402-02'`,
    );
    expect(notification.rows).toEqual([{
      notification_type: "SCHEDULE_PRIORITY_DISPLACEMENT",
      event_key: expect.stringMatching(/^schedule:event:[0-9a-f-]+:99-9402-02$/),
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      source_id: expect.any(String),
      message: expect.stringContaining("2027-09-01 at KABALAKA Clinic"),
    }]);
  });
});
