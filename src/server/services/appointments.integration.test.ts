// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  getPublishedAppointment,
  listAppointments,
} from "@/server/repositories/appointments.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
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
  const appointment = await transaction(async (client) => {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, schedule_cycle_start, scheduling_category, notes, created_by, updated_by
     ) VALUES ($1,$2,$3,'2045-01-10','NO_SHOW',TRUE,2044,'REGULAR','Original appointment note',$4,$4)
     RETURNING id`,
    [
      clinicId,
      fixtureStudentNumber,
      clinicId === TEST_REFERENCE_IDS.laboratoryClinic ? "LABORATORY" : "PHYSICAL_EXAM",
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  if (clinicId === TEST_REFERENCE_IDS.laboratoryClinic) {
    await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
  }
  return inserted;
  });
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
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%", "TEST appointment lifecycle%");
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
  }
  await transaction(async (client) => {
    for (const fixtureStudentNumber of [studentNumber, ...correctionStudentNumbers, ...orderingFixtures.map((fixture) => fixture.studentNumber)]) {
      await insertTestAcademicSnapshot(client, {
        studentNumber: fixtureStudentNumber,
        academicYearStart: 2044,
        importName: `TEST appointment lifecycle provenance ${fixtureStudentNumber}`,
        actor: TEST_REFERENCE_IDS.adminUser,
      });
    }
    for (const fixture of orderingFixtures) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, schedule_cycle_start, scheduling_category, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY',$3,'PENDING',TRUE,2044,'REGULAR',$4,$4) RETURNING id`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        fixture.studentNumber,
        fixture.appointmentDate,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
    }
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%", "TEST appointment lifecycle%");
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
      academicYearStart: 2044,
      clinicCode: "KABALAKA_CLINIC",
      scheduleType: "LABORATORY",
      studentNumber: "TEST-APPT-SORT-",
      sort,
      page: 1,
      limit: 2,
      offset: 0,
    });
    const secondPage = await listAppointments({
      academicYearStart: 2044,
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
         schedule_cycle_start,scheduling_category,created_by,updated_by
       ) VALUES ($1,$2,'PHYSICAL_EXAM','2044-09-01','PENDING',TRUE,2044,'REGULAR',$3,$3)
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
        academicYearStart: 2044,
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

  it("reschedules a manual no-show", async () => {
    const appointmentId = await insertNoShowAppointment({
      studentNumber: "TEST-APPT-MIX-MANUAL",
      manualLatest: true,
    });

    const replacement = await updateAppointment(appointmentId, {
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
    const inserted = await transaction(async (client) => {
      const appointment = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, schedule_cycle_start, scheduling_category, notes, created_by, updated_by
       ) VALUES ($1,'TEST-APPT-COORD','LABORATORY','2045-01-20',
                 'PENDING',TRUE,2044,'REGULAR','Coordinator guard fixture',$2,$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
      await linkPublishedLaboratoryAppointments(client, [appointment.rows[0].id]);
      return appointment;
    });
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
    const inserted = await transaction(async (client) => {
      const appointment = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, schedule_cycle_start, scheduling_category, notes, created_by, updated_by
       ) VALUES ($1,'TEST-APPT-DIRECT-NOS','LABORATORY','2045-01-20',
                 'PENDING',TRUE,2044,'REGULAR','Manual no-show guard fixture',$2,$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
    );
      await linkPublishedLaboratoryAppointments(client, [appointment.rows[0].id]);
      return appointment;
    });
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

  it("rejects legacy clinical completion payloads without mutating the appointment", async () => {
    const appointmentId = await insertNoShowAppointment({ studentNumber: "TEST-APPT-Q-PEND" });
    const before = await appointmentMutationSnapshot(appointmentId);

    await expect(updateAppointment(appointmentId, {
      status: "COMPLETED",
      notes: "Legacy completion attempt",
    }, admin)).rejects.toMatchObject({ code: "CLINICAL_COMPLETION_RETIRED", status: 422 });
    await expect(updateAppointment(appointmentId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "NO_SHOW",
    }, admin)).rejects.toMatchObject({ code: "CLINICAL_COMPLETION_RETIRED", status: 422 });

    await expect(appointmentMutationSnapshot(appointmentId)).resolves.toEqual(before);
  });
});
