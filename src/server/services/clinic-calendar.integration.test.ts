// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";
import {
  createClinicUnavailableDate,
  saveClinicCalendarChanges,
} from "./clinic-calendar.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-95%";
const importPattern = "REGULAR % - TEST-CALENDAR%";
const suiteStartedAt = new Date();
let capacityFixture: CapacityFixtureLock | null = null;
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function importInput(
  fileName: string,
  studentNumber: string,
  overrides: Partial<{ academicYearStart: number }> = {},
) {
  const contents = [
    header,
    `${studentNumber},Calendar,Student,,,College of Computer Studies,BSIT,3,05-06-2003`,
  ].join("\n");
  return {
    fileName,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: "REGULAR",
    academicYearStart: 2026,
    preferredMonth: null,
    ...overrides,
  };
}

function addCalendarDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

async function readFailedBlockState(studentNumber: string | string[]) {
  const studentNumbers = Array.isArray(studentNumber) ? studentNumber : [studentNumber];
  const [appointments, blocks, statusLogs, rescheduleEvents, notifications, audits] = await Promise.all([
    pool.query(
      `SELECT id::text, schedule_type, appointment_date::text, status,
              rescheduled_from::text, updated_by::text, updated_at::text
         FROM appointments
        WHERE student_number=ANY($1::varchar[])
        ORDER BY id`,
      [studentNumbers],
    ),
    pool.query(
      `SELECT id::text, clinic_id::text, start_date::text, end_date::text,
              category, reason, created_by::text, created_at::text, updated_at::text
         FROM clinic_unavailable_dates
        WHERE reason LIKE 'TEST-CALENDAR%'
        ORDER BY id`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM appointment_status_logs log
         JOIN appointments appointment ON appointment.id=log.appointment_id
        WHERE appointment.student_number=ANY($1::varchar[])`,
      [studentNumbers],
    ),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])",
      [studentNumbers],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM student_portal_notifications
        WHERE student_number=ANY($1::varchar[]) AND notification_type='SCHEDULE_RESCHEDULED'`,
      [studentNumbers],
    ),
    pool.query(
      `SELECT id::text, entity_id, metadata::text, created_at::text
         FROM audit_logs
        WHERE action IN ('CLINIC_UNAVAILABLE_DATE_CREATED','CLINIC_CALENDAR_BATCH_UPDATED')
          AND actor_user_id=$1
          AND (
            created_at >= $2
            OR entity_id IN (
              SELECT id::text
                FROM clinic_unavailable_dates
               WHERE reason LIKE 'TEST-CALENDAR%'
            )
          )
        ORDER BY id`,
      [TEST_REFERENCE_IDS.adminUser, suiteStartedAt],
    ),
  ]);

  return {
    appointments: appointments.rows,
    calendarBlocks: blocks.rows,
    statusLogCount: statusLogs.rows[0].count,
    rescheduleEventCount: rescheduleEvents.rows[0].count,
    notificationCount: notifications.rows[0].count,
    audits: audits.rows,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await transaction(async (client) => {
    const blocks = await client.query<{ id: string }>(
      "SELECT id FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-CALENDAR%' FOR UPDATE",
    );
    const blockIds = blocks.rows.map((block) => block.id);
    await client.query(
      `DELETE FROM audit_logs
        WHERE actor_user_id=$1
          AND created_at >= $2
          AND action IN ('CLINIC_UNAVAILABLE_DATE_CREATED','CLINIC_CALENDAR_BATCH_UPDATED')`,
      [TEST_REFERENCE_IDS.adminUser, suiteStartedAt],
    );
    if (!blockIds.length) return;
    await client.query(
      "DELETE FROM clinic_unavailable_dates WHERE id = ANY($1::uuid[])",
      [blockIds],
    );
  });
  const auditResidue = await pool.query(
    `SELECT id::text
       FROM audit_logs
      WHERE action IN ('CLINIC_UNAVAILABLE_DATE_CREATED','CLINIC_CALENDAR_BATCH_UPDATED')
        AND actor_user_id=$1
        AND created_at >= $2`,
    [TEST_REFERENCE_IDS.adminUser, suiteStartedAt],
  );
  expect(auditResidue.rows).toEqual([]);
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
});
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(
    pool,
    capacityFixture.originalCapacities,
    cleanup,
  );
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("clinic calendar closures", () => {
  it("saves two empty future blocks atomically and import allocation skips both", async () => {
    const result = await saveClinicCalendarChanges({
      changes: [
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-08-02",
          category: "CLOSURE",
          reason: "TEST-CALENDAR batch import Laboratory block",
        },
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
          date: "2027-08-03",
          category: "MAINTENANCE",
          reason: "TEST-CALENDAR batch import PE block",
        },
      ],
    }, admin);

    expect(result).toMatchObject({
      batchId: expect.any(String),
      blockedDateCount: 2,
      unblockedDateCount: 0,
      movedStudentCount: 0,
      movedAppointmentCount: 0,
      restoredStudentCount: 0,
      restoredAppointmentCount: 0,
    });
    expect(result.activeUnavailableDates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        startDate: "2027-08-02",
      }),
      expect.objectContaining({
        clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
        startDate: "2027-08-03",
      }),
    ]));

    const studentNumber = "99-9510-10";
    await acceptAndScheduleImport(importInput(
      "TEST-CALENDAR-batch-before-import.csv",
      studentNumber,
      { academicYearStart: 2027 },
    ), admin);
    const appointments = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type, appointment_date::text
         FROM appointments
        WHERE student_number=$1
        ORDER BY schedule_type`,
      [studentNumber],
    );
    expect(appointments.rows.find((row) => row.schedule_type === "LABORATORY")?.appointment_date)
      .not.toBe("2027-08-02");
    expect(appointments.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")?.appointment_date)
      .not.toBe("2027-08-03");
  });

  it("moves a KABALAKA pair and a separate CPU Physical Examination in one batch", async () => {
    const pairStudent = "99-9511-11";
    const physicalStudent = "99-9512-12";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-batch-pair.csv", pairStudent), admin);
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-batch-physical.csv", physicalStudent), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE
            WHEN student_number=$1 AND schedule_type='LABORATORY' THEN '2027-09-06'::date
            WHEN student_number=$1 AND schedule_type='PHYSICAL_EXAM' THEN '2027-09-07'::date
            WHEN student_number=$2 AND schedule_type='LABORATORY' THEN '2027-09-08'::date
            WHEN student_number=$2 AND schedule_type='PHYSICAL_EXAM' THEN '2027-09-09'::date
          END
        WHERE student_number=ANY($3::varchar[])`,
      [pairStudent, physicalStudent, [pairStudent, physicalStudent]],
    );

    const result = await saveClinicCalendarChanges({
      changes: [
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
          date: "2027-09-09",
          category: "MAINTENANCE",
          reason: "TEST-CALENDAR batch separate PE",
        },
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-09-06",
          category: "CLOSURE",
          reason: "TEST-CALENDAR batch KABALAKA pair",
        },
      ],
    }, admin);

    expect(result).toMatchObject({
      blockedDateCount: 2,
      unblockedDateCount: 0,
      movedStudentCount: 2,
      movedAppointmentCount: 3,
      restoredStudentCount: 0,
      restoredAppointmentCount: 0,
    });
    const appointments = await pool.query<{
      student_number: string;
      schedule_type: string;
      status: string;
      rescheduled_from: string | null;
    }>(
      `SELECT student_number, schedule_type, status, rescheduled_from::text
         FROM appointments
        WHERE student_number=ANY($1::varchar[])
        ORDER BY student_number, schedule_type, created_at`,
      [[pairStudent, physicalStudent]],
    );
    expect(appointments.rows.filter((row) => (
      row.student_number === pairStudent && row.status === "RESCHEDULED"
    ))).toHaveLength(2);
    expect(appointments.rows.filter((row) => (
      row.student_number === pairStudent && row.status === "PENDING" && row.rescheduled_from
    ))).toHaveLength(2);
    expect(appointments.rows.filter((row) => (
      row.student_number === physicalStudent && row.schedule_type === "LABORATORY"
    ))).toEqual([expect.objectContaining({ status: "PENDING", rescheduled_from: null })]);
    expect(appointments.rows.filter((row) => (
      row.student_number === physicalStudent && row.schedule_type === "PHYSICAL_EXAM"
    ))).toEqual([
      expect.objectContaining({ status: "RESCHEDULED" }),
      expect.objectContaining({ status: "PENDING", rescheduled_from: expect.any(String) }),
    ]);
    const provenance = await pool.query<{
      created_batch_count: number;
      event_batch_count: number;
      status_log_batch_count: number;
      per_date_audit_count: number;
      batch_audit_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM clinic_unavailable_dates
           WHERE created_batch_id=$1) AS created_batch_count,
         (SELECT COUNT(*)::int FROM appointment_reschedule_events
           WHERE block_batch_id=$1) AS event_batch_count,
         (SELECT COUNT(*)::int FROM appointment_status_logs
           WHERE notes LIKE '%' || $1::text || '%') AS status_log_batch_count,
         (SELECT COUNT(*)::int FROM audit_logs
           WHERE action='CLINIC_UNAVAILABLE_DATE_CREATED'
             AND metadata->>'batchId'=$1::text) AS per_date_audit_count,
         (SELECT COUNT(*)::int FROM audit_logs
           WHERE action='CLINIC_CALENDAR_BATCH_UPDATED'
             AND entity_id=$1::text) AS batch_audit_count`,
      [result.batchId],
    );
    expect(provenance.rows[0]).toEqual({
      created_batch_count: 2,
      event_batch_count: 2,
      status_log_batch_count: 6,
      per_date_audit_count: 2,
      batch_audit_count: 1,
    });
  });

  it("writes one block-provenance event for every moved cycle of the same student", async () => {
    const studentNumber = "99-9516-16";
    await acceptAndScheduleImport(importInput(
      "TEST-CALENDAR-multi-cycle-2026.csv",
      studentNumber,
      { academicYearStart: 2026 },
    ), admin);
    await acceptAndScheduleImport(importInput(
      "TEST-CALENDAR-multi-cycle-2027.csv",
      studentNumber,
      { academicYearStart: 2027 },
    ), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE
            WHEN schedule_type='LABORATORY' THEN '2028-01-03'::date
            WHEN schedule_cycle_start=2026 THEN '2028-01-04'::date
            ELSE '2028-01-05'::date
          END
        WHERE student_number=$1`,
      [studentNumber],
    );

    const result = await saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: "2028-01-03",
        category: "CLOSURE",
        reason: "TEST-CALENDAR multi-cycle provenance",
      }],
    }, admin);

    expect(result).toMatchObject({
      movedStudentCount: 1,
      movedAppointmentCount: 4,
    });
    const events = await pool.query<{
      schedule_pair_id: string;
      old_laboratory_appointment_id: string;
      new_laboratory_appointment_id: string;
      old_physical_exam_appointment_id: string;
      new_physical_exam_appointment_id: string;
      block_batch_id: string;
    }>(
      `SELECT schedule_pair_id::text,
              old_laboratory_appointment_id::text,
              new_laboratory_appointment_id::text,
              old_physical_exam_appointment_id::text,
              new_physical_exam_appointment_id::text,
              block_batch_id::text
         FROM appointment_reschedule_events
        WHERE student_number=$1 AND block_batch_id=$2
        ORDER BY schedule_pair_id`,
      [studentNumber, result.batchId],
    );
    expect(events.rows).toEqual([
      {
        schedule_pair_id: expect.any(String),
        old_laboratory_appointment_id: expect.any(String),
        new_laboratory_appointment_id: expect.any(String),
        old_physical_exam_appointment_id: expect.any(String),
        new_physical_exam_appointment_id: expect.any(String),
        block_batch_id: result.batchId,
      },
      {
        schedule_pair_id: expect.any(String),
        old_laboratory_appointment_id: expect.any(String),
        new_laboratory_appointment_id: expect.any(String),
        old_physical_exam_appointment_id: expect.any(String),
        new_physical_exam_appointment_id: expect.any(String),
        block_batch_id: result.batchId,
      },
    ]);
    expect(new Set(events.rows.map((event) => event.schedule_pair_id)).size).toBe(2);
    const notifications = await pool.query<{ move_count: number }>(
      `SELECT jsonb_array_length(metadata->'moves') AS move_count
         FROM student_portal_notifications
        WHERE student_number=$1
          AND notification_type='SCHEDULE_RESCHEDULED'
          AND metadata->>'batchId'=$2::text`,
      [studentNumber, result.batchId],
    );
    expect(notifications.rows).toEqual([{ move_count: 4 }]);
  });

  it("plans two blocks against the complete final blocked set", async () => {
    const studentNumber = "99-9513-13";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-combined-final-set.csv", studentNumber), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE schedule_type
            WHEN 'LABORATORY' THEN '2027-10-04'::date
            WHEN 'PHYSICAL_EXAM' THEN '2027-10-05'::date
          END
        WHERE student_number=$1`,
      [studentNumber],
    );

    await saveClinicCalendarChanges({
      changes: [
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-10-04",
          category: "CLOSURE",
          reason: "TEST-CALENDAR combined KABALAKA block",
        },
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
          date: "2027-10-06",
          category: "MAINTENANCE",
          reason: "TEST-CALENDAR combined CPU block",
        },
      ],
    }, admin);

    const replacements = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type, appointment_date::text
         FROM appointments
        WHERE student_number=$1
          AND status='PENDING'
          AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
      [studentNumber],
    );
    expect(replacements.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2027-10-05" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2027-10-07" },
    ]);
  });

  it("rejects a full two-block batch before mutation when one appointment is protected", async () => {
    const movableStudent = "99-9514-14";
    const protectedStudent = "99-9515-15";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-atomic-movable.csv", movableStudent), admin);
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-atomic-protected.csv", protectedStudent), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE
            WHEN student_number=$1 AND schedule_type='LABORATORY' THEN '2027-11-01'::date
            WHEN student_number=$1 AND schedule_type='PHYSICAL_EXAM' THEN '2027-11-02'::date
            WHEN student_number=$2 AND schedule_type='LABORATORY' THEN '2027-11-03'::date
            WHEN student_number=$2 AND schedule_type='PHYSICAL_EXAM' THEN '2027-11-04'::date
          END
        WHERE student_number=ANY($3::varchar[])`,
      [movableStudent, protectedStudent, [movableStudent, protectedStudent]],
    );
    const protectedPhysical = await pool.query<{ id: string }>(
      `UPDATE appointments
          SET is_manually_locked=TRUE, locked_by=$2,
              locked_at=NOW(), lock_reason='TEST protected batch'
        WHERE student_number=$1 AND schedule_type='PHYSICAL_EXAM'
        RETURNING id::text`,
      [protectedStudent, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await readFailedBlockState([movableStudent, protectedStudent]);

    await expect(saveClinicCalendarChanges({
      changes: [
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-11-01",
          category: "CLOSURE",
          reason: "TEST-CALENDAR atomic movable block",
        },
        {
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
          date: "2027-11-04",
          category: "MAINTENANCE",
          reason: "TEST-CALENDAR atomic protected block",
        },
      ],
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 409,
      details: {
        issues: [expect.objectContaining({
          clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
          date: "2027-11-04",
          action: "BLOCK",
          code: "PROTECTED_REPLACEMENT",
          studentNumbers: [protectedStudent],
          appointmentIds: [protectedPhysical.rows[0].id],
        })],
      },
    });
    expect(await readFailedBlockState([movableStudent, protectedStudent])).toEqual(before);
  });

  it.each([
    ["an empty batch", { changes: [] }],
    [
      "a duplicate clinic date",
      {
        changes: [
          {
            action: "BLOCK",
            clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
            date: "2027-07-15",
            category: "CLOSURE",
            reason: "TEST-CALENDAR duplicate first",
          },
          {
            action: "BLOCK",
            clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
            date: "2027-07-15",
            category: "MAINTENANCE",
            reason: "TEST-CALENDAR duplicate second",
          },
        ],
      },
    ],
    [
      "an invalid clinic UUID",
      {
        changes: [{
          action: "BLOCK",
          clinicId: "not-a-uuid",
          date: "2027-07-15",
          category: "CLOSURE",
          reason: "TEST-CALENDAR invalid clinic",
        }],
      },
    ],
    [
      "an invalid ISO date",
      {
        changes: [{
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-02-30",
          category: "CLOSURE",
          reason: "TEST-CALENDAR invalid date",
        }],
      },
    ],
    [
      "an invalid category",
      {
        changes: [{
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-07-15",
          category: "INVALID",
          reason: "TEST-CALENDAR invalid category",
        }],
      },
    ],
    [
      "a short reason",
      {
        changes: [{
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-07-15",
          category: "CLOSURE",
          reason: "x",
        }],
      },
    ],
    [
      "a date after year 2100",
      {
        changes: [{
          action: "BLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2101-01-03",
          category: "CLOSURE",
          reason: "TEST-CALENDAR out of range year",
        }],
      },
    ],
    [
      "an unblock before restoration support is added",
      {
        changes: [{
          action: "UNBLOCK",
          clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
          date: "2027-07-15",
          unavailableDateId: "70000000-0000-4000-8000-000000000001",
          expectedUpdatedAt: "2027-07-01T00:00:00.000000Z",
        }],
      },
    ],
  ])("rejects %s with structured invalid-change details", async (_label, raw) => {
    await expect(saveClinicCalendarChanges(raw, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 422,
      details: { issues: [expect.objectContaining({ code: "INVALID_CHANGE" })] },
    });
  });

  it("rejects more than 366 changes", async () => {
    const changes = Array.from({ length: 367 }, (_, index) => ({
      action: "BLOCK" as const,
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      date: addCalendarDays("2098-01-01", index),
      category: "CLOSURE" as const,
      reason: `TEST-CALENDAR oversized ${index}`,
    }));

    await expect(saveClinicCalendarChanges({ changes }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 422,
      details: { issues: [expect.objectContaining({ code: "INVALID_CHANGE" })] },
    });
  });

  it.each([
    ["today or past dates", "2026-07-24"],
    ["weekends", "2027-07-17"],
  ])("rejects %s before mutation", async (_label, date) => {
    const before = await readFailedBlockState([]);
    await expect(saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date,
        category: "CLOSURE",
        reason: "TEST-CALENDAR invalid temporal date",
      }],
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 422,
      details: { issues: [expect.objectContaining({ code: "INVALID_CHANGE" })] },
    });
    expect(await readFailedBlockState([])).toEqual(before);
  });

  it("rejects an unsupported clinic with structured details", async () => {
    await expect(saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.adminUser,
        date: "2027-07-15",
        category: "CLOSURE",
        reason: "TEST-CALENDAR unsupported clinic",
      }],
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 409,
      details: { issues: [expect.objectContaining({ code: "INVALID_CHANGE" })] },
    });
  });

  it("rejects an active block conflict with structured details", async () => {
    const change = {
      action: "BLOCK" as const,
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      date: "2027-07-15",
      category: "CLOSURE" as const,
      reason: "TEST-CALENDAR active batch conflict",
    };
    await saveClinicCalendarChanges({ changes: [change] }, admin);
    const before = await readFailedBlockState([]);

    await expect(saveClinicCalendarChanges({ changes: [change] }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 409,
      details: {
        issues: [expect.objectContaining({
          clinicId: change.clinicId,
          date: change.date,
          action: "BLOCK",
          code: "ACTIVE_BLOCK_CONFLICT",
        })],
      },
    });
    expect(await readFailedBlockState([])).toEqual(before);
  });

  it("keeps the legacy creator one-day-only after delegating to batch save", async () => {
    const before = await readFailedBlockState([]);

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      startDate: "2027-07-15",
      endDate: "2027-07-16",
      category: "CLOSURE",
      reason: "TEST-CALENDAR legacy multi-day rejection",
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_BLOCK_RANGE_NOT_SUPPORTED",
      status: 422,
    });
    expect(await readFailedBlockState([])).toEqual(before);
  });

  it("preserves appointment-to-student identity in legacy protected-pair details", async () => {
    const studentNumber = "99-9517-17";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-legacy-protected-pair.csv", studentNumber), admin);
    const protectedAppointments = await pool.query<{ id: string }>(
      `UPDATE appointments
          SET appointment_date=CASE schedule_type
                WHEN 'LABORATORY' THEN '2027-12-06'::date
                WHEN 'PHYSICAL_EXAM' THEN '2027-12-07'::date
              END,
              is_manually_locked=TRUE,
              locked_by=$2,
              locked_at=NOW(),
              lock_reason='TEST protected legacy pair'
        WHERE student_number=$1
        RETURNING id::text`,
      [studentNumber, TEST_REFERENCE_IDS.adminUser],
    );
    const unresolved = protectedAppointments.rows
      .map((appointment) => `${appointment.id}:${studentNumber}`)
      .sort();
    const before = await readFailedBlockState(studentNumber);

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      startDate: "2027-12-06",
      endDate: "2027-12-06",
      category: "CLOSURE",
      reason: "TEST-CALENDAR protected legacy pair",
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_BLOCK_PROTECTED_APPOINTMENTS",
      status: 409,
      fields: { unresolved },
    });
    expect(await readFailedBlockState(studentNumber)).toEqual(before);
  });

  it("returns the database's exact optimistic token for a newly created block", async () => {
    const result = await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      startDate: "2048-07-20",
      endDate: "2048-07-20",
      category: "CLOSURE",
      reason: "TEST-CALENDAR precise optimistic token",
    }, admin) as Awaited<ReturnType<typeof createClinicUnavailableDate>> & { updatedAt?: string };

    const stored = await pool.query<{ updated_at: string }>(
      `SELECT to_char(
          updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS updated_at
         FROM clinic_unavailable_dates
        WHERE id=$1`,
      [result.id],
    );

    expect(result.updatedAt).toEqual(expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    ));
    expect(result.updatedAt).toBe(stored.rows[0].updated_at);
  });

  it("fills a replacement date to maximum capacity before moving later", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-maximum-existing.csv", "99-9506-06"), admin);
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-maximum-moved.csv", "99-9507-07"), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE
            WHEN student_number='99-9506-06' AND schedule_type='PHYSICAL_EXAM' THEN '2027-06-09'::date
            WHEN student_number='99-9507-07' AND schedule_type='LABORATORY' THEN '2027-06-07'::date
            WHEN student_number='99-9507-07' AND schedule_type='PHYSICAL_EXAM' THEN '2027-06-08'::date
            ELSE appointment_date
          END
        WHERE student_number IN ('99-9506-06','99-9507-07')`,
    );
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=2, max_daily_capacity=2
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );

    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: "2027-06-08",
      endDate: "2027-06-08",
      category: "CLOSURE",
      reason: "TEST-CALENDAR maximum-only replacement",
    }, admin);

    const replacement = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number='99-9507-07'
          AND schedule_type='PHYSICAL_EXAM'
          AND status='PENDING'
          AND rescheduled_from IS NOT NULL`,
    );
    expect(replacement.rows).toEqual([{ appointment_date: "2027-06-09" }]);
  });

  it("moves only PE when a future CPU Clinic date is blocked", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-cpu.csv", "99-9501-01"), admin);
    const before = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type, appointment_date::text
         FROM appointments WHERE student_number='99-9501-01'`,
    );
    const peDate = before.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!.appointment_date;

    const result = await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: peDate,
      endDate: peDate,
      category: "CLOSURE",
      reason: "TEST-CALENDAR CPU closure",
    }, admin);
    expect(result).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 1 });
    const after = await pool.query(
      `SELECT schedule_type, status, appointment_date::text, rescheduled_from::text
         FROM appointments WHERE student_number='99-9501-01'
        ORDER BY schedule_type, created_at`,
    );
    expect(after.rows.filter((row) => row.schedule_type === "LABORATORY"))
      .toEqual([expect.objectContaining({ status: "PENDING", rescheduled_from: null })]);
    expect(after.rows.filter((row) => row.schedule_type === "PHYSICAL_EXAM"))
      .toEqual([
        expect.objectContaining({ status: "RESCHEDULED" }),
        expect.objectContaining({ status: "PENDING", rescheduled_from: expect.any(String) }),
      ]);
  });

  it("uses a soft-unblocked CPU Clinic date for replacement planning", async () => {
    const studentNumber = "99-9508-08";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-soft-unblocked-cpu.csv", studentNumber), admin);
    await pool.query(
      `UPDATE appointments
          SET appointment_date=CASE schedule_type
            WHEN 'LABORATORY' THEN '2027-06-07'::date
            WHEN 'PHYSICAL_EXAM' THEN '2027-06-08'::date
          END
        WHERE student_number=$1`,
      [studentNumber],
    );
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by,
         unblocked_at, unblocked_by, unblocked_batch_id
       ) VALUES ($1,'2027-06-09','2027-06-09','CLOSURE',
                 'TEST-CALENDAR soft-unblocked CPU replacement',$2,NOW(),$2,gen_random_uuid())`,
      [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
    );

    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: "2027-06-08",
      endDate: "2027-06-08",
      category: "CLOSURE",
      reason: "TEST-CALENDAR CPU replacement source",
    }, admin);

    const replacement = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number=$1
          AND schedule_type='PHYSICAL_EXAM'
          AND status='PENDING'
          AND rescheduled_from IS NOT NULL`,
      [studentNumber],
    );
    expect(replacement.rows).toEqual([{ appointment_date: "2027-06-09" }]);
  });

  it("does not move PE into an earlier existing CPU Clinic block", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-existing-block.csv", "99-9504-04"), admin);
    const pair = await pool.query<{ id: string; schedule_type: string; appointment_date: string }>(
      `SELECT id, schedule_type, appointment_date::text
         FROM appointments WHERE student_number='99-9504-04'`,
    );
    const laboratoryDate = pair.rows.find((row) => row.schedule_type === "LABORATORY")!.appointment_date;
    const physical = pair.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    const blockedStart = addCalendarDays(laboratoryDate, 1);
    const blockedEnd = addCalendarDays(laboratoryDate, 29);
    const physicalDate = addCalendarDays(laboratoryDate, 30);
    await pool.query("UPDATE appointments SET appointment_date=$2 WHERE id=$1", [physical.id, physicalDate]);
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       )
       SELECT $1, blocked_date::date, blocked_date::date,
              'CLOSURE', 'TEST-CALENDAR earlier existing range', $4
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS blocked_date`,
      [TEST_REFERENCE_IDS.physicalExamClinic, blockedStart, blockedEnd, TEST_REFERENCE_IDS.adminUser],
    );

    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: physicalDate,
      endDate: physicalDate,
      category: "CLOSURE",
      reason: "TEST-CALENDAR later CPU closure",
    }, admin);

    const replacement = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text FROM appointments
        WHERE student_number='99-9504-04'
          AND schedule_type='PHYSICAL_EXAM'
          AND status='PENDING'
          AND rescheduled_from IS NOT NULL`,
    );
    expect(replacement.rows[0].appointment_date > blockedEnd).toBe(true);
  });

  it("does not move PE into the past when the paired Laboratory date has passed", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-past-lab.csv", "99-9505-05"), admin);
    const pair = await pool.query<{ id: string; schedule_type: string }>(
      `SELECT id, schedule_type FROM appointments WHERE student_number='99-9505-05'`,
    );
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const laboratory = pair.rows.find((row) => row.schedule_type === "LABORATORY")!;
    const physical = pair.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    const blockedPhysicalDate = addCalendarDays(today, 10);
    await pool.query("UPDATE appointments SET appointment_date=$2 WHERE id=$1", [
      laboratory.id,
      addCalendarDays(today, -10),
    ]);
    await pool.query("UPDATE appointments SET appointment_date=$2 WHERE id=$1", [
      physical.id,
      blockedPhysicalDate,
    ]);

    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: blockedPhysicalDate,
      endDate: blockedPhysicalDate,
      category: "CLOSURE",
      reason: "TEST-CALENDAR future PE with past lab",
    }, admin);

    const replacement = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text FROM appointments
        WHERE student_number='99-9505-05'
          AND schedule_type='PHYSICAL_EXAM'
          AND status='PENDING'
          AND rescheduled_from IS NOT NULL`,
    );
    expect(replacement.rows[0].appointment_date > today).toBe(true);
  });

  it("waits for the shared scheduling allocation lock before creating a block", async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      const pending = createClinicUnavailableDate({
        clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
        startDate: "2027-06-01",
        endDate: "2027-06-01",
        category: "CLOSURE",
        reason: "TEST-CALENDAR serialized closure",
      }, admin);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeRelease = await pool.query(
        "SELECT 1 FROM clinic_unavailable_dates WHERE reason='TEST-CALENDAR serialized closure'",
      );
      expect(beforeRelease.rowCount).toBe(0);
      await blocker.query("COMMIT");
      await pending;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("replaces the full pair when a future KABALAKA date is blocked", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-kabalaka.csv", "99-9502-02"), admin);
    const laboratory = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text FROM appointments
        WHERE student_number='99-9502-02' AND schedule_type='LABORATORY'`,
    );
    const result = await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      startDate: laboratory.rows[0].appointment_date,
      endDate: laboratory.rows[0].appointment_date,
      category: "MAINTENANCE",
      reason: "TEST-CALENDAR KABALAKA closure",
    }, admin);
    expect(result).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 2 });
    const rows = await pool.query(
      `SELECT schedule_type, status, rescheduled_from::text, appointment_date::text
         FROM appointments WHERE student_number='99-9502-02'
        ORDER BY schedule_type, created_at`,
    );
    expect(rows.rows.filter((row) => row.status === "RESCHEDULED")).toHaveLength(2);
    expect(rows.rows.filter((row) => row.status === "PENDING" && row.rescheduled_from)).toHaveLength(2);
    const replacement = rows.rows.filter((row) => row.status === "PENDING" && row.rescheduled_from);
    const lab = replacement.find((row) => row.schedule_type === "LABORATORY")!;
    const pe = replacement.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    expect(lab.appointment_date < pe.appointment_date).toBe(true);
  });

  it("reports protected appointments and rolls back the block", async () => {
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-protected.csv", "99-9503-03"), admin);
    const pe = await pool.query<{ id: string; appointment_date: string }>(
      `SELECT id, appointment_date::text FROM appointments
        WHERE student_number='99-9503-03' AND schedule_type='PHYSICAL_EXAM'`,
    );
    await pool.query(
      `UPDATE appointments SET is_manually_locked=TRUE, locked_by=$2,
              locked_at=NOW(), lock_reason='TEST protected'
        WHERE id=$1`,
      [pe.rows[0].id, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await readFailedBlockState("99-9503-03");

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: pe.rows[0].appointment_date,
      endDate: pe.rows[0].appointment_date,
      category: "CLOSURE",
      reason: "TEST-CALENDAR protected closure",
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_BLOCK_PROTECTED_APPOINTMENTS",
      status: 409,
      fields: { unresolved: [expect.stringContaining(pe.rows[0].id)] },
    });
    const after = await readFailedBlockState("99-9503-03");
    expect(after).toEqual(before);
  });

  it("rejects a one-day overlap without mutating appointments", async () => {
    const studentNumber = "99-9508-08";
    const attemptedReason = "TEST-CALENDAR one-day overlap";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-overlap.csv", studentNumber), admin);
    const physical = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number=$1 AND schedule_type='PHYSICAL_EXAM'`,
      [studentNumber],
    );
    const blockedDate = physical.rows[0].appointment_date;
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES ($1,$2,$2,'HOLIDAY','TEST-CALENDAR existing one-day block',$3)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, blockedDate, TEST_REFERENCE_IDS.adminUser],
    );
    const before = await readFailedBlockState(studentNumber);

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: blockedDate,
      endDate: blockedDate,
      category: "HOLIDAY",
      reason: attemptedReason,
    }, admin)).rejects.toMatchObject({ code: "CLINIC_BLOCK_OVERLAP", status: 409 });
    const after = await readFailedBlockState(studentNumber);
    expect(after).toEqual(before);
  });

  it("rolls back the entire block when no replacement date is available", async () => {
    const studentNumber = "99-9509-09";
    const attemptedReason = "TEST-CALENDAR unavailable replacement";
    await acceptAndScheduleImport(importInput("TEST-CALENDAR-no-replacement.csv", studentNumber), admin);
    const physical = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number=$1 AND schedule_type='PHYSICAL_EXAM'`,
      [studentNumber],
    );
    const blockedDate = physical.rows[0].appointment_date;
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       )
       SELECT $1, blocked_date::date, blocked_date::date,
              'CLOSURE', 'TEST-CALENDAR replacement horizon blocked', $4
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS blocked_date`,
      [
        TEST_REFERENCE_IDS.physicalExamClinic,
        addCalendarDays(blockedDate, 1),
        addCalendarDays(blockedDate, 366 * 5),
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    const before = await readFailedBlockState(studentNumber);

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: blockedDate,
      endDate: blockedDate,
      category: "CLOSURE",
      reason: attemptedReason,
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_BLOCK_REPLACEMENT_UNAVAILABLE",
      status: 409,
    });
    const after = await readFailedBlockState(studentNumber);
    expect(after).toEqual(before);
  });
});
