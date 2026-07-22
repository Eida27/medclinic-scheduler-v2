// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";
import { createClinicUnavailableDate } from "./clinic-calendar.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-95%";
const importPattern = "REGULAR 2026-2027 - TEST-CALENDAR%";
let capacityFixture: CapacityFixtureLock | null = null;
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function importInput(fileName: string, studentNumber: string) {
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
  };
}

function addCalendarDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

async function readFailedBlockState(studentNumber: string, attemptedReason: string) {
  const [appointments, block, statusLogs, rescheduleEvents, notifications, audits] = await Promise.all([
    pool.query(
      `SELECT id::text, schedule_type, appointment_date::text, status,
              rescheduled_from::text, updated_by::text, updated_at::text
         FROM appointments
        WHERE student_number=$1
        ORDER BY id`,
      [studentNumber],
    ),
    pool.query(
      "SELECT id::text FROM clinic_unavailable_dates WHERE reason=$1 ORDER BY id",
      [attemptedReason],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM appointment_status_logs log
         JOIN appointments appointment ON appointment.id=log.appointment_id
        WHERE appointment.student_number=$1`,
      [studentNumber],
    ),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM appointment_reschedule_events WHERE student_number=$1",
      [studentNumber],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM student_portal_notifications
        WHERE student_number=$1 AND notification_type='SCHEDULE_RESCHEDULED'`,
      [studentNumber],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE action='CLINIC_UNAVAILABLE_DATE_CREATED'
          AND actor_user_id=$1
          AND metadata->>'clinicId'=$2`,
      [TEST_REFERENCE_IDS.adminUser, TEST_REFERENCE_IDS.physicalExamClinic],
    ),
  ]);

  return {
    appointments: appointments.rows,
    attemptedBlocks: block.rows,
    statusLogCount: statusLogs.rows[0].count,
    rescheduleEventCount: rescheduleEvents.rows[0].count,
    notificationCount: notifications.rows[0].count,
    auditCount: audits.rows[0].count,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-CALENDAR%'");
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
       ) VALUES ($1,$2,$3,'CLOSURE','TEST-CALENDAR earlier existing range',$4)`,
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
    const before = await readFailedBlockState(
      "99-9503-03",
      "TEST-CALENDAR protected closure",
    );

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
    const after = await readFailedBlockState(
      "99-9503-03",
      "TEST-CALENDAR protected closure",
    );
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
    const before = await readFailedBlockState(studentNumber, attemptedReason);

    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: blockedDate,
      endDate: blockedDate,
      category: "HOLIDAY",
      reason: attemptedReason,
    }, admin)).rejects.toMatchObject({ code: "CLINIC_BLOCK_OVERLAP", status: 409 });
    const after = await readFailedBlockState(studentNumber, attemptedReason);
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
       ) VALUES ($1,$2,$3,'CLOSURE','TEST-CALENDAR replacement horizon blocked',$4)`,
      [
        TEST_REFERENCE_IDS.physicalExamClinic,
        addCalendarDays(blockedDate, 1),
        addCalendarDays(blockedDate, 366 * 5),
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    const before = await readFailedBlockState(studentNumber, attemptedReason);

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
    const after = await readFailedBlockState(studentNumber, attemptedReason);
    expect(after).toEqual(before);
  });
});
