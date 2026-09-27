// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { annualCalendarOccupancy } from "@/server/services/calendar-occupancy.service";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { commitBulkReplacement, previewBulkReplacement } from "./bulk-replacement.service";

const admin: SessionUser = { userId: TEST_REFERENCE_IDS.adminUser, fullName: "Test Admin",
  email: "admin@medclinic.local", role: "ADMIN" };
const selected: Array<{ id: string; expectedUpdatedAt: string }> = [];
let createdYear = false;
let createdCapacity = false;
let previousCapacity: { safe: number; maximum: number } | null = null;

beforeAll(async () => {
  const year = await pool.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
    VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`, [admin.userId]);
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
        sourceFilename: `${randomUUID()}.csv`, academicYearStart: 2026,
        importMode: "STANDARD", actor: admin.userId });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ($1,2026,'Bulk Student',$2,'College of Computer Studies',$3,'BSIT','BSIT',2,$4)`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId]);
      const pairId = randomUUID();
      const lab = await client.query<{ id: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$2,'LABORATORY','2026-09-25','PENDING',TRUE,$3,2026,'REGULAR',$4,$4) RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId, admin.userId]);
      await client.query(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$2,'PHYSICAL_EXAM','2026-10-05','PENDING',TRUE,$3,2026,'REGULAR',$4,$4)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, admin.userId]);
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
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

describe("atomic bulk replacement", () => {
  it("returns every selected student when one source version changed and refuses to save", async () => {
    const appointments = [
      { ...selected[0], expectedUpdatedAt: "2026-09-01T00:00:00.000Z" },
      selected[1],
    ];
    const payload = { appointments, replacementDate: "2026-09-28", reason: "Review changed selection" };
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
      const preview = await previewBulkReplacement({ appointments: selected, replacementDate: "2026-09-28",
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
    const payload = { appointments: selected, replacementDate: "2026-09-28", reason: "One shared replacement date" };
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
    const calendar = await annualCalendarOccupancy(2026);
    expect(calendar.dates.find((day) => day.date === "2026-09-28")).toMatchObject({
      laboratory: { used: 2, maximum: 2, remaining: 0 },
      uniqueStudents: 2, appointmentTotal: 2, tone: "RED",
      groups: [{ college: "College of Computer Studies", service: "LABORATORY", appointments: 2 }],
    });
    await insertTestStudent({ studentNumber: "BULK-0003", firstName: "Hold", lastName: "Student", yearLevel: 2 });
    await transaction(async (client) => {
      const importId = await insertTestScheduleImportGroup(client, { name: "BULK fixture hold",
        sourceFilename: `${randomUUID()}.csv`, academicYearStart: 2026,
        importMode: "STANDARD", actor: admin.userId });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ('BULK-0003',2026,'Hold Student',$1,'College of Computer Studies',$2,'BSIT','BSIT',2,$3)`,
      [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId]);
      await client.query(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,'BULK-0003','LABORATORY','2026-09-30','DRAFT',FALSE,gen_random_uuid(),2026,'REGULAR',$2,$2)`,
      [TEST_REFERENCE_IDS.laboratoryClinic, admin.userId]);
    });
    const heldDay = (await annualCalendarOccupancy(2026)).dates.find((day) => day.date === "2026-09-30");
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
