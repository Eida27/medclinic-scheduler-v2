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
const studentNumber = "TEST-TRACK-0001";
const draftPriorityStudentNumber = "TEST-TRACK-0004";
const summaryStudentNumber = "TEST-SUMMARY-0001";

beforeAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%");
  await insertTestStudent({
    studentNumber,
    firstName: "Tracking",
    middleName: "maria angela",
    lastName: "Fixture",
    suffix: "III",
    yearLevel: 2,
  });
  await insertTestStudent({
    studentNumber: draftPriorityStudentNumber,
    firstName: "Hidden",
    lastName: "Priority",
    yearLevel: 2,
  });
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

  it("keeps generated appointments out of compliance until publication", async () => {
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY','2026-07-15','DRAFT',FALSE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, actorUserId],
    );
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, remarks, encoded_by
       ) VALUES ($1,$2,'COMPLETED','2026-07-15','Must remain private while draft',$3)`,
      [studentNumber, appointment.rows[0].id, actorUserId],
    );

    const beforePublication = await complianceReport({
      search: studentNumber,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(beforePublication.items[0]).toMatchObject({
      studentNumber,
      appointmentStatus: "UNSCHEDULED",
      laboratoryStatus: "UNSCHEDULED",
    });

    const draftFilter = await complianceReport({
      search: studentNumber,
      appointmentStatus: "DRAFT",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(draftFilter.items).toEqual([]);

    await pool.query(
      "UPDATE appointments SET status='PENDING', is_published=TRUE WHERE id=$1",
      [appointment.rows[0].id],
    );

    const afterPublication = await complianceReport({
      search: studentNumber,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(afterPublication.items[0]).toMatchObject({
      studentNumber,
      appointmentStatus: "PENDING",
      laboratoryStatus: "PENDING",
    });
  });

  it("keeps draft-import priority membership out of compliance until publication", async () => {
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO schedule_batches (clinic_id, batch_name, status, created_by)
       VALUES ($1,'TEST tracking fixture priority draft','GENERATED',$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, actorUserId],
    );
    const item = await pool.query<{ id: string }>(
      `INSERT INTO coordinator_schedule_items (
         batch_id, clinic_id, student_number, schedule_type,
         priority_group_id, target_date, status
       ) VALUES ($1,$2,$3,'LABORATORY',$4,'2045-12-18','SCHEDULED')
       RETURNING id`,
      [
        batch.rows[0].id,
        TEST_REFERENCE_IDS.laboratoryClinic,
        draftPriorityStudentNumber,
        TEST_REFERENCE_IDS.regularPriority,
      ],
    );
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         batch_id, schedule_item_id, clinic_id, student_number, schedule_type,
         appointment_date, status, is_published, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,'LABORATORY','2045-12-18','DRAFT',FALSE,$5,$5)
       RETURNING id`,
      [
        batch.rows[0].id,
        item.rows[0].id,
        TEST_REFERENCE_IDS.laboratoryClinic,
        draftPriorityStudentNumber,
        actorUserId,
      ],
    );

    const hidden = await complianceReport({
      search: draftPriorityStudentNumber,
      priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(hidden.items).toEqual([]);

    await pool.query(
      "UPDATE appointments SET status='PENDING', is_published=TRUE WHERE id=$1",
      [appointment.rows[0].id],
    );

    const published = await complianceReport({
      search: draftPriorityStudentNumber,
      priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(published.items).toEqual([
      expect.objectContaining({ studentNumber: draftPriorityStudentNumber }),
    ]);
  });
});
