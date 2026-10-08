// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestScheduleImportGroup,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { linkPublishedLaboratoryAppointments } from "./laboratory-checklist.repository";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "./laboratory-checklist.service";
import { markOverdueAppointmentsNoShow } from "@/server/repositories/appointment-no-show.repository";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";

const cycle = 2026;
const pattern = "LABC-%";
const importName = "LABC checklist fixture";
const cpuUser = "97000000-0000-4000-8000-000000000001";
let sequence = 0;
let externalSequence = 0;
let createdYear = false;

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "Test Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};
const labStaff: SessionUser = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  clinicCode: "KABALAKA_CLINIC",
};
const cpuStaff: SessionUser = {
  userId: cpuUser,
  fullName: "CPU Staff",
  email: "labc-cpu@test.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
  clinicCode: "CPU_CLINIC",
};

async function fixture(yearLevel = 2, category = "REGULAR") {
  const studentNumber = `LABC-${String(++sequence).padStart(4, "0")}`;
  await insertTestStudent({ studentNumber, firstName: "Checklist", lastName: "Student", yearLevel });
  const appointmentId = await transaction(async (client) => {
    const importId = await insertTestScheduleImportGroup(client, {
      name: importName,
      sourceFilename: `LABC-${randomUUID()}.csv`,
      academicYearStart: cycle,
      importMode: "STANDARD",
      actor: admin.userId,
    });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
      VALUES ($1,$2,'Checklist Student',$3,'College of Computer Studies',$4,'BSIT','BSIT',$5,$6)`,
    [studentNumber, cycle, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, yearLevel, importId]);
    const appointment = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'LABORATORY','2026-09-22','PENDING',TRUE,gen_random_uuid(),$3,$4,$5,$5)
      RETURNING id::text`, [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, cycle, category, admin.userId]);
    await linkPublishedLaboratoryAppointments(client, [appointment.rows[0].id]);
    return appointment.rows[0].id;
  });
  return appointmentId;
}

async function externalFixture() {
  const number = ++externalSequence;
  await pool.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
    VALUES (2095,'2096-07-31',$1,$1) ON CONFLICT DO NOTHING`, [admin.userId]);
  const studentNumber = `89-91${String(number).padStart(2, "0")}-91`;
  const contents = `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth\n${studentNumber},External,Checklist,Maria,,College of Computer Studies,BSIT,1,2006-01-01`;
  await acceptAndScheduleImport({ fileName: `LABC first-year ${number}.csv`, fileSize: Buffer.byteLength(contents), contents,
    importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR", academicYearStart: 2095,
    preferredMonth: null, firstYearLaboratoryDate: `2095-09-${21 + number}` }, admin);
  return (await pool.query<{ id: string }>("SELECT id::text FROM appointments WHERE student_number=$1 AND schedule_type='LABORATORY' AND is_published=TRUE", [studentNumber])).rows[0].id;
}

beforeAll(async () => {
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES ($1,'2027-07-31',$2,$2) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`, [cycle, admin.userId]);
  createdYear = Boolean(year.rowCount);
  await pool.query(`INSERT INTO users
    (id,full_name,email,password_hash,role,clinic_id,email_verified_at,must_change_password)
    VALUES ($1,'CPU Staff','labc-cpu@test.local','fixture','CLINIC_STAFF',$2,clock_timestamp(),FALSE)`, [cpuUser, TEST_REFERENCE_IDS.physicalExamClinic]);
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupTestFixtures(pattern, "LABC-%", `${importName}%`);
  await cleanupTestFixtures("89-91%-91", "LABC-%");
  await pool.query("DELETE FROM users WHERE id=$1", [cpuUser]);
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [cycle]);
  await pool.end();
});

