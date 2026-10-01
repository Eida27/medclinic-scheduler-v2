// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { annualCalendarOccupancy } from "@/server/services/calendar-occupancy.service";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { commitBulkReplacement, previewBulkReplacement } from "./bulk-replacement.service";

// Keep all fixture dates in a future configured cycle, even as the real Manila date advances.
const academicYearStart = Number(new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Manila", year: "numeric",
}).format(new Date())) + 1;
const septemberStart = new Date(Date.UTC(academicYearStart, 8, 1));
const firstMonday = 1 + (8 - septemberStart.getUTCDay()) % 7;
const fixtureDate = (offset: number) => new Date(Date.UTC(academicYearStart, 8,
  firstMonday + offset)).toISOString().slice(0, 10);
const laboratoryDate = fixtureDate(0);
const replacementDate = fixtureDate(3);
const heldDate = fixtureDate(4);
const physicalExamDate = fixtureDate(7);

const admin: SessionUser = { userId: TEST_REFERENCE_IDS.adminUser, fullName: "Test Admin",
  email: "admin@medclinic.local", role: "ADMIN" };
const selected: Array<{ id: string; expectedUpdatedAt: string }> = [];
let createdYear = false;
let createdCapacity = false;
let previousCapacity: { safe: number; maximum: number } | null = null;

beforeAll(async () => {
  const year = await pool.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
    VALUES ($1,$2,$3,$3) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
  [academicYearStart, `${academicYearStart + 1}-07-31`, admin.userId]);
  createdYear = Boolean(year.rowCount);
  const setting = await pool.query(`INSERT INTO clinic_capacity_settings
    (clinic_id,schedule_type,safe_daily_capacity,max_daily_capacity,is_active)
    VALUES ($1,'LABORATORY',2,2,TRUE) ON CONFLICT (clinic_id,schedule_type) DO NOTHING RETURNING id`,
  [TEST_REFERENCE_IDS.laboratoryClinic]);
  createdCapacity = Boolean(setting.rowCount);
  if (!createdCapacity) {
    const old = await pool.query<{ safe: number; maximum: number }>(`SELECT safe_daily_capacity AS safe,
      max_daily_capacity AS maximum FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`, [TEST_REFERENCE_IDS.laboratoryClinic]);
    previousCapacity = old.rows[0];
    await pool.query(`UPDATE clinic_capacity_settings SET safe_daily_capacity=2,max_daily_capacity=2
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`, [TEST_REFERENCE_IDS.laboratoryClinic]);
  }
  for (let index = 1; index <= 2; index++) {
    const studentNumber = `BULK-${String(index).padStart(4, "0")}`;
    await insertTestStudent({ studentNumber, firstName: "Bulk", lastName: `Student ${index}`, yearLevel: 2 });
    const labId = await transaction(async (client) => {
      const importId = await insertTestScheduleImportGroup(client, { name: "BULK fixture",
        sourceFilename: `${randomUUID()}.csv`, academicYearStart,
        importMode: "STANDARD", actor: admin.userId });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ($1,$5,'Bulk Student',$2,'College of Computer Studies',$3,'BSIT','BSIT',2,$4)`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId, academicYearStart]);
      const pairId = randomUUID();
      const lab = await client.query<{ id: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$2,'LABORATORY',$5,'PENDING',TRUE,$3,$6,'REGULAR',$4,$4) RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId, admin.userId, laboratoryDate, academicYearStart]);
      await client.query(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$2,'PHYSICAL_EXAM',$5,'PENDING',TRUE,$3,$6,'REGULAR',$4,$4)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, admin.userId, physicalExamDate, academicYearStart]);
      await linkPublishedLaboratoryAppointments(client, [lab.rows[0].id]);
      return lab.rows[0].id;
    });
    const version = await pool.query<{ updatedAt: Date }>(`SELECT updated_at AS "updatedAt" FROM appointments WHERE id=$1`, [labId]);
    selected.push({ id: labId, expectedUpdatedAt: version.rows[0].updatedAt.toISOString() });
  }
});
afterAll(async () => {
  await cleanupTestFixtures("BULK-%", "BULK-%", "BULK fixture%");
  if (createdCapacity) await pool.query(`DELETE FROM clinic_capacity_settings
    WHERE clinic_id=$1 AND schedule_type='LABORATORY'`, [TEST_REFERENCE_IDS.laboratoryClinic]);
  else if (previousCapacity) await pool.query(`UPDATE clinic_capacity_settings
    SET safe_daily_capacity=$2,max_daily_capacity=$3
    WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
  [TEST_REFERENCE_IDS.laboratoryClinic, previousCapacity.safe, previousCapacity.maximum]);
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [academicYearStart]);
  await pool.end();
});

