// @vitest-environment node
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestScheduleImportGroup, insertTestStudent, TEST_REFERENCE_IDS as ids } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { linkPublishedLaboratoryAppointments } from "./laboratory-checklist.repository";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "./laboratory-checklist.service";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { loadPhysicalExamCompletionContext } from "@/server/medical-certificates/physical-exam-completion-context.service";
import { completePhysicalExam, previewPhysicalExam, correctMedicalCertificate, previewCertificateCorrection, revokeMedicalCertificate, downloadMedicalCertificate } from "@/server/medical-certificates/certificate.service";
import { savePhysicianRevision } from "@/server/medical-certificates/physician.service";
import * as renderer from "@/server/medical-certificates/certificate-renderer";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { getAppointmentMutationContext, rescheduleAppointmentWithClient, getPublishedAppointment, listAppointments } from "@/server/repositories/appointments.repository";
import { markOverdueAppointmentsNoShow } from "@/server/repositories/appointment-no-show.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import { getStudentResultSubmission } from "@/server/services/student-result-submissions.service";
import { requireStudent, requireVerifiedStudent } from "@/server/auth/current-student";
import { createStudentSessionToken } from "@/server/auth/student-session";

const authState = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: authState.token }) }) }));

const admin: SessionUser = { userId: ids.adminUser, fullName: "Test Admin", email: "admin@medclinic.local", role: "ADMIN" };
const labStaff: SessionUser = { userId: ids.clinicStaffUser, fullName: "Clinic Staff", email: "staff@medclinic.local", role: "CLINIC_STAFF", clinicId: ids.laboratoryClinic };
const cpuId = "97000000-0000-4000-8000-000000000031";
const cpu: SessionUser = { userId: cpuId, fullName: "PE Linked CPU", email: "pe-linked-cpu@test.local", role: "CLINIC_STAFF", clinicId: ids.physicalExamClinic, clinicCode: "CPU_CLINIC", credentialVersion: 1 };
let sequence = 0;
let externalSequence = 0;
let physicianId: string;
let createdYear = false;
type Fixture = { studentNumber: string; labId: string; peId: string };

