// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport } from "./schedule-imports.service";
import { createClinicUnavailableDate } from "./clinic-calendar.service";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-95%";
const importPattern = "REGULAR 2026-2027 - TEST-CALENDAR%";
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

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-CALENDAR%'");
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("clinic calendar closures", () => {
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
    const blocks = await pool.query(
      "SELECT 1 FROM clinic_unavailable_dates WHERE reason='TEST-CALENDAR protected closure'",
    );
    expect(blocks.rowCount).toBe(0);
  });

  it("rejects overlapping ranges for the same clinic", async () => {
    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: "2027-07-01",
      endDate: "2027-07-03",
      category: "HOLIDAY",
      reason: "TEST-CALENDAR first range",
    }, admin);
    await expect(createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: "2027-07-03",
      endDate: "2027-07-04",
      category: "HOLIDAY",
      reason: "TEST-CALENDAR overlap",
    }, admin)).rejects.toMatchObject({ code: "CLINIC_BLOCK_OVERLAP", status: 409 });
  });
});
