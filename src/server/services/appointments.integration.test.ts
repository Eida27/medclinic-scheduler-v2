// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { pool } from "@/server/db/pool";
import {
  getPublishedAppointment,
  listAppointments,
} from "@/server/repositories/appointments.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";

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
const createdAcademicYears: number[] = [];
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
  "TEST-APPT-Q-PEND",
  "TEST-APPT-Q-NOSHOW",
  "TEST-APPT-Q-MANUAL",
  "TEST-APPT-Q-PROT",
  "TEST-APPT-Q-CROSS",
  "TEST-APPT-Q-CONC",
  "TEST-APPT-Q-ROLL",
  "TEST-APPT-SNAP-CONF",
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

async function insertQuickPendingAppointment(
  fixtureStudentNumber: string,
  clinicId: string = TEST_REFERENCE_IDS.laboratoryClinic,
) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, notes, created_by, updated_by
     ) VALUES ($1,$2,$3,'2045-08-18','PENDING',TRUE,'Quick-status fixture',$4,$4)
     RETURNING id`,
    [
      clinicId,
      fixtureStudentNumber,
      clinicId === TEST_REFERENCE_IDS.laboratoryClinic ? "LABORATORY" : "PHYSICAL_EXAM",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  const academicYears = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2026,'2027-07-31',$1,$1),(2044,'2045-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  createdAcademicYears.push(...academicYears.rows.map((row) => row.start_year));
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
  if (createdAcademicYears.length) {
    await pool.query(
      "DELETE FROM academic_years WHERE start_year=ANY($1::integer[])",
      [createdAcademicYears],
    );
  }
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

  it("reads a published appointment and creates a logged replacement on reschedule", async () => {
    await pool.query(
      `UPDATE students SET email='appointment.fixture@example.test',email_verified_at=NOW()
        WHERE student_number=$1`,
      [studentNumber],
    );
    const current = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,created_by,updated_by
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2044-09-01','PENDING',TRUE,2044,$3,$3)
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, admin.userId],
    );
    const portalSchedule = await getStudentPortalSchedule(studentNumber);
    expect(portalSchedule).toMatchObject({
      studentNumber,
      studentName: "Fixture, Appointment Maria Angela (Jr.)",
      appointments: [expect.any(Object)],
    });
    await expect(getPublishedAppointment(current.rows[0].id)).resolves.toMatchObject({
      studentName: "Fixture, Appointment Maria Angela (Jr.)",
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
          studentName: "Fixture, Appointment Maria Angela (Jr.)",
        }),
      ]));
    }
    const privateRescheduleNote = "Student conflict: private medical/internal case 4401";
    const replacement = await updateAppointment(current.rows[0].id, {
      status: "COMPLETED",
      appointmentDate: "2044-09-02", notes: privateRescheduleNote,
    }, admin);
    expect(replacement?.status).toBe("PENDING");
    expect(replacement?.rescheduledFrom).toBe(current.rows[0].id);
    const logs = await pool.query("SELECT new_status FROM appointment_status_logs WHERE appointment_id IN ($1,$2)", [current.rows[0].id, replacement?.id]);
    expect(logs.rows.map((row) => row.new_status)).toEqual(expect.arrayContaining(["PENDING", "RESCHEDULED"]));
    const rescheduled = await pool.query(
      `SELECT notification.notification_type,notification.message,
              notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,
              outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_ADMINISTRATOR_RESCHEDULED'`,
      [studentNumber],
    );
    expect(rescheduled.rows).toEqual([{
      notification_type: "SCHEDULE_ADMINISTRATOR_RESCHEDULED",
      message: expect.stringContaining("2044-09-02 at CPU Clinic (Pending)"),
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      source_id: expect.any(String),
      text_body: expect.stringMatching(/Previous Physical Examination: 2044-09-01 at CPU Clinic[\s\S]*Reason: Administrator-authorized reschedule/),
    }]);
    expect(JSON.stringify(rescheduled.rows)).not.toContain(privateRescheduleNote);

    const privateCancellationNote = "Administrator internal medical note: private case 4402";
    await updateAppointment(replacement!.id, {
      status: "CANCELLED",
      notes: privateCancellationNote,
    }, admin);
    const cancelled = await pool.query(
      `SELECT notification.notification_type,notification.metadata->>'sourceType' AS source_type,
               notification.message,outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_CANCELLED'`,
      [studentNumber],
    );
    expect(cancelled).toMatchObject({ rows: [{
      notification_type: "SCHEDULE_CANCELLED",
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      message: expect.stringContaining("authorized scheduling action cancelled your schedule"),
      text_body: expect.stringContaining("Reason: Administrator-authorized cancellation"),
    }] });
    expect(JSON.stringify(cancelled.rows)).not.toContain(privateCancellationNote);

    const internalHistory = await pool.query<{ notes: string }>(
      `SELECT notes
         FROM appointment_status_logs
        WHERE appointment_id IN ($1,$2) AND notes IS NOT NULL
        ORDER BY created_at,id`,
      [current.rows[0].id, replacement!.id],
    );
    expect(internalHistory.rows.map((row) => row.notes)).toEqual(expect.arrayContaining([
      privateRescheduleNote,
      privateCancellationNote,
    ]));
  });

  it("reschedules a manual no-show when a mixed request also carries completed status", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-MIX-MANUAL",
      manualLatest: true,
    });

    const replacement = await updateAppointment(appointmentId, {
      status: "COMPLETED",
      appointmentDate: "2045-01-16",
      notes: "Student requested a replacement",
    }, admin);

    expect(replacement).toMatchObject({
      status: "PENDING",
      rescheduledFrom: appointmentId,
      appointmentDate: "2045-01-16",
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

  it("completes and reverts a future pending appointment atomically without changing its date", async () => {
    const appointmentId = await insertQuickPendingAppointment("TEST-APPT-Q-PEND");

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, laboratoryStaff)).resolves.toMatchObject({
      id: appointmentId,
      status: "COMPLETED",
      appointmentDate: "2045-08-18",
    });

    const completedList = await listAppointments({
      studentNumber: "TEST-APPT-Q-PEND",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(completedList.items[0]).toMatchObject({
      id: appointmentId,
      status: "COMPLETED",
      completedFromStatus: "PENDING",
    });
    await expect(pool.query(
      "SELECT result_status FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ result_status: "PENDING_UPLOAD" }] });

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
    }, laboratoryStaff)).resolves.toMatchObject({
      id: appointmentId,
      status: "PENDING",
      appointmentDate: "2045-08-18",
    });

    const snapshot = await appointmentMutationSnapshot(appointmentId);
    expect(snapshot.history).toEqual([
      {
        oldStatus: "PENDING",
        newStatus: "COMPLETED",
        notes: "Marked completed through the clinic schedule.",
        changedBy: laboratoryStaff.userId,
      },
      {
        oldStatus: "COMPLETED",
        newStatus: "PENDING",
        notes: "Clinic schedule completion reverted to pending.",
        changedBy: laboratoryStaff.userId,
      },
    ]);
    expect(snapshot.audit).toEqual([
      {
        action: "APPOINTMENT_STATUS_CHANGED",
        metadata: {
          oldStatus: "PENDING",
          newStatus: "COMPLETED",
          quickStatusAction: "MARK_COMPLETED",
          source: "CLINIC_SCHEDULE_QUICK_STATUS",
        },
      },
      {
        action: "APPOINTMENT_STATUS_CORRECTED",
        metadata: {
          oldStatus: "COMPLETED",
          newStatus: "PENDING",
          quickStatusAction: "REVERT_COMPLETION",
          source: "CLINIC_SCHEDULE_QUICK_STATUS",
        },
      },
    ]);
    await expect(pool.query(
      "SELECT id FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("corrects and restores an automatic no-show using only fixed server notes", async () => {
    const appointmentId = await insertNoShowAppointment({ studentNumber: "TEST-APPT-Q-NOSHOW" });

    await updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "NO_SHOW",
    }, admin);
    const completedList = await listAppointments({
      studentNumber: "TEST-APPT-Q-NOSHOW",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(completedList.items[0].completedFromStatus).toBe("NO_SHOW");

    await updateAppointment(appointmentId, {
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
    }, admin);

    const snapshot = await appointmentMutationSnapshot(appointmentId);
    expect(snapshot.appointment[0].status).toBe("NO_SHOW");
    expect(snapshot.history.slice(-2)).toEqual([
      expect.objectContaining({
        oldStatus: "NO_SHOW",
        newStatus: "COMPLETED",
        notes: "Automatic no-show corrected to completed through the clinic schedule.",
      }),
      expect.objectContaining({
        oldStatus: "COMPLETED",
        newStatus: "NO_SHOW",
        notes: "Clinic schedule completion reverted to the previous automatic no-show.",
      }),
    ]);
    expect(snapshot.audit).toHaveLength(2);
  });

  it("rejects quick correction of a manual no-show without side effects", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-Q-MANUAL",
      manualLatest: true,
    });
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "NO_SHOW",
    }, admin)).rejects.toMatchObject({ code: "NO_SHOW_CORRECTION_NOT_ALLOWED", status: 422 });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
  });

  it("keeps a protected result completed and rolls back every attempted reversal side effect", async () => {
    const appointmentId = await insertQuickPendingAppointment("TEST-APPT-Q-PROT");
    await updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, admin);
    await pool.query(
      `UPDATE laboratory_results
          SET result_status='COMPLETED', completed_at='2045-08-18', encoded_by=$2
        WHERE appointment_id=$1`,
      [appointmentId, TEST_REFERENCE_IDS.clinicStaffUser],
    );
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
    }, admin)).rejects.toMatchObject({
      code: "APPOINTMENT_RESULT_PROTECTED",
      message: "This appointment can no longer be reverted because protected result data is linked to it.",
      status: 409,
    });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
    await expect(pool.query(
      "SELECT result_status FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rows: [{ result_status: "COMPLETED" }] });
  });

  it("rejects cross-clinic staff before changing a quick-status appointment", async () => {
    const appointmentId = await insertQuickPendingAppointment(
      "TEST-APPT-Q-CROSS",
      TEST_REFERENCE_IDS.physicalExamClinic,
    );
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, laboratoryStaff)).rejects.toMatchObject({ code: "CLINIC_ACCESS_DENIED", status: 403 });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
  });

  it("allows exactly one concurrent quick completion and rejects the stale request", async () => {
    const appointmentId = await insertQuickPendingAppointment("TEST-APPT-Q-CONC");

    const results = await Promise.allSettled([
      updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, admin),
      updateAppointment(appointmentId, {
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }, admin),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "APPOINTMENT_STATUS_CONFLICT", status: 409 }),
      }),
    ]);
    const snapshot = await appointmentMutationSnapshot(appointmentId);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.audit).toHaveLength(1);
    await expect(pool.query(
      "SELECT id FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("rolls back appointment state when a later quick-status write fails", async () => {
    const appointmentId = await insertQuickPendingAppointment("TEST-APPT-Q-ROLL");
    const invalidActor = { ...admin, userId: "99999999-9999-4999-8999-999999999999" };

    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, invalidActor)).rejects.toMatchObject({ code: "23503" });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toMatchObject({
      appointment: [expect.objectContaining({ status: "PENDING" })],
      history: [],
      audit: [],
    });
    await expect(pool.query(
      "SELECT id FROM laboratory_results WHERE appointment_id=$1",
      [appointmentId],
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