async function fixture(mode: "OJT" | "FIRST_YEAR" | "STANDARD" = "OJT", category = "REGULAR", year = 4): Promise<Fixture> {
  if (mode === "FIRST_YEAR") {
    const n = ++externalSequence;
    const studentNumber = `89-92${String(n).padStart(2, "0")}-91`;
    const contents = `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth\n${studentNumber},External,PeLinked,Maria,,College of Computer Studies,BSIT,1,2006-01-01`;
    await acceptAndScheduleImport({ fileName: `PELC first-year ${n}.csv`, fileSize: Buffer.byteLength(contents), contents,
      importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR", academicYearStart: 2026,
      preferredMonth: null, firstYearLaboratoryDate: `2026-11-${String(2 + n).padStart(2, "0")}` }, admin);
    const rows = (await pool.query<{ id: string; schedule_type: string }>(
      "SELECT id::text,schedule_type FROM appointments WHERE student_number=$1 AND is_published=TRUE", [studentNumber],
    )).rows;
    return { studentNumber, labId: rows.find((r) => r.schedule_type === "LABORATORY")!.id, peId: rows.find((r) => r.schedule_type === "PHYSICAL_EXAM")!.id };
  }
  const studentNumber = `PELC-${String(++sequence).padStart(4, "0")}`;
  const schedulingCategory = mode === "OJT" ? "OJT" : category;
  await insertTestStudent({ studentNumber, firstName: "PeLinked", lastName: "Student", yearLevel: year, dateOfBirth: "2005-01-01" });
  return transaction(async (client) => {
    const importId = await insertTestScheduleImportGroup(client, { name: "PELC fixture", sourceFilename: `${randomUUID()}.csv`, academicYearStart: 2026, importMode: "STANDARD", actor: admin.userId });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
      VALUES ($1,2026,'PeLinked Student',$2,'College of Computer Studies',$3,'BSIT','BSIT',$4,$5)`, [studentNumber, ids.college, ids.program, year, importId]);
    const pairId = randomUUID();
    const rows = (await client.query<{ id: string; schedule_type: string }>(`INSERT INTO appointments
      (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
      VALUES ($1,$3,'LABORATORY','2026-09-22','PENDING',TRUE,$4,2026,$5,$6,$6),
             ($2,$3,'PHYSICAL_EXAM','2026-09-23','PENDING',TRUE,$4,2026,$5,$6,$6) RETURNING id::text,schedule_type`,
    [ids.laboratoryClinic, ids.physicalExamClinic, studentNumber, pairId, schedulingCategory, admin.userId])).rows;
    const labId = rows.find((r) => r.schedule_type === "LABORATORY")!.id;
    await linkPublishedLaboratoryAppointments(client, [labId]);
    return { studentNumber, labId, peId: rows.find((r) => r.schedule_type === "PHYSICAL_EXAM")!.id };
  });
}

async function manual(f: Fixture, codes: Array<"CBC" | "URINE" | "STOOL"> = ["CBC", "URINE", "STOOL"]) {
  let checklist = await getLaboratoryChecklist(f.labId, admin);
  for (const testCode of codes) checklist = await setLaboratoryTestVerification(f.labId, { testCode, checked: true, expectedVersion: checklist.version }, labStaff);
  return checklist;
}

function input(extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), physicianId, physicianVersion: 1, examinationDate: "2026-12-20", sex: "Female", classification: "A", attested: true, ...extra };
}

async function effects(f: Fixture) {
  return (await pool.query(`SELECT jsonb_build_object(
    'appointments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM appointments a WHERE student_number=$1),
    'checklists',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM laboratory_checklists c WHERE student_number=$1),
    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY test_code) FROM laboratory_checklist_items i JOIN laboratory_checklists c ON c.id=i.checklist_id WHERE c.student_number=$1),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM laboratory_checklist_events e WHERE appointment_id=ANY($2::uuid[])),
    'logs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM appointment_status_logs l WHERE appointment_id=ANY($2::uuid[])),
    'summaries',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM ovpsa_external_laboratory_verifications v WHERE appointment_id=$3),
    'laboratoryResults',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM laboratory_results r WHERE student_number=$1),
    'examResults',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM exam_results r WHERE student_number=$1),
    'certificates',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'sha256',sha256,'snapshot',examination_snapshot) ORDER BY id) FROM medical_certificate_revisions WHERE student_number=$1),
    'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM student_portal_notifications n WHERE student_number=$1),
    'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM email_outbox o WHERE student_number=$1),
    'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_logs a WHERE entity_id=ANY($4::text[])),
    'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM clinical_mutation_requests r WHERE outcome->>'appointmentId'=$5),
    'submissions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM student_result_submissions s WHERE student_number=$1),
    'files',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM student_result_files f JOIN student_result_submissions s ON s.id=f.submission_id WHERE s.student_number=$1)
  ) AS state`, [f.studentNumber, [f.labId, f.peId], f.labId, [f.labId, f.peId], f.peId])).rows[0].state;
}

async function replaceLaboratory(f: Fixture) {
  return transaction(async (client) => {
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: f.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: f.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const current = await getAppointmentMutationContext(f.labId, client);
    if (!current) throw new Error("Missing Laboratory fixture");
    return rescheduleAppointmentWithClient(client, current, "2026-09-22", "Synthetic replacement", admin.userId);
  });
}

function pauseAfterRendering(expectedRenders = 1) {
  const original = renderer.renderMedicalCertificate;
  let reached!: () => void;
  let resume!: () => void;
  const rendered = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  let count = 0;
  vi.spyOn(renderer, "renderMedicalCertificate").mockImplementation(async (...args) => {
    const bytes = await original(...args);
    if (++count === expectedRenders) reached();
    await released;
    return bytes;
  });
  return { rendered, resume };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-20T04:00:00Z"));
  createdYear = Boolean((await pool.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
    VALUES(2026,'2027-07-31',$1,$1) ON CONFLICT DO NOTHING RETURNING start_year`, [admin.userId])).rowCount);
  await pool.query(`INSERT INTO users(id,full_name,email,password_hash,role,clinic_id,email_verified_at,must_change_password)
    VALUES($1,'PE Linked CPU','pe-linked-cpu@test.local','fixture','CLINIC_STAFF',$2,clock_timestamp(),FALSE)`, [cpuId, ids.physicalExamClinic]);
  const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
  physicianId = (await savePhysicianRevision({ profile: { displayName: "Dr. PE Linked", licenseNumber: "PRC PE Linked", specialty: "General Medicine", active: true }, signatureBytes, signatureMediaType: "image/png" }, admin)).id;
});
afterEach(() => { authState.token = ""; vi.restoreAllMocks(); });
afterAll(async () => {
  vi.useRealTimers();
  await cleanupTestFixtures("PELC-%", "PELC-%", "PELC fixture%");
  await cleanupTestFixtures("89-92%-91", "PELC-%");
  await transaction(async (client) => {
    await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
    await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [physicianId]);
    await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [physicianId]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
  });
  await pool.query("DELETE FROM users WHERE id=$1", [cpuId]);
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

describe("PE-linked external Laboratory confirmation", () => {
  it("shows saved First-Year confirmation in staff/student readers without creating upload work", async () => {
    const f = await fixture("FIRST_YEAR");
    expect((await getPublishedAppointment(f.labId))?.displayStatus).toBe("Awaiting confirmation at Physical Examination");
    const staff = await listAppointments({ scheduleType: "LABORATORY", studentNumber: f.studentNumber,
      isPublished: true, page: 1, limit: 150, offset: 0 });
    expect(staff.items.find((row) => row.id === f.labId)?.displayStatus).toBe("Awaiting confirmation at Physical Examination");
    const student = await getStudentPortalSchedule(f.studentNumber);
    expect(student?.emailVerifiedAt).toBeNull();
    expect(student?.appointments.find((row) => row.id === f.labId)?.displayStatus).toBe("Awaiting confirmation at Physical Examination");
    const issued = await completePhysicalExam(f.peId, input(), cpu);
    expect((await getPublishedAppointment(f.labId))?.displayStatus).toBe("COMPLETED");
    expect((await getStudentPortalSchedule(f.studentNumber))?.appointments.map((row) => row.status)).toEqual(["COMPLETED", "COMPLETED"]);
    const saved = await effects(f);
    expect(saved.submissions).toBeNull(); expect(saved.files).toBeNull();
    const jpeg = await downloadMedicalCertificate(issued.certificateId, { kind: "STUDENT", studentNumber: f.studentNumber });
    expect(jpeg.bytes).toEqual((await pool.query("SELECT jpeg_bytes FROM medical_certificate_revisions WHERE id=$1", [issued.revisionId])).rows[0].jpeg_bytes);
    await expect(downloadMedicalCertificate(issued.certificateId, { kind: "STUDENT", studentNumber: "wrong-student" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps OJT clinical completion separate from verified student document access", async () => {
    const f = await fixture();
    await manual(f); await completePhysicalExam(f.peId, input(), cpu);
    const saved = await effects(f);
    expect(saved.laboratoryResults[0].result_status).toBe("PENDING_UPLOAD");
    expect(saved.submissions).toBeNull(); expect(saved.files).toBeNull();
    authState.token = await createStudentSessionToken({ studentNumber: f.studentNumber, sessionType: "STUDENT" });
    expect(await requireStudent()).toMatchObject({ studentNumber: f.studentNumber, emailVerifiedAt: null });
    await expect(requireVerifiedStudent()).rejects.toMatchObject({ code: "STUDENT_EMAIL_VERIFICATION_REQUIRED" });
    expect(await effects(f)).toEqual(saved);
    await expect(getStudentResultSubmission("wrong-student", f.labId)).rejects.toMatchObject({ status: 404 });
  });

  it("confirms only the effective replacement and keeps its immutable OJT requirements", async () => {
    const f = await fixture();
    const original = await manual(f);
    const replacementId = await replaceLaboratory(f);
    await pool.query("UPDATE students SET year_level=2 WHERE student_number=$1", [f.studentNumber]);
    await expect(getLaboratoryChecklist(f.labId, admin)).rejects.toMatchObject({ code: "APPOINTMENT_NOT_FOUND" });
    const replacement = await getLaboratoryChecklist(replacementId, admin);
    expect(replacement).toMatchObject({ checklistId: original.checklistId, version: original.version, verifiedCount: 3,
      completionPolicy: { mode: "FOURTH_YEAR_OJT" } });
    const issued = await completePhysicalExam(f.peId, input(), cpu);
    expect((await pool.query("SELECT status FROM appointments WHERE id=$1", [f.labId])).rows[0].status).toBe("RESCHEDULED");
    expect((await getLaboratoryChecklist(replacementId, admin)).appointmentStatus).toBe("COMPLETED");
    expect((await pool.query("SELECT appointment_id::text FROM laboratory_checklist_events WHERE test_code='XRAY' AND checklist_id=$1", [original.checklistId])).rows).toEqual([{ appointment_id: replacementId }]);
    expect((await pool.query("SELECT examination_snapshot FROM medical_certificate_revisions WHERE id=$1", [issued.revisionId])).rows[0].examination_snapshot.laboratoryAppointmentId).toBe(replacementId);
  });

  it.each(["uncheck", "replace"] as const)("rejects stale issuance when %s changes Laboratory after rendering", async (change) => {
    const f = await fixture();
    const checklist = await manual(f);
    const barrier = pauseAfterRendering();
    const issuance = completePhysicalExam(f.peId, input(), cpu);
    await barrier.rendered;
    try {
      if (change === "uncheck") await setLaboratoryTestVerification(f.labId, { testCode: "CBC", checked: false,
        expectedVersion: checklist.version, reason: "Correcting the recorded manual finding" }, labStaff);
      else await replaceLaboratory(f);
      const beforeCommit = await effects(f);
      barrier.resume();
      await expect(issuance).rejects.toMatchObject({ code: "EXAMINATION_STALE" });
      expect(await effects(f)).toEqual(beforeCommit);
    } finally { barrier.resume(); }
  });

  it.each([true, false])("serializes concurrent completion requests (same request: %s)", async (sameRequest) => {
    const f = await fixture("FIRST_YEAR");
    const notificationsBefore = (await effects(f)).notifications?.length ?? 0;
    const first = input();
    const barrier = pauseAfterRendering(2);
    const requests = Promise.allSettled([completePhysicalExam(f.peId, first, cpu),
      completePhysicalExam(f.peId, sameRequest ? first : input(), cpu)]);
    await barrier.rendered;
    barrier.resume();
    const outcomes = await requests;
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(successes).toHaveLength(sameRequest ? 2 : 1);
    if (sameRequest) expect(outcomes[0]).toEqual(outcomes[1]);
    else expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { code: "EXAMINATION_STALE" } });
    const saved = await effects(f);
    expect(saved.events).toHaveLength(4);
    expect(saved.summaries).toHaveLength(1);
    expect(saved.certificates).toHaveLength(1);
    expect(saved.examResults).toHaveLength(1);
    expect(saved.notifications).toHaveLength(notificationsBefore + 1);
    expect(saved.checklists[0].version).toBe(2);
  });

  it("rejects a First-Year PE paired to another revision's reservations before confirmation", async () => {
    const f = await fixture("FIRST_YEAR");
    const other = await fixture("FIRST_YEAR");
    await pool.query(`UPDATE appointments SET ovpsa_batch_id=o.ovpsa_batch_id,ovpsa_revision_id=o.ovpsa_revision_id,
      ovpsa_service_reservation_id=o.ovpsa_service_reservation_id FROM appointments o WHERE appointments.id=$1 AND o.id=$2`, [f.peId, other.peId]);
    const before = await effects(f);
    await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "LABORATORY_PROVENANCE_MISSING" });
    expect(await effects(f)).toEqual(before);
  });

  it("protects recorded OJT progress from a concurrent automatic no-show sweep", async () => {
    const f = await fixture();
    await Promise.all([markOverdueAppointmentsNoShow(new Date("2026-12-20T04:00:00Z"), "Asia/Manila"),
      setLaboratoryTestVerification(f.labId, { testCode: "CBC", checked: true, expectedVersion: 1,
        reason: "The student attended; correct an automatic no-show if it raced this verification" }, labStaff)]);
    expect(await getLaboratoryChecklist(f.labId, admin)).toMatchObject({ appointmentStatus: "PENDING", verifiedCount: 1 });
    await markOverdueAppointmentsNoShow(new Date("2026-12-20T04:00:00Z"), "Asia/Manila");
    expect((await getLaboratoryChecklist(f.labId, admin)).appointmentStatus).toBe("PENDING");
  });

  it("retains status-only completion constraints and the unique external summary", async () => {
    const ojt = await fixture();
    await manual(ojt);
    await expect(pool.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [ojt.labId])).rejects.toMatchObject({ code: "23514" });
    const external = await fixture("FIRST_YEAR");
    await expect(pool.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [external.labId])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [external.peId])).rejects.toMatchObject({ code: "23514" });
    await completePhysicalExam(external.peId, input(), cpu);
    await expect(pool.query(`INSERT INTO ovpsa_external_laboratory_verifications(appointment_id,batch_id,revision_id,external_provider,verified_by)
      SELECT appointment_id,batch_id,revision_id,external_provider,verified_by FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1`, [external.labId])).rejects.toMatchObject({ code: "23505" });
  });

  it.each(["CBC", "URINE", "STOOL"] as const)("blocks PE while manual %s is missing, without side effects", async (missing) => {
    const f = await fixture();
    await manual(f, (["CBC", "URINE", "STOOL"] as const).filter((c) => c !== missing));
    const before = await effects(f);
    const context = await loadPhysicalExamCompletionContext(f.peId, cpu);
    expect(context.laboratoryCompletion.missingManualTestCodes).toEqual([missing]);
    expect(context.laboratoryReady).toBe(false);
    expect(context.blockers.join(" ").toUpperCase()).toContain(missing === "URINE" ? "URINE" : missing === "STOOL" ? "STOOL" : "CBC");
    await expect(previewPhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED" });
    await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED" });
    expect(await effects(f)).toEqual(before);
  });

  it("readies OJT at 3/4, previews without writes, and preserves the manual verifier on issuance", async () => {
    const f = await fixture();
    const beforeChecklist = await manual(f);
    const context = await loadPhysicalExamCompletionContext(f.peId, cpu);
    expect(context.laboratoryReady).toBe(true);
    expect(context.laboratoryCompletion).toMatchObject({ laboratoryAppointmentId: f.labId, laboratoryCompleted: false,
      readyForPe: true, missingManualTestCodes: [], completionPolicy: { mode: "FOURTH_YEAR_OJT" } });
    expect(context.blockers).toEqual([]);
    const before = await effects(f);
    expect((await sharp(await previewPhysicalExam(f.peId, input(), cpu)).metadata()).format).toBe("jpeg");
    expect(await effects(f)).toEqual(before);
    const request = input();
    const issued = await completePhysicalExam(f.peId, request, cpu);
    const after = await getLaboratoryChecklist(f.labId, admin);
    expect(after).toMatchObject({ verifiedCount: 4, totalCount: 4, version: beforeChecklist.version + 1, appointmentStatus: "COMPLETED" });
    expect(after.items.slice(0, 3)).toEqual(beforeChecklist.items.slice(0, 3));
    expect(after.items[3]).toMatchObject({ testCode: "XRAY", verificationSource: "EXTERNAL", verifiedBy: cpuId });
    const snapshot = (await pool.query("SELECT examination_snapshot FROM medical_certificate_revisions WHERE id=$1", [issued.revisionId])).rows[0].examination_snapshot;
    expect(snapshot).toMatchObject({ laboratoryAppointmentId: f.labId, checklistVersion: 5, laboratoryCompletion: {
      mode: "FOURTH_YEAR_OJT", checklistId: after.checklistId, checklistVersionBefore: 4, checklistVersionAfter: 5,
      automaticallyVerifiedTestCodes: ["XRAY"], externalProvider: "Iloilo Mission Hospital" } });
    const event = (await pool.query("SELECT source,reason,actor_user_id FROM laboratory_checklist_events WHERE appointment_id=$1 AND test_code='XRAY'", [f.labId])).rows;
    expect(event).toEqual([{ source: "EXTERNAL", reason: "Iloilo Mission Hospital test confirmed during CPU Physical Examination.", actor_user_id: cpuId }]);
    expect((await pool.query("SELECT result_status FROM laboratory_results WHERE appointment_id=$1", [f.labId])).rows[0].result_status).toBe("PENDING_UPLOAD");
    expect((await pool.query("SELECT 1 FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [f.labId])).rowCount).toBe(0);
    const saved = await effects(f);
    expect(await completePhysicalExam(f.peId, request, cpu)).toEqual(issued);
    expect(await effects(f)).toEqual(saved);
    await expect(completePhysicalExam(f.peId, { ...request, sex: "Male" }, cpu)).rejects.toMatchObject({ code: "CLINICAL_REQUEST_CONFLICT" });
    const jpeg = await downloadMedicalCertificate(issued.certificateId, { kind: "STUDENT", studentNumber: f.studentNumber });
    expect((await sharp(jpeg.bytes).metadata()).format).toBe("jpeg");
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='LABORATORY_EXTERNAL_CONFIRMED_DURING_PE' AND entity_id=$1", [f.labId])).rows[0].count).toBe(1);
  });

  it("readies First-Year at 0/4 without a summary and atomically saves four EXTERNAL tests and a result", async () => {
    const f = await fixture("FIRST_YEAR");
    const checklist = await getLaboratoryChecklist(f.labId, admin);
    expect(checklist).toMatchObject({ verifiedCount: 0, totalCount: 4, appointmentStatus: "PENDING" });
    const context = await loadPhysicalExamCompletionContext(f.peId, cpu);
    expect(context.laboratoryReady).toBe(true);
    expect(context.laboratoryCompletion).toMatchObject({ laboratoryCompleted: false, readyForPe: true,
      completionPolicy: { mode: "FIRST_YEAR_EXTERNAL", manualTestCodes: [] } });
    const before = await effects(f);
    await previewPhysicalExam(f.peId, input({ classification: "B", remarks: "Physician follow-up finding" }), cpu);
    expect(await effects(f)).toEqual(before);
    const request = input({ classification: "B", remarks: "Physician follow-up finding" });
    const issued = await completePhysicalExam(f.peId, request, cpu);
    const after = await getLaboratoryChecklist(f.labId, admin);
    expect(after).toMatchObject({ verifiedCount: 4, totalCount: 4, appointmentStatus: "COMPLETED", version: 2 });
    expect(after.items.every((i) => i.verifiedBy === cpuId && i.verificationSource === "EXTERNAL")).toBe(true);
    const rows = (await pool.query("SELECT verified_by,external_provider FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [f.labId])).rows;
    expect(rows).toEqual([{ verified_by: cpuId, external_provider: "Iloilo Mission Hospital" }]);
    const result = (await pool.query("SELECT result_status,completed_at::text FROM laboratory_results WHERE appointment_id=$1", [f.labId])).rows[0];
    const confirmationDate = (await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS date")).rows[0].date;
    expect(result).toEqual({ result_status: "COMPLETED", completed_at: confirmationDate });
    expect((await pool.query("SELECT 1 FROM student_result_submissions WHERE student_number=$1", [f.studentNumber])).rowCount).toBe(0);
    const saved = await effects(f);
    expect(await completePhysicalExam(f.peId, request, cpu)).toEqual(issued);
    expect(await effects(f)).toEqual(saved);
    expect(saved.appointments.map((a: { status: string }) => a.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it.each(["REGULAR", "TOUR"])("preserves the ordinary completed-Laboratory gate for fourth-year %s", async (category) => {
    const f = await fixture("STANDARD", category);
    const before = await effects(f);
    await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED" });
    expect(await effects(f)).toEqual(before);
    await manual(f);
    const laboratory = await getLaboratoryChecklist(f.labId, admin);
    await completePhysicalExam(f.peId, input(), cpu);
    expect(await getLaboratoryChecklist(f.labId, admin)).toEqual(laboratory);
  });

  it("keeps external eligibility from the snapshot after the student's live year changes", async () => {
    const f = await fixture();
    await manual(f);
    await pool.query("UPDATE students SET year_level=2 WHERE student_number=$1", [f.studentNumber]);
    expect((await loadPhysicalExamCompletionContext(f.peId, cpu)).laboratoryCompletion.completionPolicy.mode).toBe("FOURTH_YEAR_OJT");
    await completePhysicalExam(f.peId, input(), cpu);
    expect((await getLaboratoryChecklist(f.labId, admin)).verifiedCount).toBe(4);
  });

  it.each(["B", "C", "D"])("confirms the hospital test for Class %s while requiring remarks", async (classification) => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    await expect(completePhysicalExam(f.peId, input({ classification }), cpu)).rejects.toHaveProperty("issues");
    expect(await effects(f)).toEqual(before);
    await completePhysicalExam(f.peId, input({ classification, remarks: "Physician recorded follow-up" }), cpu);
    expect((await getLaboratoryChecklist(f.labId, admin)).items[3].verificationSource).toBe("EXTERNAL");
  });

  it("leaves every side effect untouched when rendering fails", async () => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    vi.spyOn(renderer, "renderMedicalCertificate").mockRejectedValueOnce(new Error("synthetic renderer failure"));
    await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toThrow("synthetic renderer failure");
    expect(await effects(f)).toEqual(before);
  });

  it("rolls confirmation back when the subsequent certificate insert fails", async () => {
    const f = await fixture("FIRST_YEAR");
    const before = await effects(f);
    await pool.query(`CREATE FUNCTION pelc_fail_certificate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic final-write failure'; END $$;
      CREATE TRIGGER pelc_fail_certificate BEFORE INSERT ON medical_certificate_revisions FOR EACH ROW EXECUTE FUNCTION pelc_fail_certificate()`);
    try {
      await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toThrow("synthetic final-write failure");
      expect(await effects(f)).toEqual(before);
    } finally { await pool.query("DROP TRIGGER pelc_fail_certificate ON medical_certificate_revisions; DROP FUNCTION pelc_fail_certificate()"); }
  });

  it.each([
    { actor: labStaff, code: "FORBIDDEN" },
    { actor: { ...admin, userId: ids.coordinatorUser, role: "ADMIN" as const }, code: "FORBIDDEN" },
    { actor: { ...cpu, credentialVersion: 99 }, code: "SESSION_EXPIRED" },
    { actor: { ...cpu, userId: randomUUID() }, code: "SESSION_EXPIRED" },
  ])("rejects current database authority or expired identities: $code", async ({ actor, code }) => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    await expect(completePhysicalExam(f.peId, input(), actor)).rejects.toMatchObject({ code });
    expect(await effects(f)).toEqual(before);
  });

  it("rejects unonboarded CPU staff before any external writes", async () => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    await pool.query("UPDATE users SET must_change_password=TRUE WHERE id=$1", [cpuId]);
    try {
      await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await effects(f)).toEqual(before);
    } finally { await pool.query("UPDATE users SET must_change_password=FALSE WHERE id=$1", [cpuId]); }
  });

  it("rejects first-year appointments without OVPSA provenance without writes", async () => {
    const f = await fixture("STANDARD", "REGULAR", 1);
    const before = await effects(f);
    await expect(loadPhysicalExamCompletionContext(f.peId, cpu)).rejects.toMatchObject({ code: "LABORATORY_PROVENANCE_MISSING" });
    await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "LABORATORY_PROVENANCE_MISSING" });
    expect(await effects(f)).toEqual(before);
  });

  it("rejects a closed cycle and inactive physician without partial confirmation", async () => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    await pool.query("UPDATE academic_years SET closing_date='2026-12-19' WHERE start_year=2026");
    try {
      await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "ACADEMIC_YEAR_ENDED" });
      expect(await effects(f)).toEqual(before);
    } finally { await pool.query("UPDATE academic_years SET closing_date='2027-07-31' WHERE start_year=2026"); }
    await pool.query("UPDATE medical_certificate_physicians SET active=FALSE WHERE id=$1", [physicianId]);
    try {
      await expect(completePhysicalExam(f.peId, input(), cpu)).rejects.toMatchObject({ code: "PHYSICIAN_STALE" });
      expect(await effects(f)).toEqual(before);
    } finally { await pool.query("UPDATE medical_certificate_physicians SET active=TRUE WHERE id=$1", [physicianId]); }
  });

  it.each([
    { examinationDate: "2026-12-21", code: "EXAMINATION_DATE_INVALID" },
    { examinationDate: "2026-09-21", lateReason: "Synthetic late visit", code: "EXAMINATION_DATE_INVALID" },
    { physicianId: "97000000-0000-4000-8000-000000000099", code: "PHYSICIAN_STALE" },
  ])("rejects invalid dates or physicians without partial confirmation: $code", async ({ code, ...extra }) => {
    const f = await fixture();
    await manual(f);
    const before = await effects(f);
    await expect(completePhysicalExam(f.peId, input(extra), cpu)).rejects.toMatchObject({ code });
    expect(await effects(f)).toEqual(before);
  });

  it("preserves Laboratory evidence and its initial linkage through correction preview, correction and revocation", async () => {
    const f = await fixture("FIRST_YEAR");
    const issued = await completePhysicalExam(f.peId, input(), cpu);
    const before = await effects(f);
    const correction = input({ requestId: randomUUID(), expectedRevisionId: issued.revisionId,
      classification: "C", remarks: "Follow-up required", reason: "Physician corrected the finding" });
    await previewCertificateCorrection(issued.certificateId, correction, cpu);
    expect(await effects(f)).toEqual(before);
    const corrected = await correctMedicalCertificate(issued.certificateId, correction, cpu);
    const snapshots = (await pool.query("SELECT examination_snapshot FROM medical_certificate_revisions WHERE certificate_id=$1 ORDER BY revision_number", [issued.certificateId])).rows;
    expect(snapshots[1].examination_snapshot.laboratoryCompletion).toEqual(snapshots[0].examination_snapshot.laboratoryCompletion);
    expect(snapshots[1].examination_snapshot.laboratoryCompletion.automaticallyVerifiedTestCodes).toEqual(["CBC", "URINE", "STOOL", "XRAY"]);
    await revokeMedicalCertificate(issued.certificateId, { requestId: randomUUID(), expectedRevisionId: corrected.revisionId, reason: "Wrong visit selected" }, admin);
    const after = await effects(f);
    for (const key of ["checklists", "items", "events", "summaries", "laboratoryResults"]) expect(after[key]).toEqual(before[key]);
    expect((await getLaboratoryChecklist(f.labId, admin)).appointmentStatus).toBe("COMPLETED");
  });
});
