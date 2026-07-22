// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertNumberedTestStudents,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";

const studentNumberPattern = "TEST-DASH-%";
const counterStudentNumberPrefix = "TEST-DASH-COUNT-";
const counterStudentNumbers = Array.from(
  { length: 5 },
  (_, index) => `${counterStudentNumberPrefix}${String(index + 1).padStart(4, "0")}`,
);
const capacityStudentNumberPrefix = "TEST-DASH-CAP-";
const capacityStudentNumberPattern = `${capacityStudentNumberPrefix}%`;
const batchNamePattern = "TEST dashboard metrics%";
const appointmentDate = "2042-06-01";

beforeAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  const capacity = await pool.query<{ max_daily_capacity: number }>(
    `SELECT max_daily_capacity
       FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
    [TEST_REFERENCE_IDS.laboratoryClinic],
  );
  await insertNumberedTestStudents(counterStudentNumberPrefix, counterStudentNumbers.length);
  await insertNumberedTestStudents(
    capacityStudentNumberPrefix,
    Number(capacity.rows[0].max_daily_capacity) + 1,
  );
});

afterAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  await pool.end();
});

describe("dashboard metrics publication boundaries", () => {
  it("does not expose administrator-only unpublished batch state", async () => {
    await expect(dashboardMetrics()).resolves.not.toHaveProperty("unpublishedBatches");
  });

  it("excludes every unpublished appointment-derived counter", async () => {
    const baseline = await dashboardMetrics();
    const appointments = await pool.query<{ id: string; student_number: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       )
       SELECT clinic_id::uuid, student_number, schedule_type, $5::date,
              status, FALSE, $6, $6
         FROM UNNEST(
           $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[]
         ) AS fixture(student_number, schedule_type, status, clinic_id)
       RETURNING id, student_number`,
      [
        counterStudentNumbers,
        ["LABORATORY", "LABORATORY", "LABORATORY", "PHYSICAL_EXAM", "LABORATORY"],
        ["PENDING", "NO_SHOW", "RESCHEDULED", "COMPLETED", "COMPLETED"],
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.physicalExamClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
        ],
        "2042-06-02",
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    const appointmentId = (studentNumber: string) =>
      appointments.rows.find((appointment) => appointment.student_number === studentNumber)?.id;

    await pool.query(
      `INSERT INTO exam_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ($1,$2,'COMPLETED',$3,$4)`,
      [
        counterStudentNumbers[3],
        appointmentId(counterStudentNumbers[3]),
        "2042-06-02",
        TEST_REFERENCE_IDS.clinicStaffUser,
      ],
    );
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ($1,$2,'COMPLETED',$3,$4)`,
      [
        counterStudentNumbers[4],
        appointmentId(counterStudentNumbers[4]),
        "2042-06-02",
        TEST_REFERENCE_IDS.clinicStaffUser,
      ],
    );

    await expect(dashboardMetrics()).resolves.toMatchObject({
      pendingAppointments: baseline.pendingAppointments,
      completedPhysicalExams: baseline.completedPhysicalExams,
      completedLaboratory: baseline.completedLaboratory,
      noShows: baseline.noShows,
      rescheduled: baseline.rescheduled,
    });

    await pool.query(
      `UPDATE appointments
          SET is_published=TRUE
        WHERE student_number = ANY($1::varchar[])`,
      [counterStudentNumbers],
    );

    await expect(dashboardMetrics()).resolves.toMatchObject({
      pendingAppointments: baseline.pendingAppointments + 1,
      completedPhysicalExams: baseline.completedPhysicalExams + 1,
      completedLaboratory: baseline.completedLaboratory + 1,
      noShows: baseline.noShows + 1,
      rescheduled: baseline.rescheduled + 1,
    });
  });

  it("counts over-capacity dates only after appointments are published", async () => {
    const baseline = (await dashboardMetrics()).capacityConflicts;
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       )
       SELECT $1, student_number, 'LABORATORY', $2::date,
              'DRAFT', FALSE, $3, $3
         FROM students
        WHERE student_number LIKE $4`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        appointmentDate,
        TEST_REFERENCE_IDS.adminUser,
        capacityStudentNumberPattern,
      ],
    );

    await expect(dashboardMetrics()).resolves.toMatchObject({
      capacityConflicts: baseline,
    });

    await pool.query(
      `UPDATE appointments
          SET status='PENDING', is_published=TRUE
        WHERE student_number LIKE $1`,
      [capacityStudentNumberPattern],
    );

    await expect(dashboardMetrics()).resolves.toMatchObject({
      capacityConflicts: baseline + 1,
    });
  });
});
