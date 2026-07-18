// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-94%";
const importPattern = "% 2026-2027 - TEST-DISPLACE%";
let originalCapacities: Array<{ id: string; safe_daily_capacity: number; max_daily_capacity: number }> = [];

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

function input(
  fileName: string,
  category: "REGULAR" | "OJT",
  studentNumbers: string[],
) {
  const contents = [
    header,
    ...studentNumbers.map((studentNumber, index) => (
      `${studentNumber},Displace,Student${index + 1},,,College of Computer Studies,BSIT,3,05-06-2003`
    )),
  ].join("\n");
  return {
    fileName,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: category,
    academicYearStart: 2026,
    preferredMonth: category === "REGULAR" ? null : 8,
  };
}

async function insertEndOfMonthClosures() {
  await pool.query(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by
     ) VALUES
       ($1,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE laboratory',$3),
       ($2,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE physical',$3)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-DISPLACE%'");
}

beforeAll(async () => {
  await cleanup();
  const capacities = await pool.query<{
    id: string;
    safe_daily_capacity: number;
    max_daily_capacity: number;
  }>(
    `SELECT id, safe_daily_capacity, max_daily_capacity
       FROM clinic_capacity_settings WHERE id IN ($1,$2) ORDER BY id`,
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
          SET safe_daily_capacity=$2, max_daily_capacity=$3 WHERE id=$1`,
      [capacity.id, capacity.safe_daily_capacity, capacity.max_daily_capacity],
    );
  }
  await pool.end();
});

describe("priority displacement", () => {
  it("moves only the later eligible Regular pair and keeps linked history", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings SET safe_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular.csv", "REGULAR", ["99-9401-01", "99-9402-02"]),
      admin,
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority.csv", "OJT", ["99-9403-03"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);

    const regularAppointments = await pool.query(
      `SELECT student_number, status, appointment_date::text, rescheduled_from::text
         FROM appointments WHERE student_number IN ('99-9401-01','99-9402-02')
        ORDER BY student_number, created_at, schedule_type`,
    );
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9401-01"))
      .toHaveLength(2);
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9401-01"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "PENDING" })]));
    expect(regularAppointments.rows.filter((row) => row.student_number === "99-9402-02" && row.status === "RESCHEDULED"))
      .toHaveLength(2);
    const replacements = regularAppointments.rows.filter(
      (row) => row.student_number === "99-9402-02" && row.status === "PENDING",
    );
    expect(replacements).toHaveLength(2);
    expect(replacements.every((row) => row.rescheduled_from)).toBe(true);

    const history = await pool.query(
      `SELECT cause, student_number FROM appointment_reschedule_events
        WHERE student_number='99-9402-02'`,
    );
    expect(history.rows).toEqual([{
      cause: "PRIORITY_DISPLACEMENT",
      student_number: "99-9402-02",
    }]);
    const notifications = await pool.query(
      `SELECT notification_type FROM student_portal_notifications
        WHERE student_number='99-9402-02'`,
    );
    expect(notifications.rows).toEqual([{ notification_type: "SCHEDULE_RESCHEDULED" }]);
  });

  it("never moves manually locked Regular appointments", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings SET safe_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await insertEndOfMonthClosures();
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-locked.csv", "REGULAR", ["99-9404-04", "99-9405-05"]),
      admin,
    );
    await pool.query(
      `UPDATE appointments
          SET is_manually_locked=TRUE, locked_by=$2, locked_at=NOW(), lock_reason='TEST protected'
        WHERE student_number=$1`,
      ["99-9405-05", TEST_REFERENCE_IDS.adminUser],
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-locked.csv", "OJT", ["99-9406-06"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const protectedAppointments = await pool.query(
      "SELECT DISTINCT status FROM appointments WHERE student_number='99-9405-05'",
    );
    expect(protectedAppointments.rows).toEqual([{ status: "PENDING" }]);
  });

  it("moves only Regular PE when Laboratory fits but PE exceeds the priority window", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES ($1,'2026-08-05','2026-08-31','CLOSURE','TEST-DISPLACE physical-only',$2)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
    );
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-pe.csv", "REGULAR", ["99-9407-07"]),
      admin,
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-pe.csv", "OJT", ["99-9408-08"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const regular = await pool.query<{
      schedule_type: string;
      status: string;
      rescheduled_from: string | null;
      schedule_pair_id: string;
    }>(
      `SELECT schedule_type, status, rescheduled_from::text, schedule_pair_id::text
         FROM appointments WHERE student_number='99-9407-07'
        ORDER BY schedule_type, created_at`,
    );
    expect(regular.rows.filter((row) => row.schedule_type === "LABORATORY"))
      .toEqual([expect.objectContaining({ status: "PENDING", rescheduled_from: null })]);
    const physical = regular.rows.filter((row) => row.schedule_type === "PHYSICAL_EXAM");
    expect(physical).toEqual([
      expect.objectContaining({ status: "RESCHEDULED", rescheduled_from: null }),
      expect.objectContaining({ status: "PENDING", rescheduled_from: expect.any(String) }),
    ]);
    expect(new Set(regular.rows.map((row) => row.schedule_pair_id)).size).toBe(1);
  });

  it("moves only PE slots usable after each priority Laboratory date", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=CASE
            WHEN schedule_type='LABORATORY' THEN 2
            ELSE 1
          END
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    await acceptAndScheduleImport(
      input("TEST-DISPLACE-regular-matched-pe.csv", "REGULAR", ["99-9409-09", "99-9410-10"]),
      admin,
    );
    await pool.query(
      `UPDATE appointments SET appointment_date='2026-07-31'
        WHERE student_number IN ('99-9409-09','99-9410-10')
          AND schedule_type='LABORATORY'`,
    );
    await pool.query(
      `UPDATE clinic_capacity_settings SET safe_daily_capacity=1
        WHERE schedule_type='LABORATORY'`,
    );
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES
         ($1,'2026-08-04','2026-08-14','CLOSURE','TEST-DISPLACE laboratory gap',$3),
         ($2,'2026-08-06','2026-08-31','CLOSURE','TEST-DISPLACE physical gap',$3)`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );

    const priority = await acceptAndScheduleImport(
      input("TEST-DISPLACE-priority-matched-pe.csv", "OJT", ["99-9411-11", "99-9412-12"]),
      admin,
    );
    expect(priority.displacementTotal).toBe(1);
    const regularPhysical = await pool.query(
      `SELECT student_number, status
         FROM appointments
        WHERE student_number IN ('99-9409-09','99-9410-10')
          AND schedule_type='PHYSICAL_EXAM'
        ORDER BY student_number, created_at`,
    );
    expect(regularPhysical.rows.filter((row) => row.status === "RESCHEDULED")).toHaveLength(1);
    const priorityDates = await pool.query<{ student_number: string; laboratory_date: string; physical_date: string }>(
      `SELECT laboratory.student_number,
              laboratory.appointment_date::text AS laboratory_date,
              physical.appointment_date::text AS physical_date
         FROM appointments laboratory
         JOIN appointments physical ON physical.schedule_pair_id=laboratory.schedule_pair_id
          AND physical.schedule_type='PHYSICAL_EXAM' AND physical.status='PENDING'
        WHERE laboratory.student_number IN ('99-9411-11','99-9412-12')
          AND laboratory.schedule_type='LABORATORY' AND laboratory.status='PENDING'
        ORDER BY laboratory.appointment_date`,
    );
    expect(priorityDates.rows.filter((row) => row.physical_date <= "2026-08-31")).toHaveLength(1);
    expect(priorityDates.rows.every((row) => row.physical_date > row.laboratory_date)).toBe(true);
  });
});
