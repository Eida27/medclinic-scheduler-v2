// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { getPublishedAppointment, listAppointments } from "@/server/repositories/appointments.repository";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";
import { getStudentResultSubmission } from "./student-result-submissions.service";

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
};
const laboratoryStaff: SessionUser = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
};
let createdAcademicYear = false;

async function cleanup() {
  await cleanupTestFixtures("LOCK-%", "LOCK-%", "LOCK-%");
}

async function createAppointment(studentNumber: string) {
  await insertTestStudent({
    studentNumber,
    firstName: "Appointment",
    lastName: "Locking",
    yearLevel: 4,
  });
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,created_by,updated_by
     ) VALUES ($1,$2,'LABORATORY','2049-08-18','PENDING',TRUE,$3,$3)
     RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, TEST_REFERENCE_IDS.adminUser],
  );
  return result.rows[0].id;
}

async function waitForSchedulingQueueWaiter() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND pid <> pg_backend_pid()
          AND state='active'
          AND wait_event_type='Lock'
          AND query LIKE '%medclinic:schedule-import-queue%'
        LIMIT 1`,
    );
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the lifecycle mutation to reach the scheduling queue lock.");
}

async function waitForBlockedResultMutation() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND pid <> pg_backend_pid()
          AND state='active'
          AND wait_event_type='Lock'
          AND (
            query LIKE '%medclinic:schedule-import-queue%'
            OR (query LIKE '%FROM appointments%' AND query LIKE '%FOR UPDATE%')
          )
        LIMIT 1`,
    );
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for result access to reach its scheduling lock.");
}

beforeAll(async () => {
  await cleanup();
  const academicYear = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2049,'2050-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  createdAcademicYear = academicYear.rowCount === 1;
});
afterAll(async () => {
  await cleanup();
  if (createdAcademicYear) {
    await pool.query("DELETE FROM academic_years WHERE start_year=2049");
  }
  await pool.end();
});

