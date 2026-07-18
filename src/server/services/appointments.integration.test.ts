// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { pool } from "@/server/db/pool";
import {
  getPublishedAppointment,
  listAppointments,
  publicStudentSchedule,
} from "@/server/repositories/appointments.repository";
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
const coordinator = {
  userId: "00000000-0000-4000-8000-000000000003",
  fullName: "Schedule Coordinator",
  email: "coordinator@medclinic.local",
  role: "COORDINATOR",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;
const studentNumber = "TEST-APPT-0001";
const correctionStudentNumbers = [
  "TEST-APPT-AUTO-ADMIN",
  "TEST-APPT-AUTO-STAFF",
  "TEST-APPT-AUTO-BLANK",
  "TEST-APPT-AUTO-CROSS",
  "TEST-APPT-MANUAL",
  "TEST-APPT-MIX-MANUAL",
  "TEST-APPT-COORD",
  "TEST-APPT-FINAL",
  "TEST-APPT-DIRECT-NOS",
];
const orderingFixtures = [
  { studentNumber: "TEST-APPT-SORT-ALPHA", firstName: "Zoe", lastName: "Alpha", appointmentDate: "2044-01-03" },
  { studentNumber: "TEST-APPT-SORT-BETA", firstName: "Amy", lastName: "Beta", appointmentDate: "2044-01-01" },
  { studentNumber: "TEST-APPT-SORT-ZULU", firstName: "Ben", lastName: "Zulu", appointmentDate: "2044-01-02" },
] as const;

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

async function appointmentMutationSnapshot(appointmentId: string) {
  const appointment = await pool.query(
    `SELECT status, notes, updated_by AS "updatedBy"
       FROM appointments
      WHERE id=$1`,
    [appointmentId],
  );
  const history = await pool.query(
    `SELECT old_status AS "oldStatus", new_status AS "newStatus", notes, changed_by AS "changedBy"
       FROM appointment_status_logs
      WHERE appointment_id=$1
      ORDER BY created_at, id`,
    [appointmentId],
  );
  const audit = await pool.query(
    `SELECT action, metadata
       FROM audit_logs
      WHERE entity_type='appointment' AND entity_id=$1
      ORDER BY created_at, id`,
    [appointmentId],
  );
  return { appointment: appointment.rows, history: history.rows, audit: audit.rows };
}

beforeAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await insertTestStudent({
    studentNumber,
    firstName: "Appointment",
    middleName: "Maria Angela",
    lastName: "Fixture",
    suffix: "Jr.",
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
  for (const fixture of orderingFixtures) {
    await insertTestStudent({
      studentNumber: fixture.studentNumber,
      firstName: fixture.firstName,
      lastName: fixture.lastName,
      yearLevel: 3,
    });
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY',$3,'PENDING',TRUE,$4,$4)`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        fixture.studentNumber,
        fixture.appointmentDate,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
  }
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await pool.end();
});

describe("appointment lifecycle", () => {
  it.each([
    ["soonest", ["TEST-APPT-SORT-BETA", "TEST-APPT-SORT-ZULU", "TEST-APPT-SORT-ALPHA"]],
    ["latest", ["TEST-APPT-SORT-ALPHA", "TEST-APPT-SORT-ZULU", "TEST-APPT-SORT-BETA"]],
    ["surname_asc", ["TEST-APPT-SORT-ALPHA", "TEST-APPT-SORT-BETA", "TEST-APPT-SORT-ZULU"]],
    ["surname_desc", ["TEST-APPT-SORT-ZULU", "TEST-APPT-SORT-BETA", "TEST-APPT-SORT-ALPHA"]],
  ] as const)("orders the complete result set by %s before pagination", async (sort, expected) => {
    const firstPage = await listAppointments({
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
      studentNumber: "TEST-APPT-SORT-",
      sort,
      page: 1,
      limit: 2,
      offset: 0,
    });
    const secondPage = await listAppointments({
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
      studentNumber: "TEST-APPT-SORT-",
      sort,
      page: 2,
      limit: 2,
      offset: 2,
    });

    expect(firstPage.total).toBe(3);
    expect([...firstPage.items, ...secondPage.items].map((item) => item.studentNumber)).toEqual(expected);
  });

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
    expect(await publicStudentSchedule(studentNumber)).toMatchObject({
      studentName: "Fixture, Appointment M. (Jr.)",
      appointments: [expect.any(Object)],
    });

    const current = await pool.query<{ id: string }>("SELECT id FROM appointments WHERE batch_id=$1", [batchId]);
    await expect(getPublishedAppointment(current.rows[0].id)).resolves.toMatchObject({
      studentName: "Fixture, Appointment M. (Jr.)",
    });
    for (const search of ["Fixture, Appointment", "Appointment Fixture"]) {
      const listed = await listAppointments({
        studentNumber: search,
        page: 1,
        limit: 20,
        offset: 0,
      });
      expect(listed.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: current.rows[0].id,
          studentName: "Fixture, Appointment M. (Jr.)",
        }),
      ]));
    }
    const replacement = await updateAppointment(current.rows[0].id, {
      status: "COMPLETED",
      appointmentDate: "2026-08-06", notes: "Student conflict",
    }, admin);
    expect(replacement?.status).toBe("PENDING");
    expect(replacement?.rescheduledFrom).toBe(current.rows[0].id);
    const logs = await pool.query("SELECT new_status FROM appointment_status_logs WHERE appointment_id IN ($1,$2)", [current.rows[0].id, replacement?.id]);
    expect(logs.rows.map((row) => row.new_status)).toEqual(expect.arrayContaining(["PENDING", "RESCHEDULED"]));
  });

  it("reschedules a manual no-show when a mixed request also carries completed status", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-MIX-MANUAL",
      manualLatest: true,
    });

    const replacement = await updateAppointment(appointmentId, {
      status: "COMPLETED",
      appointmentDate: "2045-01-15",
      notes: "Student requested a replacement",
    }, admin);

    expect(replacement).toMatchObject({
      status: "PENDING",
      rescheduledFrom: appointmentId,
      appointmentDate: "2045-01-15",
    });
    await expect(pool.query(
      "SELECT status FROM appointments WHERE id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ status: "RESCHEDULED" }] });
  });

  it("rejects coordinator updates without changing the appointment, history, or audit", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, notes, created_by, updated_by
       ) VALUES ($1,'TEST-APPT-COORD','LABORATORY','2045-01-20',
                 'PENDING',TRUE,'Coordinator guard fixture',$2,$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    const appointmentId = inserted.rows[0].id;
    await pool.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) VALUES ($1,'DRAFT','PENDING','Published for coordinator guard',$2)`,
      [appointmentId, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Coordinator must not mutate appointments",
    }, coordinator)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
  });

  it("rejects a direct manual no-show without changing appointment, history, or audit", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, notes, created_by, updated_by
       ) VALUES ($1,'TEST-APPT-DIRECT-NOS','LABORATORY','2045-01-20',
                 'PENDING',TRUE,'Manual no-show guard fixture',$2,$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    const appointmentId = inserted.rows[0].id;
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      status: "NO_SHOW",
      notes: "Marked manually",
    }, admin)).rejects.toMatchObject({
      code: "MANUAL_NO_SHOW_NOT_ALLOWED",
      status: 422,
    });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
  });

  it("keeps a completed appointment final for ordinary and mixed dated updates", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, notes, created_by, updated_by
       ) VALUES ($1,'TEST-APPT-FINAL','LABORATORY','2045-01-21',
                 'COMPLETED',TRUE,'Completed appointment fixture',$2,$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
    const appointmentId = inserted.rows[0].id;
    await pool.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) VALUES ($1,'PENDING','COMPLETED','Visit completed',$2)`,
      [appointmentId, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      notes: "Must remain completed",
    }, admin)).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION", status: 422 });
    await expect(updateAppointment(appointmentId, {
      status: "CANCELLED",
      appointmentDate: "2045-01-22",
      notes: "Must not be replaced",
    }, admin)).rejects.toMatchObject({ code: "INVALID_RESCHEDULE", status: 422 });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
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
