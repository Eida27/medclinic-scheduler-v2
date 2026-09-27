// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { listAppointments } from "./appointments.repository";

const studentNumber = "TEST-SCOPE-0001";
const manilaToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const calendarYear = Number(manilaToday.slice(0, 4));
const currentYear = manilaToday.slice(5) >= "08-01" ? calendarYear : calendarYear - 1;
const endedYear = currentYear - 1;
const futureYear = currentYear + 1;
const createdYears: number[] = [];

beforeAll(async () => {
  await cleanupTestFixtures("TEST-SCOPE-%", "TEST staff scope%", "TEST staff scope%");
  for (const year of [endedYear, currentYear, futureYear]) {
    const result = await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,make_date($1 + 1,7,31),$2,$2)
       ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
      [year, TEST_REFERENCE_IDS.adminUser],
    );
    if (result.rowCount) createdYears.push(year);
  }
  await insertTestStudent({ studentNumber, firstName: "Staff", lastName: "Scope", yearLevel: 2 });
  await transaction(async (client) => {
    for (const year of [endedYear, currentYear, futureYear]) {
      await insertTestAcademicSnapshot(client, {
        studentNumber,
        academicYearStart: year,
        importName: `TEST staff scope ${year}`,
        actor: TEST_REFERENCE_IDS.adminUser,
      });
      const result = await client.query<{ id: string }>(
        `INSERT INTO appointments
          (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_cycle_start,scheduling_category,created_by,updated_by)
         VALUES ($1,$2,'LABORATORY',make_date($3,9,22),'PENDING',TRUE,$3,'REGULAR',$4,$4)
         RETURNING id::text`,
        [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, year, TEST_REFERENCE_IDS.adminUser],
      );
      await linkPublishedLaboratoryAppointments(client, [result.rows[0].id]);
    }
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-SCOPE-%", "TEST staff scope%", "TEST staff scope%");
  for (const year of createdYears) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
  await pool.end();
});

describe("staff appointment list academic-year scope", () => {
  const filters = { studentNumber, scheduleType: "LABORATORY", page: 1, limit: 10, offset: 0 };

  it("excludes a prepared future cycle from the default current list and count", async () => {
    const result = await listAppointments(filters);
    expect(result.total).toBe(1);
    expect(result.items.map((appointment) => appointment.scheduleCycleStart)).toEqual([currentYear]);
  });

  it("keeps explicitly selected future and ended cycles available", async () => {
    const future = await listAppointments({ ...filters, academicYearStart: futureYear });
    expect(future.total).toBe(1);
    expect(future.items[0]).toMatchObject({ scheduleCycleStart: futureYear, academicYearEnded: false });

    const ended = await listAppointments({ ...filters, academicYearStart: endedYear });
    expect(ended.total).toBe(1);
    expect(ended.items[0]).toMatchObject({ scheduleCycleStart: endedYear, academicYearEnded: true });
  });
});
