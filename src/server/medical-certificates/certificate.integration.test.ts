// @vitest-environment node
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "@/server/laboratory/laboratory-checklist.service";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { addStudentResultFiles, beginStudentResultEdit, getStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { getAdminStudentResultProfileRow } from "@/server/repositories/student-result-submissions.repository";
import type { ResultStorage } from "@/server/storage/result-storage";
import type { SessionUser } from "@/types/roles";
import { completePhysicalExam, correctMedicalCertificate, downloadMedicalCertificate, revokeMedicalCertificate } from "./certificate.service";
import { savePhysicianRevision } from "./physician.service";

const admin: SessionUser = { userId: TEST_REFERENCE_IDS.adminUser, fullName: "Test Admin", email: "admin@medclinic.local", role: "ADMIN" };
const createdPhysicians: string[] = [];
let createdYear = false;
let sequence = 0;

async function fixture() {
  const studentNumber = `CERT-${String(++sequence).padStart(4, "0")}`;
  await insertTestStudent({ studentNumber, firstName: "María", lastName: "Dela Cruz", yearLevel: 2, dateOfBirth: "2005-01-01" });
  const appointments = await transaction(async (client) => {
    const importId = await insertTestScheduleImportGroup(client, { name: "CERT fixture", sourceFilename: `${randomUUID()}.csv`, academicYearStart: 2026, importMode: "STANDARD", actor: admin.userId });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
      VALUES ($1,2026,'María Dela Cruz',$2,'College of Computer Studies',$3,'BSIT','BSIT',2,$4)`,
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
    await linkPublishedLaboratoryAppointments(client, [lab.rows[0].id]);
    return { labId: lab.rows[0].id, peId: pe.rows[0].id };
  });
  return appointments;
}

let physicianId: string;
beforeAll(async () => {
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`, [admin.userId]);
  createdYear = Boolean(year.rowCount);
  const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
  const physician = await savePhysicianRevision({ profile: { displayName: "Dr. Test Physician", licenseNumber: "PRC 12345", specialty: "General Medicine", active: true }, signatureBytes, signatureMediaType: "image/png" }, admin);
  physicianId = physician.id;
  createdPhysicians.push(physicianId);
});

afterAll(async () => {
  await cleanupTestFixtures("CERT-%", "CERT-%", "CERT fixture%");
  await transaction(async (client) => {
    await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
    await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=ANY($1::uuid[])", [createdPhysicians]);
    await client.query("DELETE FROM medical_certificate_physicians WHERE id=ANY($1::uuid[])", [createdPhysicians]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
  });
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

describe("atomic examination and certificate issuance", () => {
  it("rejects PE uploads without state changes and requires the full Laboratory checklist", async () => {
    const { peId } = await fixture();
    const studentNumber = `CERT-${String(sequence).padStart(4, "0")}`;
    const storage = { write: vi.fn(), read: vi.fn(), delete: vi.fn() } as unknown as ResultStorage;
    async function snapshot() {
      return (await pool.query(`SELECT
        (SELECT count(*) FROM student_result_submissions) submissions,
        (SELECT count(*) FROM student_result_files) files,
        (SELECT count(*) FROM exam_results) examinations,
        (SELECT count(*) FROM student_result_storage_cleanup_intents) cleanup,
        (SELECT count(*) FROM student_portal_notifications) notifications,
        (SELECT count(*) FROM email_outbox) outbox`)).rows[0];
    }
    const before = await snapshot();
    await expect(getStudentResultSubmission(studentNumber, peId)).rejects.toMatchObject({
      code: "PHYSICAL_EXAM_UPLOAD_RETIRED", status: 422,
    });
    await expect(beginStudentResultEdit(studentNumber, peId, storage)).rejects.toMatchObject({
      code: "PHYSICAL_EXAM_UPLOAD_RETIRED", status: 422,
    });
    await expect(addStudentResultFiles(studentNumber, peId, randomUUID(), [{
      filename: "forged.pdf", declaredMimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7")
    }], storage)).rejects.toMatchObject({ code: "PHYSICAL_EXAM_UPLOAD_RETIRED", status: 422 });
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect((await pool.query("SELECT 1 FROM student_result_submissions WHERE appointment_id=$1", [peId])).rowCount).toBe(0);
    await expect(completePhysicalExam(peId, {
      requestId: randomUUID(), physicianId, physicianVersion: 1,
      examinationDate: "2026-09-23", sex: "Female", classification: "B", remarks: "Vision follow-up",
      lateReason: "Encoding the examination after the scheduled visit", attested: true,
    }, admin)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED", status: 409 });
    expect((await pool.query("SELECT 1 FROM medical_certificate_revisions WHERE appointment_id=$1", [peId])).rowCount).toBe(0);
  });

  it("issues Class B once and returns the same bytes after a lost-response retry", async () => {
    const { labId, peId } = await fixture();
    let checklist = await getLaboratoryChecklist(labId, admin);
    for (const testCode of ["CBC", "URINE", "STOOL"] as const) {
      checklist = await setLaboratoryTestVerification(labId, { testCode, checked: true, expectedVersion: checklist.version }, admin);
    }
    const input = { requestId: randomUUID(), physicianId, physicianVersion: 1,
      examinationDate: "2026-09-23", sex: "Female", classification: "B", remarks: "Vision follow-up",
      lateReason: "Encoding the examination after the scheduled visit", attested: true };
    const first = await completePhysicalExam(peId, input, admin);
    const replay = await completePhysicalExam(peId, input, admin);
    expect(replay).toEqual(first);
    expect(first.certificateId).toMatch(/^[0-9a-f-]{36}$/);
    const state = await pool.query<{ status: string; resultStatus: string; count: number }>(`SELECT appointment.status,
      result.result_status AS "resultStatus",count(revision.id)::int AS count
      FROM appointments appointment JOIN exam_results result ON result.appointment_id=appointment.id
      JOIN medical_certificate_revisions revision ON revision.appointment_id=appointment.id
      WHERE appointment.id=$1 GROUP BY appointment.status,result.result_status`, [peId]);
    expect(state.rows[0]).toMatchObject({ status: "COMPLETED", resultStatus: "COMPLETED", count: 1 });
    const stored = await downloadMedicalCertificate(first.certificateId, { kind: "STUDENT", studentNumber: `CERT-${String(sequence).padStart(4, "0")}` });
    expect((await sharp(stored.bytes).metadata()).format).toBe("jpeg");
    const profile = await getAdminStudentResultProfileRow(`CERT-${String(sequence).padStart(4, "0")}`);
    expect(profile?.certificate).toMatchObject({ id: first.certificateId, status: "ISSUED", classification: "B" });
    expect(profile?.history).toEqual([]);
    const staffDownload = await downloadMedicalCertificate(first.certificateId, { kind: "STAFF", actor: admin });
    expect(staffDownload.bytes).toEqual(stored.bytes);
    await expect(setLaboratoryTestVerification(labId, {
      testCode: "CBC", checked: false, expectedVersion: checklist.version, reason: "Attempted rollback after PE",
    }, admin)).rejects.toMatchObject({ code: "PHYSICAL_ALREADY_COMPLETED", status: 409 });
    await expect(downloadMedicalCertificate(first.certificateId, { kind: "STUDENT", studentNumber: "CERT-OTHER" }))
      .rejects.toMatchObject({ code: "CERTIFICATE_NOT_FOUND", status: 404 });
    await expect(downloadMedicalCertificate(first.certificateId, { kind: "STAFF", actor: {
      userId: TEST_REFERENCE_IDS.clinicStaffUser, fullName: "Clinic Staff", email: "staff@medclinic.local",
      role: "CLINIC_STAFF", clinicId: TEST_REFERENCE_IDS.laboratoryClinic, clinicCode: "KABALAKA_CLINIC",
    } })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(completePhysicalExam(peId, { ...input, remarks: "Changed", requestId: input.requestId }, admin))
      .rejects.toMatchObject({ code: "CLINICAL_REQUEST_CONFLICT", status: 409 });
    const correction = { ...input, requestId: randomUUID(), expectedRevisionId: first.revisionId,
      classification: "C", remarks: "Follow-up examination required", reason: "Physician corrected the finding" };
    const corrected = await correctMedicalCertificate(first.certificateId, correction, admin);
    expect(corrected.revisionId).not.toBe(first.revisionId);
    expect(await correctMedicalCertificate(first.certificateId, correction, admin)).toEqual(corrected);
    const revisions = await pool.query<{ status: string; revisionNumber: number }>(`SELECT status,revision_number AS "revisionNumber"
      FROM medical_certificate_revisions WHERE certificate_id=$1 ORDER BY revision_number`, [first.certificateId]);
    expect(revisions.rows).toMatchObject([{ status: "SUPERSEDED", revisionNumber: 1 }, { status: "ISSUED", revisionNumber: 2 }]);
    const revoked = await revokeMedicalCertificate(first.certificateId, {
      requestId: randomUUID(), expectedRevisionId: corrected.revisionId, reason: "Issued for the wrong visit",
    }, admin);
    expect(revoked.certificateId).toBe(first.certificateId);
    await expect(downloadMedicalCertificate(first.certificateId, { kind: "STUDENT", studentNumber: `CERT-${String(sequence).padStart(4, "0")}` }))
      .rejects.toMatchObject({ code: "CERTIFICATE_REVOKED", status: 410 });
    await expect(setLaboratoryTestVerification(labId, {
      testCode: "CBC", checked: false, expectedVersion: checklist.version,
      reason: "Attempted correction after revoked certificate",
    }, admin)).rejects.toMatchObject({ code: "CERTIFICATE_ALREADY_ISSUED", status: 409 });
    expect((await getLaboratoryChecklist(labId, admin)).verifiedCount).toBe(3);
  });

  it("returns one certificate for two concurrent identical completion requests", async () => {
    const { labId, peId } = await fixture();
    let checklist = await getLaboratoryChecklist(labId, admin);
    for (const testCode of ["CBC", "URINE", "STOOL"] as const) {
      checklist = await setLaboratoryTestVerification(labId,
        { testCode, checked: true, expectedVersion: checklist.version }, admin);
    }
    const input = { requestId: randomUUID(), physicianId, physicianVersion: 1,
      examinationDate: "2026-09-23", sex: "Female", classification: "C", remarks: "Requires follow-up",
      lateReason: "Encoding the examination after the scheduled visit", attested: true };
    const outcomes = await Promise.all([completePhysicalExam(peId, input, admin), completePhysicalExam(peId, input, admin)]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    const stored = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM medical_certificate_revisions WHERE appointment_id=$1", [peId]);
    expect(stored.rows[0].count).toBe(1);
  });
});
