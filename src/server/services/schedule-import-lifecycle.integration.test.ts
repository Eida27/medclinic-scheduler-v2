// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-92%";
const importPattern = "REGULAR 20%-20% - TEST-FCFS%";
let capacityFixture: CapacityFixtureLock | null = null;
let createdAcademicYears: number[] = [];

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function input(fileName: string, studentNumber: string, academicYearStart = 2026) {
  const contents = [
    header,
    `${studentNumber},Student,${studentNumber.slice(-2)},Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
  ].join("\n");
  return {
    fileName,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: "REGULAR",
    academicYearStart,
    preferredMonth: null,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
  const insertedAcademicYears = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2026,'2027-07-31',$1,$1),(2027,'2028-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  createdAcademicYears = insertedAcademicYears.rows.map((row) => row.start_year);
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
  await teardownCapacityFixtureLock(pool, capacityFixture, async () => {
    let failure: unknown;
    try {
      await cleanup();
    } catch (error) {
      failure = error;
    }
    try {
      if (createdAcademicYears.length) {
        await pool.query(
          "DELETE FROM academic_years WHERE start_year=ANY($1::integer[])",
          [createdAcademicYears],
        );
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  });
});

describe("atomic academic-year import lifecycle", () => {
  it("allocates 101 Standard students in CSV order as 100/1 per service at the fresh defaults", async () => {
    expect(capacityFixture!.originalCapacities.map((capacity) => capacity.max_daily_capacity)).toEqual([100, 100]);
    await cleanupAndRestoreCapacitySettings(pool, capacityFixture!.originalCapacities, cleanup);
    const academicYearStart = 2094;
    const year = await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,'2095-07-31',$2,$2) RETURNING start_year`,
      [academicYearStart, TEST_REFERENCE_IDS.adminUser],
    );
    expect(year.rowCount).toBe(1);
    createdAcademicYears.push(academicYearStart);
    const students = Array.from({ length: 101 }, (_, index) =>
      `99-92${String(Math.floor(index / 100)).padStart(2, "0")}-${String(index % 100).padStart(2, "0")}`);
    const contents = [header, ...students.map((student, index) =>
      `${student},Capacity,Student${index},Maria,,College of Computer Studies,BSIT,3,2003-05-06`)].join("\n");
    const result = await acceptAndScheduleImport({
      ...input("TEST-FCFS-default-101.csv", students[0], academicYearStart),
      contents,
      fileSize: Buffer.byteLength(contents),
    }, admin);
    expect(result).toMatchObject({ outcome: "PUBLISHED", totalRows: 101, publishedAppointmentCount: 202 });

    const eligibleDates: string[] = [];
    const day = new Date(Date.UTC(academicYearStart, 7, 1));
    while (eligibleDates.length < 3) {
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) eligibleDates.push(day.toISOString().slice(0, 10));
      day.setUTCDate(day.getUTCDate() + 1);
    }
    const loads = await pool.query(`SELECT appointment.schedule_type,appointment.appointment_date::text,COUNT(*)::int AS used
      FROM appointments appointment JOIN schedule_batches batch ON batch.id=appointment.batch_id
      WHERE batch.import_group_id=$1 AND appointment.is_published=TRUE AND appointment.ovpsa_batch_id IS NULL
        AND appointment.status NOT IN ('CANCELLED','RESCHEDULED')
      GROUP BY appointment.schedule_type,appointment.appointment_date ORDER BY appointment.schedule_type,appointment.appointment_date`, [result.importId]);
    expect(loads.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: eligibleDates[0], used: 100 },
      { schedule_type: "LABORATORY", appointment_date: eligibleDates[1], used: 1 },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: eligibleDates[1], used: 100 },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: eligibleDates[2], used: 1 },
    ]);
    const pairs = await pool.query(`SELECT lab.student_number,lab.schedule_pair_id::text AS lab_pair,pe.schedule_pair_id::text AS pe_pair,
      lab.appointment_date::text AS lab_date,pe.appointment_date::text AS pe_date,item.source_row_order,
      lab.scheduling_accepted_at=import_group.accepted_at AND pe.scheduling_accepted_at=import_group.accepted_at AS fcfs_preserved
      FROM appointments lab JOIN appointments pe ON pe.student_number=lab.student_number AND pe.schedule_pair_id=lab.schedule_pair_id
        AND pe.schedule_type='PHYSICAL_EXAM' AND pe.is_published=TRUE AND pe.status NOT IN ('CANCELLED','RESCHEDULED')
      JOIN coordinator_schedule_items item ON item.id=lab.schedule_item_id
      JOIN schedule_batches batch ON batch.id=lab.batch_id JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
      WHERE batch.import_group_id=$1 AND lab.schedule_type='LABORATORY' AND lab.is_published=TRUE
        AND lab.status NOT IN ('CANCELLED','RESCHEDULED') ORDER BY item.source_row_order`, [result.importId]);
    expect(pairs.rows).toHaveLength(101);
    expect(pairs.rows.map((pair) => pair.student_number)).toEqual(students);
    pairs.rows.forEach((pair, index) => {
      expect(pair.source_row_order).toBe(index + 1);
      expect(pair.lab_pair).toBe(pair.pe_pair);
      expect(pair.lab_date < pair.pe_date).toBe(true);
      expect(pair.fcfs_preserved).toBe(true);
      expect(pair.lab_date).toBe(eligibleDates[index < 100 ? 0 : 1]);
      expect(pair.pe_date).toBe(eligibleDates[index < 100 ? 1 : 2]);
    });
  }, 60_000);

  it("fills imported schedules to maximum capacity before using the next date", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET max_daily_capacity=2
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );

    await acceptAndScheduleImport(input("TEST-FCFS-maximum-1.csv", "99-9210-10"), admin);
    await acceptAndScheduleImport(input("TEST-FCFS-maximum-2.csv", "99-9211-11"), admin);
    await acceptAndScheduleImport(input("TEST-FCFS-maximum-3.csv", "99-9212-12"), admin);

    const laboratoryDates = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text
         FROM appointments
        WHERE student_number IN ('99-9210-10','99-9211-11','99-9212-12')
          AND schedule_type='LABORATORY'
        ORDER BY student_number`,
    );
    expect(laboratoryDates.rows.map((row) => row.appointment_date)).toEqual([
      laboratoryDates.rows[0].appointment_date,
      laboratoryDates.rows[0].appointment_date,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    ]);
    expect(laboratoryDates.rows[2].appointment_date > laboratoryDates.rows[1].appointment_date).toBe(true);
  });

  it("publishes one date-only Lab/PE pair with a shared pair ID", async () => {
    const result = await acceptAndScheduleImport(
      input("TEST-FCFS-pair.csv", "99-9201-01"),
      admin,
    );

    expect(result).toMatchObject({
      outcome: "PUBLISHED",
      status: "PUBLISHED",
      insertedStudentCount: 1,
      updatedStudentCount: 0,
      skippedStudentCount: 0,
      publishedAppointmentCount: 2,
      displacementTotal: 0,
      generatedRange: { startDate: expect.any(String), endDate: expect.any(String) },
    });
    const appointments = await pool.query(
      `SELECT schedule_type, appointment_date::text, status, is_published,
              schedule_pair_id::text, schedule_cycle_start
         FROM appointments WHERE student_number='99-9201-01'
        ORDER BY appointment_date`,
    );
    expect(appointments.rows).toHaveLength(2);
    expect(appointments.rows[0]).toMatchObject({
      schedule_type: "LABORATORY",
      status: "PENDING",
      is_published: true,
      schedule_cycle_start: 2026,
    });
    expect(appointments.rows[1]).toMatchObject({ schedule_type: "PHYSICAL_EXAM" });
    expect(appointments.rows[0].appointment_date < appointments.rows[1].appointment_date).toBe(true);
    expect(appointments.rows[0].schedule_pair_id).toBe(appointments.rows[1].schedule_pair_id);
    const delivery = await pool.query(
      `SELECT notification.notification_type,notification.event_key,
              notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,
              notification.metadata->>'scheduleFingerprint' AS fingerprint,
              (SELECT COUNT(*)::int FROM email_outbox outbox
                WHERE outbox.student_number=notification.student_number) AS email_count
         FROM student_portal_notifications notification
        WHERE notification.student_number='99-9201-01'`,
    );
    expect(delivery.rows).toEqual([{
      notification_type: "SCHEDULE_INITIAL_PUBLICATION",
      event_key: `schedule:initial:SCHEDULE_IMPORT_GROUP:${result.importId}:99-9201-01`,
      source_type: "SCHEDULE_IMPORT_GROUP",
      source_id: result.importId,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      email_count: 0,
    }]);
  });

  it("serializes simultaneous imports by immutable accepted_at FCFS order", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET max_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );

    const results = await Promise.all([
      acceptAndScheduleImport(input("TEST-FCFS-A.csv", "99-9202-02"), admin),
      acceptAndScheduleImport(input("TEST-FCFS-B.csv", "99-9203-03"), admin),
    ]);
    const rows = await pool.query<{
      student_number: string;
      appointment_date: string;
      accepted_at: Date;
    }>(
      `SELECT appointment.student_number, appointment.appointment_date::text,
              import_group.accepted_at
         FROM appointments appointment
         JOIN schedule_batches batch ON batch.id=appointment.batch_id
         JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
        WHERE appointment.student_number IN ('99-9202-02','99-9203-03')
          AND appointment.schedule_type='LABORATORY'
        ORDER BY import_group.accepted_at`,
    );
    expect(results).toHaveLength(2);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].accepted_at.getTime()).toBeLessThan(rows.rows[1].accepted_at.getTime());
    expect(rows.rows[0].appointment_date < rows.rows[1].appointment_date).toBe(true);
    await expect(
      pool.query("UPDATE schedule_import_groups SET accepted_at=NOW() WHERE id=$1", [results[0].importId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("updates demographics but skips same-cycle duplicates and permits a later cycle", async () => {
    await acceptAndScheduleImport(input("TEST-FCFS-first.csv", "99-9204-04"), admin);
    const sameCycle = await acceptAndScheduleImport(
      input("TEST-FCFS-same.csv", "99-9204-04"),
      admin,
    );
    expect(sameCycle).toMatchObject({
      insertedStudentCount: 0,
      updatedStudentCount: 1,
      skippedStudentCount: 1,
      publishedAppointmentCount: 0,
    });
    await pool.query(
      `UPDATE appointments SET status='CANCELLED'
        WHERE student_number='99-9204-04' AND schedule_cycle_start=2026`,
    );
    const cancelledSameCycle = await acceptAndScheduleImport(
      input("TEST-FCFS-cancelled-same.csv", "99-9204-04"),
      admin,
    );
    expect(cancelledSameCycle).toMatchObject({
      insertedStudentCount: 0,
      updatedStudentCount: 1,
      skippedStudentCount: 1,
      publishedAppointmentCount: 0,
    });
    const laterCycle = await acceptAndScheduleImport(
      input("TEST-FCFS-later.csv", "99-9204-04", 2027),
      admin,
    );
    expect(laterCycle).toMatchObject({ skippedStudentCount: 0, publishedAppointmentCount: 2 });
    const pairs = await pool.query(
      `SELECT DISTINCT schedule_cycle_start FROM appointments
        WHERE student_number='99-9204-04' ORDER BY schedule_cycle_start`,
    );
    expect(pairs.rows).toEqual([{ schedule_cycle_start: 2026 }, { schedule_cycle_start: 2027 }]);
  });
});