describe("atomic bulk replacement", () => {
  it("returns every selected student when one source version changed and refuses to save", async () => {
    const appointments = [
      { ...selected[0], expectedUpdatedAt: "2000-01-01T00:00:00.000Z" },
      selected[1],
    ];
    const payload = { appointments, replacementDate, reason: "Review changed selection" };
    const preview = await previewBulkReplacement(payload, admin);
    expect(preview.rows).toEqual([
      expect.objectContaining({ id: selected[0].id, studentNumber: "BULK-0001",
        issues: [expect.objectContaining({ code: "BULK_SOURCE_CHANGED" })] }),
      expect.objectContaining({ id: selected[1].id, studentNumber: "BULK-0002", issues: [] }),
    ]);
    expect(preview.capacity).toMatchObject({ used: 0, incoming: 2, resulting: 2, maximum: 2 });
    expect(preview.previewToken).toBeNull();
    await expect(commitBulkReplacement({ ...payload, previewToken: "x".repeat(30), requestId: randomUUID() }, admin))
      .rejects.toMatchObject({ code: "BULK_PREVIEW_INVALID" });
  });

  it("shows the aggregate capacity conflict without dropping selected students", async () => {
    await pool.query(`UPDATE clinic_capacity_settings SET safe_daily_capacity=1,max_daily_capacity=1
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`, [TEST_REFERENCE_IDS.laboratoryClinic]);
    try {
      const preview = await previewBulkReplacement({ appointments: selected, replacementDate,
        reason: "Review capacity conflict" }, admin);
      expect(preview.capacity).toMatchObject({ used: 0, incoming: 2, resulting: 2, maximum: 1 });
      expect(preview.rows.map((row) => row.studentNumber)).toEqual(["BULK-0001", "BULK-0002"]);
      expect(preview.rows.every((row) => row.issues.some((issue) => issue.code === "DAILY_CAPACITY_EXCEEDED"))).toBe(true);
      expect(preview.previewToken).toBeNull();
    } finally {
      await pool.query(`UPDATE clinic_capacity_settings SET safe_daily_capacity=2,max_daily_capacity=2
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`, [TEST_REFERENCE_IDS.laboratoryClinic]);
    }
  });

  it("reviews aggregate exact capacity and saves both with checklist lineage", async () => {
    const payload = { appointments: selected, replacementDate, reason: "One shared replacement date" };
    const preview = await previewBulkReplacement(payload, admin);
    expect(preview.capacity).toMatchObject({ used: 0, incoming: 2, resulting: 2, maximum: 2 });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((row) => row.issues.length === 0)).toBe(true);
    const request = { ...payload, previewToken: preview.previewToken, requestId: randomUUID() };
    const outcome = await commitBulkReplacement(request, admin);
    expect(outcome.count).toBe(2);
    const linked = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count
      FROM laboratory_checklist_appointments WHERE appointment_id=ANY($1::uuid[])`, [outcome.appointmentIds]);
    expect(linked.rows[0].count).toBe(2);
    const calendar = await annualCalendarOccupancy(academicYearStart);
    expect(calendar.dates.find((day) => day.date === replacementDate)).toMatchObject({
      laboratory: { used: 2, maximum: 2, remaining: 0 },
      uniqueStudents: 2, appointmentTotal: 2, tone: "RED",
      groups: [{ college: "College of Computer Studies", service: "LABORATORY", appointments: 2 }],
    });
    await insertTestStudent({ studentNumber: "BULK-0003", firstName: "Hold", lastName: "Student", yearLevel: 2 });
    await transaction(async (client) => {
      const importId = await insertTestScheduleImportGroup(client, { name: "BULK fixture hold",
        sourceFilename: `${randomUUID()}.csv`, academicYearStart,
        importMode: "STANDARD", actor: admin.userId });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ('BULK-0003',$4,'Hold Student',$1,'College of Computer Studies',$2,'BSIT','BSIT',2,$3)`,
      [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId, academicYearStart]);
      await client.query(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,'BULK-0003','LABORATORY',$3,'DRAFT',FALSE,gen_random_uuid(),$4,'REGULAR',$2,$2)`,
      [TEST_REFERENCE_IDS.laboratoryClinic, admin.userId, heldDate, academicYearStart]);
    });
    const heldDay = (await annualCalendarOccupancy(academicYearStart)).dates.find((day) => day.date === heldDate);
    expect(heldDay).toMatchObject({ laboratory: { used: 1 }, heldCapacity: 1,
      appointmentTotal: 0, uniqueStudents: 0, tone: "GREEN" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 601_000);
    try { expect(await commitBulkReplacement(request, admin)).toEqual(outcome); }
    finally { vi.restoreAllMocks(); }
    await expect(commitBulkReplacement({ ...request, reason: "Changed reason" }, admin))
      .rejects.toMatchObject({ code: "CLINICAL_REQUEST_CONFLICT", status: 409 });
  });
});