describe("Laboratory checklist lifecycle", () => {
  it("rejects checking and no-op unchecking OJT X-ray without changing evidence", async () => {
    const id = await fixture(4, "OJT");
    const before = await getLaboratoryChecklist(id, admin);
    for (const checked of [true, false]) {
      await expect(setLaboratoryTestVerification(id, { testCode: "XRAY", checked, expectedVersion: before.version }, labStaff))
        .rejects.toMatchObject({ code: "LABORATORY_TEST_PE_MANAGED", status: 422 });
    }
    expect(await getLaboratoryChecklist(id, admin)).toEqual(before);
    expect((await pool.query("SELECT 1 FROM laboratory_checklist_events WHERE appointment_id=$1", [id])).rowCount).toBe(0);
  });

  it("reserves every First-Year test, including no-ops, for CPU PE completion", async () => {
    const id = await externalFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2095-10-08T04:00:00Z"));
    try {
      const before = await getLaboratoryChecklist(id, admin);
      for (const testCode of ["CBC", "URINE", "STOOL", "XRAY"] as const) {
        for (const checked of [true, false]) {
          await expect(setLaboratoryTestVerification(id, { testCode, checked, expectedVersion: before.version }, cpuStaff))
            .rejects.toMatchObject({ code: "LABORATORY_TEST_PE_MANAGED", status: 422 });
        }
      }
      expect(await getLaboratoryChecklist(id, admin)).toEqual(before);
      expect((await pool.query("SELECT 1 FROM laboratory_checklist_events WHERE appointment_id=$1", [id])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [id])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM laboratory_results WHERE appointment_id=$1", [id])).rowCount).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("finalizes the unique external summary and result without replacing confirmation identity", async () => {
    const id = await externalFixture();
    const { completeExternalLaboratoryWithClient } = await import("./pe-linked-laboratory.service");
    await transaction(async (client) => {
      const checklist = await getLaboratoryChecklist(id, admin);
      await client.query(`UPDATE laboratory_checklist_items SET verified_at=clock_timestamp(),verified_by=$2,verification_source='EXTERNAL'
        WHERE checklist_id=$1`, [checklist.checklistId, cpuUser]);
      await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [id]);
      await completeExternalLaboratoryWithClient(client, id, cpuUser);
    });
    const snapshot = async () => ({
      verification: (await pool.query("SELECT * FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [id])).rows,
      result: (await pool.query("SELECT * FROM laboratory_results WHERE appointment_id=$1", [id])).rows,
    });
    const before = await snapshot();
    await transaction((client) => completeExternalLaboratoryWithClient(client, id, admin.userId));
    expect(await snapshot()).toEqual(before);
    expect(before.verification).toHaveLength(1);
    expect(before.result).toHaveLength(1);
    expect(before.result[0].result_status).toBe("COMPLETED");
  });

  it("keeps immutable OJT ownership across live-year changes and replacements", async () => {
    const originalId = await fixture(4, "OJT");
    const original = await getLaboratoryChecklist(originalId, admin);
    await pool.query("UPDATE students SET year_level=2 WHERE student_number=(SELECT student_number FROM appointments WHERE id=$1)", [originalId]);
    const replacementId = await transaction(async (client) => {
      await client.query("UPDATE appointments SET status='RESCHEDULED',is_published=FALSE WHERE id=$1", [originalId]);
      const inserted = await client.query<{ id: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,rescheduled_from,created_by,updated_by)
        SELECT clinic_id,student_number,schedule_type,'2026-09-23','PENDING',TRUE,
               schedule_pair_id,schedule_cycle_start,scheduling_category,id,created_by,updated_by
          FROM appointments WHERE id=$1 RETURNING id::text`, [originalId]);
      await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
      return inserted.rows[0].id;
    });
    const replacement = await getLaboratoryChecklist(replacementId, admin);
    expect(replacement.checklistId).toBe(original.checklistId);
    expect(replacement.items.map((item) => item.testCode)).toEqual(["CBC", "URINE", "STOOL", "XRAY"]);
    expect(replacement.completionPolicy).toEqual({ mode: "FOURTH_YEAR_OJT",
      manualTestCodes: ["CBC", "URINE", "STOOL"], peConfirmedTestCodes: ["XRAY"], externalProvider: "Iloilo Mission Hospital" });
    expect((await transaction((client) => import("./laboratory-checklist.repository").then(({ loadLaboratoryChecklist }) =>
      loadLaboratoryChecklist(client, originalId))))?.completionPolicy).toEqual(replacement.completionPolicy);
  });

  it("persists partial checks, rejects stale versions, and completes on the final check", async () => {
    const id = await fixture();
    const initial = await getLaboratoryChecklist(id, admin);
    expect(initial.items.map((item) => item.testCode)).toEqual(["CBC", "URINE", "STOOL"]);
    expect(initial.verifiedCount).toBe(0);
    const first = await setLaboratoryTestVerification(id, {
      testCode: "CBC", checked: true, expectedVersion: initial.version,
    }, labStaff);
    expect(first.verifiedCount).toBe(1);
    expect(first.appointmentStatus).toBe("PENDING");
    await expect(setLaboratoryTestVerification(id, {
      testCode: "URINE", checked: true, expectedVersion: initial.version,
    }, admin)).rejects.toMatchObject({ code: "LABORATORY_CHECKLIST_STALE", status: 409 });
    const second = await setLaboratoryTestVerification(id, {
      testCode: "URINE", checked: true, expectedVersion: first.version,
    }, admin);
    const final = await setLaboratoryTestVerification(id, {
      testCode: "STOOL", checked: true, expectedVersion: second.version,
    }, admin);
    expect(final.verifiedCount).toBe(3);
    expect(final.appointmentStatus).toBe("COMPLETED");
    const events = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM laboratory_checklist_events
      WHERE appointment_id=$1`, [id]);
    expect(events.rows[0].count).toBe("3");
    const result = await pool.query<{ result_status: string }>("SELECT result_status FROM laboratory_results WHERE appointment_id=$1", [id]);
    expect(result.rows[0].result_status).toBe("PENDING_UPLOAD");
  });

  it("requires X-ray for fourth-year OJT and blocks an unrelated clinic", async () => {
    const id = await fixture(4, "OJT");
    const initial = await getLaboratoryChecklist(id, admin);
    expect(initial.items.map((item) => item.testCode)).toEqual(["CBC", "URINE", "STOOL", "XRAY"]);
    await expect(setLaboratoryTestVerification(id, {
      testCode: "CBC", checked: true, expectedVersion: initial.version,
    }, cpuStaff)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("keeps partial Laboratory work out of the midnight no-show sweep", async () => {
    const id = await fixture();
    const initial = await getLaboratoryChecklist(id, admin);
    await setLaboratoryTestVerification(id, {
      testCode: "CBC", checked: true, expectedVersion: initial.version,
    }, admin);
    await markOverdueAppointmentsNoShow(new Date("2026-09-24T00:00:00.000Z"), "Asia/Manila");
    const state = await pool.query<{ status: string }>("SELECT status FROM appointments WHERE id=$1", [id]);
    expect(state.rows[0].status).toBe("PENDING");
  });

  it("keeps verified progress on a manually moved appointment", async () => {
    const originalId = await fixture();
    const initial = await getLaboratoryChecklist(originalId, admin);
    const partial = await setLaboratoryTestVerification(originalId, {
      testCode: "CBC", checked: true, expectedVersion: initial.version,
    }, admin);
    const replacementId = await transaction(async (client) => {
      await client.query("UPDATE appointments SET status='RESCHEDULED',is_published=FALSE WHERE id=$1", [originalId]);
      const inserted = await client.query<{ id: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,rescheduled_from,created_by,updated_by)
        SELECT clinic_id,student_number,schedule_type,'2026-09-23','PENDING',TRUE,
               schedule_pair_id,schedule_cycle_start,scheduling_category,id,created_by,updated_by
          FROM appointments WHERE id=$1 RETURNING id::text`, [originalId]);
      await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
      return inserted.rows[0].id;
    });
    const replacement = await getLaboratoryChecklist(replacementId, admin);
    expect(replacement.checklistId).toBe(initial.checklistId);
    expect(replacement.version).toBe(partial.version);
    expect(replacement.verifiedCount).toBe(1);
  });

  it("blocks a verified-result rollback after the final check", async () => {
    const id = await fixture();
    let checklist = await getLaboratoryChecklist(id, admin);
    for (const testCode of ["CBC", "URINE", "STOOL"] as const) {
      checklist = await setLaboratoryTestVerification(id, {
        testCode, checked: true, expectedVersion: checklist.version,
      }, admin);
    }
    await pool.query(`UPDATE laboratory_results
      SET result_status='COMPLETED',completed_at='2026-09-22'
      WHERE appointment_id=$1`, [id]);
    await expect(setLaboratoryTestVerification(id, {
      testCode: "CBC", checked: false, expectedVersion: checklist.version,
      reason: "Correction after uploaded result",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_RESULT_PROTECTED", status: 409 });
    expect((await getLaboratoryChecklist(id, admin)).verifiedCount).toBe(3);
  });
});
