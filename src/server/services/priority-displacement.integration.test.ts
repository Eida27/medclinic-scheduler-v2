// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { publishDisplacedRegularReplacements } from "./priority-displacement.service";

const studentPattern = "99-94%";
const importPattern = "TEST-DISPLACE-UNIFIED%";

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
  const pairId = randomUUID();
  const appointments = await pool.query<{
    id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
  }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by
     ) VALUES
       ($1,$3,'LABORATORY','2027-08-30','RESCHEDULED',FALSE,$4,2027,$5,$5),
       ($2,$3,'PHYSICAL_EXAM','2027-08-31','RESCHEDULED',FALSE,$4,2027,$5,$5)
     RETURNING id::text,schedule_type,appointment_date::text`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      pairId,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const laboratory = appointments.rows.find((appointment) => appointment.schedule_type === "LABORATORY")!;
  const physicalExam = appointments.rows.find((appointment) => appointment.schedule_type === "PHYSICAL_EXAM")!;
  return { importGroupId: importGroup.rows[0].id, pairId, laboratory, physicalExam };
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

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("priority displacement with the unified closure calendar", () => {
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
  });
});
