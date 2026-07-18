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
});
