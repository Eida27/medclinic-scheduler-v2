// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { pool } from "@/server/db/pool";
import { complianceReport, resultsForStudent } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { recordResult, resultSchema } from "./tracking.service";

const actorUserId = TEST_REFERENCE_IDS.clinicStaffUser;
const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;
const laboratoryStaff = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
} satisfies SessionUser;
const studentNumber = "TEST-TRACK-0001";
const draftHistoryStudentNumber = "TEST-TRACK-0002";
const draftResultStudentNumber = "TEST-TRACK-0003";
const draftPriorityStudentNumber = "TEST-TRACK-0004";
const summaryStudentNumber = "TEST-SUMMARY-0001";
const linkedStudentNumbers = [
  "TEST-LINK-PHYS",
  "TEST-LINK-LAB",
  "TEST-LINK-AUTO",
  "TEST-LINK-BLANK",
  "TEST-LINK-MANUAL",
  "TEST-LINK-CROSS",
  "TEST-LINK-DONE",
  "TEST-LINK-MISOWNER",
  "TEST-LINK-MISINPUT",
  "TEST-LINK-TYPE",
  "TEST-LINK-TRANS",
  "TEST-LINK-AUDIT",
];

type ResultType = "PHYSICAL_EXAM" | "LABORATORY";
type AppointmentStatus = "PENDING" | "COMPLETED" | "NO_SHOW";

async function dropFailureTriggers() {
  await pool.query("DROP TRIGGER IF EXISTS test_tracking_appointment_failure ON appointments");
  await pool.query("DROP TRIGGER IF EXISTS test_tracking_audit_failure ON audit_logs");
  await pool.query("DROP FUNCTION IF EXISTS test_tracking_appointment_failure()");
  await pool.query("DROP FUNCTION IF EXISTS test_tracking_audit_failure()");
}

async function insertLinkedAppointment({
  studentNumber: fixtureStudentNumber,
  resultType,
  status = "PENDING",
  noShowKind,
}: {
  studentNumber: string;
  resultType: ResultType;
  status?: AppointmentStatus;
  noShowKind?: "AUTOMATIC" | "MANUAL";
}) {
  const clinicId = resultType === "PHYSICAL_EXAM"
    ? TEST_REFERENCE_IDS.physicalExamClinic
    : TEST_REFERENCE_IDS.laboratoryClinic;
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,$2,$3,'2045-07-17',$4,TRUE,$5,$5)
     RETURNING id`,
    [clinicId, fixtureStudentNumber, resultType, status, admin.userId],
  );
  if (status === "NO_SHOW") {
    await pool.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) VALUES ($1,'PENDING','NO_SHOW',$2,$3)`,
      [
        appointment.rows[0].id,
        noShowKind === "AUTOMATIC" ? AUTOMATIC_NO_SHOW_NOTE : "Marked manually after review",
        noShowKind === "AUTOMATIC" ? null : admin.userId,
      ],
    );
  }
  return appointment.rows[0].id;
}

function completedResultInput(
  fixtureStudentNumber: string,
  appointmentId: string | null,
  resultType: ResultType,
  remarks: string | null = "Visit completed",
) {
  return {
    studentNumber: fixtureStudentNumber,
    appointmentId,
    resultType,
    resultStatus: "COMPLETED",
    completedAt: "2045-07-17",
    remarks,
  };
}

async function linkedWriteState(
  appointmentId: string,
  fixtureStudentNumber: string,
  resultType: ResultType,
) {
  const table = resultType === "PHYSICAL_EXAM" ? "exam_results" : "laboratory_results";
  const state = await pool.query<{
    status: string;
    resultCount: number;
    resultStatus: string | null;
    completionLogCount: number;
    appointmentAuditCount: number;
    resultAuditCount: number;
  }>(
    `SELECT
       (SELECT status FROM appointments WHERE id=$1::uuid) AS status,
       (SELECT COUNT(*)::int FROM ${table} WHERE appointment_id=$1::uuid) AS "resultCount",
       (SELECT result_status FROM ${table} WHERE appointment_id=$1::uuid) AS "resultStatus",
       (SELECT COUNT(*)::int FROM appointment_status_logs
         WHERE appointment_id=$1::uuid AND new_status='COMPLETED') AS "completionLogCount",
       (SELECT COUNT(*)::int FROM audit_logs
         WHERE entity_type='appointment' AND entity_id=$1::text
           AND action IN ('APPOINTMENT_STATUS_CHANGED','APPOINTMENT_STATUS_CORRECTED')) AS "appointmentAuditCount",
       (SELECT COUNT(*)::int FROM audit_logs
         WHERE action='RESULT_RECORDED' AND metadata->>'studentNumber'=$2) AS "resultAuditCount"`,
    [appointmentId, fixtureStudentNumber],
  );
  return state.rows[0];
}

async function forceAppointmentTransitionFailure(appointmentId: string) {
  await pool.query(`
    CREATE FUNCTION test_tracking_appointment_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.id = '${appointmentId}'::uuid AND NEW.status = 'COMPLETED' THEN
        RAISE EXCEPTION 'forced linked appointment transition failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER test_tracking_appointment_failure
    BEFORE UPDATE OF status ON appointments
    FOR EACH ROW EXECUTE FUNCTION test_tracking_appointment_failure()
  `);
}

