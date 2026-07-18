// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-92%";
const importPattern = "REGULAR 20%-20% - TEST-FCFS%";
let originalCapacities: Array<{ id: string; safe_daily_capacity: number; max_daily_capacity: number }> = [];

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function input(fileName: string, studentNumber: string, academicYearStart = 2026) {
  const contents = [
    header,
    `${studentNumber},Student,${studentNumber.slice(-2)},,,College of Computer Studies,BSIT,3,05-06-2003`,
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
  await cleanup();
  const capacities = await pool.query<{
    id: string;
    safe_daily_capacity: number;
    max_daily_capacity: number;
  }>(
    `SELECT id, safe_daily_capacity, max_daily_capacity
       FROM clinic_capacity_settings
      WHERE id IN ($1,$2) ORDER BY id`,
    [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
    ],
  );
  originalCapacities = capacities.rows;
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  for (const capacity of originalCapacities) {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=$2, max_daily_capacity=$3
        WHERE id=$1`,
      [capacity.id, capacity.safe_daily_capacity, capacity.max_daily_capacity],
    );
  }
  await pool.end();
});

describe("atomic academic-year import lifecycle", () => {
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
  });

  it("serializes simultaneous imports by immutable accepted_at FCFS order", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings SET safe_daily_capacity=1
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
