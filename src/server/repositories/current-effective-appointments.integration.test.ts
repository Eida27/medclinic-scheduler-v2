// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { getCurrentEffectiveAppointmentsForStudent } from "./current-effective-appointments.repository";

const studentNumberPattern = "TEST-CURRENT-%";
const batchNamePattern = "TEST current effective appointments%";

let replacementId: string;
let unresolvedPhysicalId: string;

beforeAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  await insertTestStudent({
    studentNumber: "TEST-CURRENT-0001",
    firstName: "Current",
    lastName: "Appointments",
    yearLevel: 4,
  });
  await insertTestStudent({
    studentNumber: "TEST-CURRENT-0002",
    firstName: "No",
    lastName: "Appointments",
    yearLevel: 4,
  });

  const oldCompleted = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by, created_at
     ) VALUES ($1,$2,'LABORATORY','2045-08-20','COMPLETED',TRUE,$3,$3,'2045-08-01T00:00:00Z')
     RETURNING id`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      "TEST-CURRENT-0001",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  await pool.query(
    `INSERT INTO laboratory_results (
       student_number, appointment_id, result_status, completed_at, encoded_by
     ) VALUES ($1,$2,'COMPLETED','2045-08-20',$3)`,
    [
      "TEST-CURRENT-0001",
      oldCompleted.rows[0].id,
      TEST_REFERENCE_IDS.clinicStaffUser,
    ],
  );

  const rescheduledLaboratory = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by, created_at
     ) VALUES ($1,$2,'LABORATORY','2046-08-13','RESCHEDULED',TRUE,$3,$3,'2046-08-01T00:00:00Z')
     RETURNING id`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      "TEST-CURRENT-0001",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const replacement = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, rescheduled_from, created_by, updated_by, created_at
     ) VALUES ($1,$2,'LABORATORY','2046-08-20','PENDING',TRUE,$3,$4,$4,'2046-08-02T00:00:00Z')
     RETURNING id`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      "TEST-CURRENT-0001",
      rescheduledLaboratory.rows[0].id,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  replacementId = replacement.rows[0].id;

  await pool.query(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by, created_at
     ) VALUES ($1,$2,'LABORATORY','2047-08-20','DRAFT',FALSE,$3,$3,'2047-08-01T00:00:00Z')`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      "TEST-CURRENT-0001",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );

  const unresolvedPhysical = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by, created_at
     ) VALUES ($1,$2,'PHYSICAL_EXAM','2046-08-27','RESCHEDULED',TRUE,$3,$3,'2046-08-03T00:00:00Z')
     RETURNING id`,
    [
      TEST_REFERENCE_IDS.physicalExamClinic,
      "TEST-CURRENT-0001",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  unresolvedPhysicalId = unresolvedPhysical.rows[0].id;
});

afterAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  await pool.end();
});

describe("current effective appointments", () => {
  it("resolves the newest published leaf for each service", async () => {
    const resolved = await getCurrentEffectiveAppointmentsForStudent("TEST-CURRENT-0001");

    expect(resolved.laboratory).toMatchObject({
      id: replacementId,
      scheduleType: "LABORATORY",
      appointmentDate: "2046-08-20",
      status: "PENDING",
    });
    expect(resolved.physicalExam).toMatchObject({
      id: unresolvedPhysicalId,
      scheduleType: "PHYSICAL_EXAM",
      status: "RESCHEDULED",
    });
  });

  it("returns null services for a student with no appointments", async () => {
    await expect(getCurrentEffectiveAppointmentsForStudent("TEST-CURRENT-0002"))
      .resolves.toEqual({ laboratory: null, physicalExam: null });
  });
});