describe("appointment locking and inheritance", () => {
  it("locks, rejects stale requests and clinic staff, then unlocks after a status change", async () => {
    const appointmentId = await createAppointment("LOCK-LIFECYCLE");
    const initial = await getPublishedAppointment(appointmentId);
    if (!initial) throw new Error("Expected a published fixture appointment.");

    await updateAppointment(appointmentId, {
      lockAction: "LOCK",
      lockReason: "Protect while the administrator reviews closure impact",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    }, admin);
    const locked = await getPublishedAppointment(appointmentId);
    expect(locked).toMatchObject({
      isManuallyLocked: true,
      lockReason: "Protect while the administrator reviews closure impact",
      lockedById: admin.userId,
      lockedByName: "System Admin",
      lockedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    await expect(listAppointments({
      studentNumber: "LOCK-LIFECYCLE",
      page: 1,
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: appointmentId, isManuallyLocked: true })],
    });

    await expect(updateAppointment(appointmentId, {
      lockAction: "UNLOCK",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_STALE", status: 409 });
    await expect(updateAppointment(appointmentId, {
      lockAction: "UNLOCK",
      expectedUpdatedAt: locked!.updatedAt.toISOString(),
    }, laboratoryStaff)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    await pool.query(
      "UPDATE appointments SET status='COMPLETED',updated_by=$2 WHERE id=$1",
      [appointmentId, TEST_REFERENCE_IDS.clinicStaffUser],
    );
    const completed = await getPublishedAppointment(appointmentId);
    if (!completed) throw new Error("Expected the completed locked appointment.");
    await updateAppointment(appointmentId, {
      lockAction: "UNLOCK",
      expectedUpdatedAt: completed.updatedAt.toISOString(),
    }, admin);
    await expect(getPublishedAppointment(appointmentId)).resolves.toMatchObject({
      status: "COMPLETED",
      isManuallyLocked: false,
      lockReason: null,
      lockedById: null,
      lockedByName: null,
      lockedAt: null,
    });

    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='appointment' AND entity_id=$1
        ORDER BY created_at,id`,
      [appointmentId],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "APPOINTMENT_LOCKED",
      "APPOINTMENT_UNLOCKED",
    ]);
    expect(audits.rows[0].metadata).toMatchObject({
      appointmentId,
      studentNumber: "LOCK-LIFECYCLE",
      scheduleType: "LABORATORY",
      reason: "Protect while the administrator reviews closure impact",
    });
  });

  it("inherits a lock with the actual clinic-staff rescheduling actor", async () => {
    const appointmentId = await createAppointment("LOCK-INHERIT");
    const initial = await getPublishedAppointment(appointmentId);
    if (!initial) throw new Error("Expected a published fixture appointment.");
    await updateAppointment(appointmentId, {
      lockAction: "LOCK",
      lockReason: "Retain this protection across a replacement",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    }, admin);

    const replacement = await updateAppointment(appointmentId, {
      appointmentDate: "2049-08-19",
      notes: "Clinic staff selected a replacement",
    }, laboratoryStaff);
    expect(replacement).toMatchObject({
      isManuallyLocked: true,
      lockReason: "Retain this protection across a replacement",
      lockedById: laboratoryStaff.userId,
      lockedByName: "Clinic Staff",
      lockedAt: expect.any(Date),
    });
    const source = await pool.query(
      `SELECT status,is_published,is_manually_locked,locked_by::text,lock_reason
         FROM appointments WHERE id=$1`,
      [appointmentId],
    );
    expect(source.rows).toEqual([{
      status: "RESCHEDULED",
      is_published: false,
      is_manually_locked: true,
      locked_by: admin.userId,
      lock_reason: "Retain this protection across a replacement",
    }]);
    const inheritedAudit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action='APPOINTMENT_LOCK_INHERITED' AND entity_id=$1`,
      [replacement!.id],
    );
    expect(inheritedAudit.rows).toEqual([{
      metadata: expect.objectContaining({
        appointmentId: replacement!.id,
        previousAppointmentId: appointmentId,
        studentNumber: "LOCK-INHERIT",
        scheduleType: "LABORATORY",
        reason: "Retain this protection across a replacement",
      }),
    }]);
  });

  it("allows one concurrent lock and rejects the stale contender", async () => {
    const appointmentId = await createAppointment("LOCK-CONCURRENT");
    const initial = await getPublishedAppointment(appointmentId);
    if (!initial) throw new Error("Expected a published fixture appointment.");
    const request = {
      lockAction: "LOCK",
      lockReason: "Concurrent protection request",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    };

    const outcomes = await Promise.allSettled([
      updateAppointment(appointmentId, request, admin),
      updateAppointment(appointmentId, request, admin),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "APPOINTMENT_STALE", status: 409 },
    });
  });

  it("does not deadlock a lifecycle mutation with a schedule import row lock", async () => {
    const studentNumber = "LOCK-IMPORT-ORDER";
    const appointmentId = await createAppointment(studentNumber);
    const importClient = await pool.connect();
    let importCommitted = false;
    let mutation: Promise<
      | { status: "fulfilled"; value: Awaited<ReturnType<typeof updateAppointment>> }
      | { status: "rejected"; reason: unknown }
    > | undefined;
    try {
      await importClient.query("BEGIN");
      await importClient.query(
        "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
      );
      await importClient.query("SELECT id FROM appointments WHERE id=$1 FOR UPDATE", [appointmentId]);

      mutation = updateAppointment(appointmentId, {
        status: "CANCELLED",
        notes: "Concurrent schedule import lock-order fixture",
      }, admin).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForSchedulingQueueWaiter();

      await lockEffectiveAppointmentScopes(importClient, [
        { studentNumber, scheduleType: "LABORATORY" },
        { studentNumber, scheduleType: "PHYSICAL_EXAM" },
      ]);
      await importClient.query("COMMIT");
      importCommitted = true;

      const outcome = await mutation;
      if (outcome.status === "rejected") throw outcome.reason;
      const stored = await pool.query<{ status: string }>(
        "SELECT status FROM appointments WHERE id=$1",
        [appointmentId],
      );
      expect(stored.rows).toEqual([{ status: "CANCELLED" }]);
    } finally {
      if (!importCommitted) await importClient.query("ROLLBACK").catch(() => undefined);
      await mutation?.catch(() => undefined);
      importClient.release();
    }
  });

  it("does not deadlock result draft access with a schedule import row lock", async () => {
    const studentNumber = "LOCK-RESULT-ORDER";
    const appointmentId = await createAppointment(studentNumber);
    const importClient = await pool.connect();
    let importCommitted = false;
    let resultAccess: Promise<
      | { status: "fulfilled"; value: Awaited<ReturnType<typeof getStudentResultSubmission>> }
      | { status: "rejected"; reason: unknown }
    > | undefined;
    try {
      await importClient.query("BEGIN");
      await importClient.query(
        "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
      );
      await importClient.query("SELECT id FROM appointments WHERE id=$1 FOR UPDATE", [appointmentId]);

      resultAccess = getStudentResultSubmission(studentNumber, appointmentId).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForBlockedResultMutation();

      await lockEffectiveAppointmentScopes(importClient, [
        { studentNumber, scheduleType: "LABORATORY" },
      ]);
      await importClient.query("COMMIT");
      importCommitted = true;

      const outcome = await resultAccess;
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "RESULT_UPLOAD_NOT_AVAILABLE", status: 409 },
      });
      await expect(pool.query(
        "SELECT 1 FROM student_result_submissions WHERE appointment_id=$1",
        [appointmentId],
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      if (!importCommitted) await importClient.query("ROLLBACK").catch(() => undefined);
      await resultAccess?.catch(() => undefined);
      importClient.release();
    }
  });

  it("rolls back the source transition and inherited lock when replacement insertion fails", async () => {
    const appointmentId = await createAppointment("LOCK-ROLLBACK");
    const initial = await getPublishedAppointment(appointmentId);
    if (!initial) throw new Error("Expected a published fixture appointment.");
    await updateAppointment(appointmentId, {
      lockAction: "LOCK",
      lockReason: "This lock must survive a failed replacement",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    }, admin);
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_lock_inheritance_failure()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rescheduled_from='${appointmentId}'::uuid THEN
          RAISE EXCEPTION 'TEST inherited replacement failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_lock_inheritance_failure
        BEFORE INSERT ON appointments
        FOR EACH ROW EXECUTE FUNCTION test_lock_inheritance_failure();
    `);
    try {
      await expect(updateAppointment(appointmentId, {
        appointmentDate: "2049-08-20",
        notes: "This replacement must fail",
      }, admin)).rejects.toThrow(/TEST inherited replacement failure/);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_lock_inheritance_failure ON appointments");
      await pool.query("DROP FUNCTION IF EXISTS test_lock_inheritance_failure()");
    }
    const source = await pool.query(
      `SELECT status,is_published,is_manually_locked,lock_reason
         FROM appointments WHERE id=$1`,
      [appointmentId],
    );
    expect(source.rows).toEqual([{
      status: "PENDING",
      is_published: true,
      is_manually_locked: true,
      lock_reason: "This lock must survive a failed replacement",
    }]);
    await expect(pool.query(
      "SELECT 1 FROM appointments WHERE rescheduled_from=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
