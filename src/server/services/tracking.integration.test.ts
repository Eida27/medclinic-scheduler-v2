// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { complianceReport } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";

const actorUserId = TEST_REFERENCE_IDS.clinicStaffUser;
const summaryStudentNumber = "TEST-SUMMARY-0001";

beforeAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%");
  await insertTestStudent({
    studentNumber: summaryStudentNumber,
    firstName: "Summary",
    lastName: "Student",
    yearLevel: 2,
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%");
  await pool.end();
});

describe("compliance tracking", () => {
  it("summarizes both services from the latest effective attendance appointments", async () => {
    const completedPhysical = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2045-12-25','COMPLETED',TRUE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.physicalExamClinic, summaryStudentNumber, actorUserId],
    );
    const pendingPhysical = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2045-12-20','PENDING',TRUE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.physicalExamClinic, summaryStudentNumber, actorUserId],
    );
    const completedLaboratory = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY','2045-12-19','COMPLETED',TRUE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, summaryStudentNumber, actorUserId],
    );
    await pool.query(
      `INSERT INTO exam_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ($1,$2,'COMPLETED','2045-12-20',$3)`,
      [summaryStudentNumber, pendingPhysical.rows[0].id, actorUserId],
    );
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, encoded_by
       ) VALUES ($1,$2,'REQUIRES_FOLLOW_UP','2045-12-19',$3)`,
      [summaryStudentNumber, completedLaboratory.rows[0].id, actorUserId],
    );

    const report = await complianceReport({
      search: summaryStudentNumber,
      page: 1,
      limit: 150,
      offset: 0,
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        studentNumber: summaryStudentNumber,
        appointmentStatus: "COMPLETED",
        physicalExamStatus: "COMPLETED",
        laboratoryStatus: "COMPLETED",
        physicalExamAppointmentId: completedPhysical.rows[0].id,
        physicalExamAppointmentDate: "2045-12-25",
        physicalExamAppointmentStatus: "COMPLETED",
        laboratoryAppointmentId: completedLaboratory.rows[0].id,
        laboratoryAppointmentDate: "2045-12-19",
        laboratoryAppointmentStatus: "COMPLETED",
        nextSchedule: null,
        overallStatus: "COMPLETE",
      }),
    ]);
    expect(report.summary).toEqual({
      totalStudents: 1,
      physicalCompleted: 1,
      laboratoryCompleted: 1,
      pendingAny: 0,
    });
    expect(completedPhysical.rows[0].id).not.toBe(pendingPhysical.rows[0].id);
  });

});
