// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "@/server/laboratory/laboratory-checklist.service";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { completePhysicalExam } from "./certificate.service";
import { savePhysicianRevision } from "./physician.service";

const admin: SessionUser = { userId: TEST_REFERENCE_IDS.adminUser, fullName: "Test Admin", email: "admin@medclinic.local", role: "ADMIN" };
const studentNumber = `CERTLOCK-${randomUUID().slice(0, 8)}`;
let physicianId: string;
let peId: string;
let createdYear = false;

beforeAll(async () => {
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`, [admin.userId]);
  createdYear = Boolean(year.rowCount);
  const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
  physicianId = (await savePhysicianRevision({ profile: {
    displayName: "Dr. Lock Test", licenseNumber: "PRC 98765", specialty: "General Medicine", active: true,
  }, signatureBytes, signatureMediaType: "image/png" }, admin)).id;
  await insertTestStudent({ studentNumber, firstName: "Lock", lastName: "Test", yearLevel: 2, dateOfBirth: "2005-01-01" });
  const labId = await transaction(async (client) => {
    const importId = await insertTestScheduleImportGroup(client, { name: "CERTLOCK fixture", sourceFilename: `${randomUUID()}.csv`, academicYearStart: 2026, importMode: "STANDARD", actor: admin.userId });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
      VALUES ($1,2026,'Lock Test',$2,'College of Computer Studies',$3,'BSIT','BSIT',2,$4)`,
    [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId]);
    const pairId = randomUUID();
    const lab = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'LABORATORY','2026-09-22','PENDING',TRUE,$3,2026,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId, admin.userId]);
    const pe = await client.query<{ id: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$2,'PHYSICAL_EXAM','2026-09-23','PENDING',TRUE,$3,2026,'REGULAR',$4,$4) RETURNING id::text`,
    [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, admin.userId]);
    peId = pe.rows[0].id;
    await linkPublishedLaboratoryAppointments(client, [lab.rows[0].id]);
    return lab.rows[0].id;
  });
  let checklist = await getLaboratoryChecklist(labId, admin);
  for (const testCode of ["CBC", "URINE", "STOOL"] as const) {
    checklist = await setLaboratoryTestVerification(labId, { testCode, checked: true, expectedVersion: checklist.version }, admin);
  }
});

afterAll(async () => {
  await cleanupTestFixtures("CERTLOCK-%", "CERTLOCK-%", "CERTLOCK fixture%");
  await transaction(async (client) => {
    await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
    await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [physicianId]);
    await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [physicianId]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
  });
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

it("holds the physician profile against admin changes through the final issuance transaction", async () => {
  const originalConnect = pool.connect.bind(pool);
  let readPhysician!: () => void;
  const physicianRead = new Promise<void>((resolve) => { readPhysician = resolve; });
  let resumeTransaction!: () => void;
  const resumed = new Promise<void>((resolve) => { resumeTransaction = resolve; });
  let connections = 0;
  let physicianReads = 0;
  const connectSpy = vi.spyOn(pool, "connect").mockImplementation(async () => {
    const client = await originalConnect();
    if (++connections >= 2) {
      const originalQuery = client.query.bind(client);
      client.query = (async (sql: string, values?: unknown[]) => {
        const result = await originalQuery(sql, values);
        if (sql.includes("FROM medical_certificate_physicians profile")) {
          client.query = originalQuery as typeof client.query;
          if (++physicianReads === 2) {
            readPhysician();
            await resumed;
          }
        }
        return result;
      }) as typeof client.query;
    }
    return client;
  });
  const issuance = completePhysicalExam(peId, {
    requestId: randomUUID(), physicianId, physicianVersion: 1,
    examinationDate: "2026-09-23", sex: "Female", classification: "A", remarks: "Fit for class",
    lateReason: "Encoding after the scheduled visit", attested: true,
  }, admin);
  let updateError: unknown;
  let updater: PoolClient | undefined;
  try {
    await physicianRead;
    updater = await originalConnect();
    await updater.query("BEGIN");
    await updater.query("SET LOCAL lock_timeout = '250ms'");
    try {
      await updater.query("UPDATE medical_certificate_physicians SET active=FALSE WHERE id=$1", [physicianId]);
    } catch (error) {
      updateError = error;
    }
  } finally {
    if (updater) {
      await updater.query("ROLLBACK");
      updater.release();
    }
    resumeTransaction();
    connectSpy.mockRestore();
  }
  await issuance;
  expect(updateError).toMatchObject({ code: "55P03" });
}, 30_000);
