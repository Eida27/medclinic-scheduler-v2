// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { pool } from "@/server/db/pool";
import { publicStudentSchedule } from "@/server/repositories/appointments.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { addScheduleBatch, generateBatchAppointments } from "./coordinator-schedules.service";
import { publishScheduleBatch, updateAppointment } from "./appointments.service";

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
const studentNumber = "TEST-APPT-0001";
const correctionStudentNumbers = [
  "TEST-APPT-AUTO-ADMIN",
  "TEST-APPT-AUTO-STAFF",
  "TEST-APPT-AUTO-BLANK",
  "TEST-APPT-AUTO-CROSS",
  "TEST-APPT-MANUAL",
];

async function insertNoShowAppointment({
  studentNumber: fixtureStudentNumber,
  clinicId = TEST_REFERENCE_IDS.laboratoryClinic,
  manualLatest = false,
}: {
  studentNumber: string;
  clinicId?: string;
  manualLatest?: boolean;
}) {
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, notes, created_by, updated_by
     ) VALUES ($1,$2,$3,'2045-01-10','NO_SHOW',TRUE,'Original appointment note',$4,$4)
     RETURNING id`,
    [
      clinicId,
      fixtureStudentNumber,
      clinicId === TEST_REFERENCE_IDS.laboratoryClinic ? "LABORATORY" : "PHYSICAL_EXAM",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const appointmentId = appointment.rows[0].id;
  await pool.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by, created_at
     ) VALUES ($1,'PENDING','NO_SHOW',$2,NULL,'2025-01-11T00:00:00.000Z')`,
    [appointmentId, AUTOMATIC_NO_SHOW_NOTE],
  );
  if (manualLatest) {
    await pool.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by, created_at
       ) VALUES ($1,'PENDING','NO_SHOW','Marked manually after review',$2,'2025-01-12T00:00:00.000Z')`,
      [appointmentId, TEST_REFERENCE_IDS.adminUser],
    );
  }
  return appointmentId;
}

beforeAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await insertTestStudent({
    studentNumber,
    firstName: "Appointment",
    lastName: "Fixture",
    yearLevel: 3,
  });
  for (const fixtureStudentNumber of correctionStudentNumbers) {
    await insertTestStudent({
      studentNumber: fixtureStudentNumber,
      firstName: "Correction",
      lastName: "Fixture",
      yearLevel: 3,
    });
  }
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await pool.end();
});

describe("appointment lifecycle", () => {
  it("hides drafts, publishes them, and creates a logged replacement on reschedule", async () => {
    const batch = await addScheduleBatch({
      batchName: "TEST appointment lifecycle fixture",
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      submittedByName: "Test",
      description: "Disposable",
      items: [{
        studentNumber, scheduleType: "PHYSICAL_EXAM",
        priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
        targetDate: "2026-08-05", targetWeekStart: null, targetWeekEnd: null, remarks: "",
      }],
    }, admin.userId);
    const batchId = String(batch?.id);

    await generateBatchAppointments(batchId, admin);
    expect((await publicStudentSchedule(studentNumber))?.appointments).toHaveLength(0);
    await publishScheduleBatch(batchId, admin.userId);
    expect((await publicStudentSchedule(studentNumber))?.appointments).toHaveLength(1);

    const current = await pool.query<{ id: string }>("SELECT id FROM appointments WHERE batch_id=$1", [batchId]);
    const replacement = await updateAppointment(current.rows[0].id, {
      appointmentDate: "2026-08-06", appointmentTime: "09:00", notes: "Student conflict",
    }, admin);
    expect(replacement?.status).toBe("PENDING");
    expect(replacement?.rescheduledFrom).toBe(current.rows[0].id);
    const logs = await pool.query("SELECT new_status FROM appointment_status_logs WHERE appointment_id IN ($1,$2)", [current.rows[0].id, replacement?.id]);
    expect(logs.rows.map((row) => row.new_status)).toEqual(expect.arrayContaining(["PENDING", "RESCHEDULED"]));
  });

  it("atomically corrects an automatic no-show and records correction audit metadata", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-AUTO-ADMIN",
    });

    const corrected = await updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Signed clinic record confirms completion",
    }, admin);

    expect(corrected).toMatchObject({ id: appointmentId, status: "COMPLETED" });
    const latestLog = await pool.query<{
      oldStatus: string | null;
      newStatus: string;
      notes: string | null;
      changedById: string | null;
    }>(
      `SELECT old_status AS "oldStatus", new_status AS "newStatus", notes,
              changed_by AS "changedById"
         FROM appointment_status_logs
        WHERE appointment_id=$1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [appointmentId],
    );
    expect(latestLog.rows[0]).toEqual({
      oldStatus: "NO_SHOW",
      newStatus: "COMPLETED",
      notes: "Signed clinic record confirms completion",
      changedById: admin.userId,
    });
    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata
         FROM audit_logs
        WHERE entity_type='appointment' AND entity_id=$1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [appointmentId],
    );
    expect(audit.rows[0]).toEqual({
      action: "APPOINTMENT_STATUS_CORRECTED",
      metadata: {
        oldStatus: "NO_SHOW",
        newStatus: "COMPLETED",
        reason: "Signed clinic record confirms completion",
        source: "APPOINTMENT_DETAIL",
      },
    });
  });

  it("lets same-clinic staff correct an automatic no-show", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-AUTO-STAFF",
    });

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Verified in the laboratory register",
    }, laboratoryStaff)).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("rejects a blank correction reason without changing the appointment", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-AUTO-BLANK",
    });

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "   ",
    }, admin)).rejects.toMatchObject({ code: "CORRECTION_REASON_REQUIRED", status: 422 });
    await expect(pool.query(
      "SELECT status FROM appointments WHERE id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ status: "NO_SHOW" }] });
  });

  it("rejects cross-clinic staff without changing the automatic no-show", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-AUTO-CROSS",
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
    });

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Attempted cross-clinic correction",
    }, laboratoryStaff)).rejects.toMatchObject({ code: "CLINIC_ACCESS_DENIED", status: 403 });
    await expect(pool.query(
      "SELECT status FROM appointments WHERE id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ status: "NO_SHOW" }] });
  });

  it("uses only the canonical latest log and rejects a manual no-show", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-MANUAL",
      manualLatest: true,
    });

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Attempted manual correction",
    }, admin)).rejects.toMatchObject({
      code: "NO_SHOW_CORRECTION_NOT_ALLOWED",
      status: 422,
    });
    await expect(pool.query(
      "SELECT status FROM appointments WHERE id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ status: "NO_SHOW" }] });
  });
});
