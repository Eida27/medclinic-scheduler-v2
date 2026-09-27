// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { getCurrentEffectiveAppointmentsForStudent } from "./current-effective-appointments.repository";
import { getStudentPortalSchedule } from "./student-portal.repository";

const studentNumber = "TEST-CURRENT-0001";
const createdYears: number[] = [];
let oldLabId: string;
let currentLabId: string;
let currentPeId: string;
let futureLabId: string;
let futurePeId: string;

beforeAll(async () => {
  for (const [year, closingDate] of [[2025, "2026-07-31"], [2026, "2027-07-31"], [2027, "2028-07-31"]] as const) {
    const created = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
      VALUES ($1,$2,$3,$3) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
    [year, closingDate, TEST_REFERENCE_IDS.adminUser]);
    if (created.rowCount) createdYears.push(year);
  }
  await insertTestStudent({ studentNumber, firstName: "Current", lastName: "Appointments", yearLevel: 2 });
  await insertTestStudent({ studentNumber: "TEST-CURRENT-0002", firstName: "No", lastName: "Appointments", yearLevel: 2 });
  await transaction(async (client) => {
    for (const year of [2025, 2026, 2027]) {
      const importId = await insertTestScheduleImportGroup(client, { name: `TEST current ${year}`,
        sourceFilename: `${randomUUID()}.csv`, academicYearStart: year,
        importMode: "STANDARD", actor: TEST_REFERENCE_IDS.adminUser });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ($1,$2,'Current Appointments',$3,'College of Computer Studies',$4,'BSIT','BSIT',2,$5)`,
      [studentNumber, year, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId]);
    }
    const oldLab = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'LABORATORY','2026-05-01','PENDING',TRUE,$3,2025,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, randomUUID(), TEST_REFERENCE_IDS.adminUser]);
    oldLabId = oldLab.rows[0].id;
    await linkPublishedLaboratoryAppointments(client, [oldLabId]);
    await client.query(`UPDATE laboratory_checklist_items SET verified_at='2026-05-01',
      verified_by=$2,verification_source='INTERNAL'
      WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)`,
    [oldLabId, TEST_REFERENCE_IDS.adminUser]);
    await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [oldLabId]);
    const currentPair = randomUUID();
    const currentLab = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'LABORATORY','2026-09-22','PENDING',TRUE,$3,2026,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, currentPair, TEST_REFERENCE_IDS.adminUser]);
    currentLabId = currentLab.rows[0].id;
    await linkPublishedLaboratoryAppointments(client, [currentLabId]);
    const currentPe = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'PHYSICAL_EXAM','2026-09-23','PENDING',TRUE,$3,2026,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, currentPair, TEST_REFERENCE_IDS.adminUser]);
    currentPeId = currentPe.rows[0].id;
    const futurePair = randomUUID();
    const futureLab = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'LABORATORY','2027-09-22','PENDING',TRUE,$3,2027,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, futurePair, TEST_REFERENCE_IDS.adminUser]);
    futureLabId = futureLab.rows[0].id;
    await linkPublishedLaboratoryAppointments(client, [futureLabId]);
    const futurePe = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'PHYSICAL_EXAM','2027-09-23','PENDING',TRUE,$3,2027,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, futurePair, TEST_REFERENCE_IDS.adminUser]);
    futurePeId = futurePe.rows[0].id;
  });
});
afterAll(async () => {
  await cleanupTestFixtures("TEST-CURRENT-%", "TEST current%");
  for (const year of createdYears) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
  await pool.end();
});

describe("current and historical effective appointments", () => {
  it("excludes ended years before ranking so current PE cannot inherit a prior completed Laboratory", async () => {
    const current = await getCurrentEffectiveAppointmentsForStudent(studentNumber);
    expect(current.laboratory).toMatchObject({ id: currentLabId, status: "PENDING", scheduleCycleStart: 2026 });
    expect(current.physicalExam).toMatchObject({ id: currentPeId, status: "PENDING", scheduleCycleStart: 2026 });
    expect(current.laboratory?.id).not.toBe(oldLabId);
    const historical = await getCurrentEffectiveAppointmentsForStudent(studentNumber, { kind: "YEAR", startYear: 2025 });
    expect(historical.laboratory).toMatchObject({ id: oldLabId, status: "COMPLETED", scheduleCycleStart: 2025 });
    expect(historical.physicalExam).toBeNull();
  });
  it("returns null services when a student has no appointments", async () => {
    await expect(getCurrentEffectiveAppointmentsForStudent("TEST-CURRENT-0002"))
      .resolves.toEqual({ laboratory: null, physicalExam: null });
  });
  it("keeps the started cycle current when a future cycle is prepared", async () => {
    const current = await getCurrentEffectiveAppointmentsForStudent(studentNumber);
    expect(current.laboratory).toMatchObject({ id: currentLabId, scheduleCycleStart: 2026 });
    expect(current.physicalExam).toMatchObject({ id: currentPeId, scheduleCycleStart: 2026 });

    const future = await getCurrentEffectiveAppointmentsForStudent(studentNumber, { kind: "YEAR", startYear: 2027 });
    expect(future.laboratory).toMatchObject({ id: futureLabId, scheduleCycleStart: 2027 });
    expect(future.physicalExam).toMatchObject({ id: futurePeId, scheduleCycleStart: 2027 });
  });
  it("keeps both open cycles in the portal and marks the prepared one", async () => {
    const portal = await getStudentPortalSchedule(studentNumber);
    expect(portal?.appointments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentLabId, academicYearStart: 2026, isFutureAcademicYear: false }),
      expect.objectContaining({ id: currentPeId, academicYearStart: 2026, isFutureAcademicYear: false }),
      expect.objectContaining({ id: futureLabId, academicYearStart: 2027, isFutureAcademicYear: true }),
      expect.objectContaining({ id: futurePeId, academicYearStart: 2027, isFutureAcademicYear: true }),
    ]));
  });
  it("classifies ended-year reschedule history for the student's historical section", async () => {
    const oldReschedule = await pool.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'PHYSICAL_EXAM','2026-05-02','RESCHEDULED',TRUE,$3,2025,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, randomUUID(), TEST_REFERENCE_IDS.adminUser]);

    const portal = await getStudentPortalSchedule(studentNumber);
    expect(portal?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldReschedule.rows[0].id, academicYearStart: 2025,
        originalDate: "2026-05-02", isEndedAcademicYear: true }),
    ]));
    expect(portal?.previousAcademicYears).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldLabId, academicYearStart: 2025 }),
    ]));
  });
});
