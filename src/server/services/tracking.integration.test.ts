// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { complianceReport, resultsForStudent } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { recordResult, resultSchema } from "./tracking.service";

const actorUserId = TEST_REFERENCE_IDS.clinicStaffUser;
const studentNumber = "TEST-TRACK-0001";
const draftHistoryStudentNumber = "TEST-TRACK-0002";
const draftResultStudentNumber = "TEST-TRACK-0003";
const draftPriorityStudentNumber = "TEST-TRACK-0004";

beforeAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await insertTestStudent({
    studentNumber,
    firstName: "Tracking",
    lastName: "Fixture",
    yearLevel: 2,
  });
  await insertTestStudent({
    studentNumber: draftHistoryStudentNumber,
    firstName: "Hidden",
    lastName: "History",
    yearLevel: 2,
  });
  await insertTestStudent({
    studentNumber: draftResultStudentNumber,
    firstName: "Hidden",
    lastName: "Result",
    yearLevel: 2,
  });
  await insertTestStudent({
    studentNumber: draftPriorityStudentNumber,
    firstName: "Hidden",
    lastName: "Priority",
    yearLevel: 2,
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await pool.end();
});

describe("results and compliance", () => {
  it("requires a completion date for completed results", () => {
    expect(() => resultSchema.parse({
      studentNumber, resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "", remarks: "",
    })).toThrow();
  });

  it("stores historical results and reflects them in compliance", async () => {
    const result = await recordResult({
      studentNumber, appointmentId: null, resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "2026-07-01", remarks: "Historical record",
    }, actorUserId);
    try {
      const history = await resultsForStudent(studentNumber);
      expect(history?.examResults[0]).toMatchObject({ resultStatus: "COMPLETED", completedAt: "2026-07-01" });
      const compliance = await complianceReport({ search: studentNumber, page: 1, limit: 20, offset: 0 });
      expect(compliance.items[0]).toMatchObject({ physicalExamStatus: "COMPLETED" });
    } finally {
      await pool.query("DELETE FROM exam_results WHERE id=$1", [result.id]);
    }
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
      laboratoryStatus: "PENDING",
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
      laboratoryStatus: "COMPLETED",
    });
  });

  it("keeps results linked to an unpublished appointment out of student history", async () => {
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY','2026-07-16','DRAFT',FALSE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, draftHistoryStudentNumber, actorUserId],
    );
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, remarks, encoded_by
       ) VALUES ($1,$2,'PENDING','Must remain private while draft',$3)`,
      [draftHistoryStudentNumber, appointment.rows[0].id, actorUserId],
    );

    const hidden = await resultsForStudent(draftHistoryStudentNumber);
    expect(hidden?.laboratoryResults).toEqual([]);
    expect(hidden?.appointments).toEqual([]);

    await pool.query(
      "UPDATE appointments SET status='PENDING', is_published=TRUE WHERE id=$1",
      [appointment.rows[0].id],
    );

    const published = await resultsForStudent(draftHistoryStudentNumber);
    expect(published?.laboratoryResults).toEqual([
      expect.objectContaining({ appointmentId: appointment.rows[0].id }),
    ]);
    expect(published?.appointments).toEqual([
      expect.objectContaining({ id: appointment.rows[0].id, status: "PENDING" }),
    ]);
  });

  it("rejects result writes against an unpublished appointment", async () => {
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2026-07-17','DRAFT',FALSE,$3,$3)
       RETURNING id`,
      [TEST_REFERENCE_IDS.physicalExamClinic, draftResultStudentNumber, actorUserId],
    );

    await expect(recordResult({
      studentNumber: draftResultStudentNumber,
      appointmentId: appointment.rows[0].id,
      resultType: "PHYSICAL_EXAM",
      resultStatus: "PENDING",
      completedAt: "",
      remarks: "Should not be written",
    }, actorUserId)).rejects.toMatchObject({
      code: "APPOINTMENT_NOT_FOUND",
      status: 422,
    });

    const stored = await pool.query(
      "SELECT 1 FROM exam_results WHERE appointment_id=$1",
      [appointment.rows[0].id],
    );
    expect(stored.rowCount).toBe(0);
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