async function forceResultAuditFailure(fixtureStudentNumber: string) {
  await pool.query(`
    CREATE FUNCTION test_tracking_audit_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'RESULT_RECORDED'
         AND NEW.metadata->>'studentNumber' = '${fixtureStudentNumber}' THEN
        RAISE EXCEPTION 'forced linked result audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER test_tracking_audit_failure
    BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION test_tracking_audit_failure()
  `);
}

beforeAll(async () => {
  await dropFailureTriggers();
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%");
  await cleanupTestFixtures("TEST-LINK-%", "TEST linked result fixture%");
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
  await insertTestStudent({
    studentNumber: summaryStudentNumber,
    firstName: "Summary",
    lastName: "Student",
    yearLevel: 2,
  });
  for (const fixtureStudentNumber of linkedStudentNumbers) {
    await insertTestStudent({
      studentNumber: fixtureStudentNumber,
      firstName: "Linked",
      lastName: "Result",
      yearLevel: 2,
    });
  }
});

afterAll(async () => {
  await dropFailureTriggers();
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%");
  await cleanupTestFixtures("TEST-LINK-%", "TEST linked result fixture%");
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
    }, admin);
    try {
      const history = await resultsForStudent(studentNumber);
      expect(history?.examResults[0]).toMatchObject({ resultStatus: "COMPLETED", completedAt: "2026-07-01" });
      const compliance = await complianceReport({ search: studentNumber, page: 1, limit: 20, offset: 0 });
      expect(compliance.items[0]).toMatchObject({ physicalExamStatus: "COMPLETED" });
    } finally {
      await pool.query("DELETE FROM exam_results WHERE id=$1", [result.id]);
    }
  });

  it("completes a linked pending physical appointment with one status log and both audits", async () => {
    const fixtureStudentNumber = "TEST-LINK-PHYS";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "PHYSICAL_EXAM",
    });

    await recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "PHYSICAL_EXAM",
      "Physical exam completed",
    ), admin);

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "PHYSICAL_EXAM",
    )).resolves.toEqual({
      status: "COMPLETED",
      resultCount: 1,
      resultStatus: "COMPLETED",
      completionLogCount: 1,
      appointmentAuditCount: 1,
      resultAuditCount: 1,
    });
    await expect(pool.query(
      `SELECT action, metadata FROM audit_logs
        WHERE entity_type='appointment' AND entity_id=$1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [appointmentId],
    )).resolves.toMatchObject({
      rows: [{
        action: "APPOINTMENT_STATUS_CHANGED",
        metadata: {
          oldStatus: "PENDING",
          newStatus: "COMPLETED",
          reason: "Physical exam completed",
          source: "LINKED_RESULT",
        },
      }],
    });
  });

  it("completes a linked pending laboratory appointment for same-clinic staff", async () => {
    const fixtureStudentNumber = "TEST-LINK-LAB";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
    });

    await recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "LABORATORY",
      "Laboratory visit completed",
    ), laboratoryStaff);

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "COMPLETED",
      resultCount: 1,
      resultStatus: "COMPLETED",
      completionLogCount: 1,
      appointmentAuditCount: 1,
      resultAuditCount: 1,
    });
  });

  it("corrects and audits a linked automatic no-show when remarks provide a reason", async () => {
    const fixtureStudentNumber = "TEST-LINK-AUTO";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
      status: "NO_SHOW",
      noShowKind: "AUTOMATIC",
    });

    await recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "LABORATORY",
      "Signed clinic register confirms completion",
    ), admin);

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "COMPLETED",
      resultCount: 1,
      resultStatus: "COMPLETED",
      completionLogCount: 1,
      appointmentAuditCount: 1,
      resultAuditCount: 1,
    });
    await expect(pool.query(
      `SELECT action, metadata FROM audit_logs
        WHERE entity_type='appointment' AND entity_id=$1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [appointmentId],
    )).resolves.toMatchObject({
      rows: [{
        action: "APPOINTMENT_STATUS_CORRECTED",
        metadata: {
          oldStatus: "NO_SHOW",
          newStatus: "COMPLETED",
          reason: "Signed clinic register confirms completion",
          source: "LINKED_RESULT",
        },
      }],
    });
  });

  it("rolls back a linked result when an automatic no-show correction reason is blank", async () => {
    const fixtureStudentNumber = "TEST-LINK-BLANK";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
      status: "NO_SHOW",
      noShowKind: "AUTOMATIC",
    });

    await expect(recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "LABORATORY",
      "   ",
    ), admin)).rejects.toMatchObject({
      code: "CORRECTION_REASON_REQUIRED",
      status: 422,
    });

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "NO_SHOW",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("rolls back a linked result when the no-show was marked manually", async () => {
    const fixtureStudentNumber = "TEST-LINK-MANUAL";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
      status: "NO_SHOW",
      noShowKind: "MANUAL",
    });

    await expect(recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "LABORATORY",
      "Attempted manual correction",
    ), admin)).rejects.toMatchObject({
      code: "NO_SHOW_CORRECTION_NOT_ALLOWED",
      status: 422,
    });

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "NO_SHOW",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("rolls back a cross-clinic linked completion before any write", async () => {
    const fixtureStudentNumber = "TEST-LINK-CROSS";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "PHYSICAL_EXAM",
    });

    await expect(recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "PHYSICAL_EXAM",
      "Attempted cross-clinic completion",
    ), laboratoryStaff)).rejects.toMatchObject({
      code: "CLINIC_ACCESS_DENIED",
      status: 403,
    });

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "PHYSICAL_EXAM",
    )).resolves.toEqual({
      status: "PENDING",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("upserts a linked result for an already-completed appointment without another appointment log", async () => {
    const fixtureStudentNumber = "TEST-LINK-DONE";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "PHYSICAL_EXAM",
      status: "COMPLETED",
    });
    await pool.query(
      `INSERT INTO exam_results (
         student_number, appointment_id, result_status, encoded_by
       ) VALUES ($1,$2,'PENDING',$3)`,
      [fixtureStudentNumber, appointmentId, admin.userId],
    );

    await recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "PHYSICAL_EXAM",
      "Result encoded after appointment completion",
    ), admin);

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "PHYSICAL_EXAM",
    )).resolves.toEqual({
      status: "COMPLETED",
      resultCount: 1,
      resultStatus: "COMPLETED",
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 1,
    });
  });

  it("rejects a linked appointment belonging to another student without writes", async () => {
    const appointmentId = await insertLinkedAppointment({
      studentNumber: "TEST-LINK-MISOWNER",
      resultType: "PHYSICAL_EXAM",
    });

    await expect(recordResult(completedResultInput(
      "TEST-LINK-MISINPUT",
      appointmentId,
      "PHYSICAL_EXAM",
    ), admin)).rejects.toMatchObject({
      code: "APPOINTMENT_MISMATCH",
      status: 422,
    });

    await expect(linkedWriteState(
      appointmentId,
      "TEST-LINK-MISINPUT",
      "PHYSICAL_EXAM",
    )).resolves.toEqual({
      status: "PENDING",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("rejects a linked appointment for a different result type without writes", async () => {
    const fixtureStudentNumber = "TEST-LINK-TYPE";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "PHYSICAL_EXAM",
    });

    await expect(recordResult(completedResultInput(
      fixtureStudentNumber,
      appointmentId,
      "LABORATORY",
    ), admin)).rejects.toMatchObject({
      code: "APPOINTMENT_MISMATCH",
      status: 422,
    });

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "PENDING",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("rolls back after a forced appointment transition failure following match validation", async () => {
    const fixtureStudentNumber = "TEST-LINK-TRANS";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
    });
    await forceAppointmentTransitionFailure(appointmentId);
    try {
      await expect(recordResult(completedResultInput(
        fixtureStudentNumber,
        appointmentId,
        "LABORATORY",
      ), admin)).rejects.toThrow("forced linked appointment transition failure");
    } finally {
      await dropFailureTriggers();
    }

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "PENDING",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("rolls back the appointment, result, status log, and appointment audit when result audit fails", async () => {
    const fixtureStudentNumber = "TEST-LINK-AUDIT";
    const appointmentId = await insertLinkedAppointment({
      studentNumber: fixtureStudentNumber,
      resultType: "LABORATORY",
    });
    await forceResultAuditFailure(fixtureStudentNumber);
    try {
      await expect(recordResult(completedResultInput(
        fixtureStudentNumber,
        appointmentId,
        "LABORATORY",
      ), admin)).rejects.toThrow("forced linked result audit failure");
    } finally {
      await dropFailureTriggers();
    }

    await expect(linkedWriteState(
      appointmentId,
      fixtureStudentNumber,
      "LABORATORY",
    )).resolves.toEqual({
      status: "PENDING",
      resultCount: 0,
      resultStatus: null,
      completionLogCount: 0,
      appointmentAuditCount: 0,
      resultAuditCount: 0,
    });
  });

  it("summarizes both services by preferring pending appointments and deriving overall follow-up", async () => {
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
        laboratoryStatus: "REQUIRES_FOLLOW_UP",
        physicalExamAppointmentId: pendingPhysical.rows[0].id,
        physicalExamAppointmentDate: "2045-12-20",
        physicalExamAppointmentStatus: "PENDING",
        laboratoryAppointmentId: completedLaboratory.rows[0].id,
        laboratoryAppointmentDate: "2045-12-19",
        laboratoryAppointmentStatus: "COMPLETED",
        nextSchedule: "2045-12-20",
        overallStatus: "FOLLOW_UP",
      }),
    ]);
    expect(report.summary).toEqual({
      totalStudents: 1,
      physicalCompleted: 1,
      laboratoryCompleted: 0,
      pendingAny: 1,
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
    }, admin)).rejects.toMatchObject({
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
