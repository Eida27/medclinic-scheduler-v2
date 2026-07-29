// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { listAppointments } from "./appointments.repository";

const fixtures = [
  ["TEST-QH-PENDING", "COMPLETED"],
  ["TEST-QH-NOSHOW", "COMPLETED"],
  ["TEST-QH-MISSING", "COMPLETED"],
  ["TEST-QH-PEND-ROW", "PENDING"],
  ["TEST-QH-NO-ROW", "NO_SHOW"],
] as const;

async function cleanup() {
  await cleanupTestFixtures("TEST-QH-%", "TEST quick status history%");
}

beforeAll(async () => {
  await cleanup();
  for (const [studentNumber, status] of fixtures) {
    await insertTestStudent({
      studentNumber,
      firstName: "Quick",
      middleName: "History Source",
      lastName: studentNumber.slice("TEST-QH-".length),
      yearLevel: 3,
    });
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) VALUES ($1,$2,'LABORATORY','2045-08-18',$3,TRUE,$4,$4)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, status, TEST_REFERENCE_IDS.adminUser],
    );
    const appointmentId = appointment.rows[0].id;
    if (studentNumber === "TEST-QH-PENDING") {
      await pool.query(
        `INSERT INTO appointment_status_logs (
           appointment_id, old_status, new_status, notes, changed_by, created_at
         ) VALUES
           ($1,'NO_SHOW','COMPLETED','Older completion',$2,'2045-01-01T00:00:00Z'),
           ($1,'COMPLETED','PENDING','Older reversal',$2,'2045-01-02T00:00:00Z'),
           ($1,'PENDING','COMPLETED','Latest completion',$2,'2045-01-03T00:00:00Z')`,
        [appointmentId, TEST_REFERENCE_IDS.adminUser],
      );
    } else if (studentNumber === "TEST-QH-NOSHOW") {
      await pool.query(
        `INSERT INTO appointment_status_logs (
           appointment_id, old_status, new_status, notes, changed_by, created_at
         ) VALUES ($1,'NO_SHOW','COMPLETED','Latest completion',$2,'2045-01-03T00:00:00Z')`,
        [appointmentId, TEST_REFERENCE_IDS.adminUser],
      );
    } else if (studentNumber === "TEST-QH-MISSING") {
      await pool.query(
        `INSERT INTO appointment_status_logs (
           appointment_id, old_status, new_status, notes, changed_by, created_at
         ) VALUES ($1,'DRAFT','COMPLETED','Unsupported completion',$2,'2045-01-03T00:00:00Z')`,
        [appointmentId, TEST_REFERENCE_IDS.adminUser],
      );
    }
  }
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("published appointment completion source", () => {
  it.each([
    ["TEST-QH-PENDING", "PENDING"],
    ["TEST-QH-NOSHOW", "NO_SHOW"],
    ["TEST-QH-MISSING", null],
    ["TEST-QH-PEND-ROW", null],
    ["TEST-QH-NO-ROW", null],
  ] as const)("derives %s from the newest supported completion transition", async (studentNumber, expected) => {
    const result = await listAppointments({
      studentNumber,
      page: 1,
      limit: 20,
      offset: 0,
      isPublished: true,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].completedFromStatus).toBe(expected);
  });
});
