import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { manilaCalendarDate } from "@/lib/academic-year";
import { AppError } from "@/lib/errors";
import { ageOn } from "@/lib/medical-certificate-age";
import { assertOpenAppointmentCycle } from "@/server/appointments/academic-year-visibility";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { pool } from "@/server/db/pool";
import { loadLaboratoryChecklist } from "@/server/laboratory/laboratory-checklist.repository";
import { certificateCompletionSchema, certificateCorrectionSchema, certificateRevocationSchema,
  type CertificateCompletionInput, type CertificateCorrectionInput } from "@/server/medical-certificates/certificate-schema";
import { CERTIFICATE_TEMPLATE_VERSION, renderMedicalCertificate, type CertificateRenderSnapshot } from "@/server/medical-certificates/certificate-renderer";
import { changeAppointmentStatusWithClient, getAppointmentMutationContext, getAppointmentMutationScope } from "@/server/repositories/appointments.repository";
import { resolveEffectiveAppointmentPair } from "@/server/repositories/effective-appointment-pair.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import { createStudentNotification } from "@/server/services/student-notifications.service";
import type { SessionUser } from "@/types/roles";

type Outcome = { certificateId: string; revisionId: string; appointmentId: string; certificateNumber: string };
type Context = {
  appointmentId: string;
  appointmentUpdatedAt: string;
  studentNumber: string;
  cycleStart: number;
  checklistVersion: number;
  physicianRevisionId: string;
  render: CertificateRenderSnapshot;
  studentSnapshot: Record<string, unknown>;
  examinationSnapshot: Record<string, unknown>;
  physicianSnapshot: Record<string, unknown>;
  actorName: string;
};

function payloadHash(appointmentId: string, input: CertificateCompletionInput) {
  return createHash("sha256").update(JSON.stringify({ appointmentId, ...input })).digest("hex");
}

export async function currentCpuActor(client: PoolClient, actor: SessionUser) {
  const row = (await client.query<{ role: string; clinicId: string | null; fullName: string; credentialVersion: number; verified: boolean; mustChangePassword: boolean }>(
    `SELECT role,clinic_id::text AS "clinicId",full_name AS "fullName",
            credential_version AS "credentialVersion",email_verified_at IS NOT NULL AS verified,
            must_change_password AS "mustChangePassword"
       FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, [actor.userId],
  )).rows[0];
  if (!row || (actor.credentialVersion !== undefined && row.credentialVersion !== actor.credentialVersion)) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  const cpu = (await client.query<{ id: string }>("SELECT id::text FROM clinics WHERE code='CPU_CLINIC'")).rows[0];
  if (!row.verified || row.mustChangePassword || (row.role !== "ADMIN"
      && (row.role !== "CLINIC_STAFF" || row.clinicId !== cpu?.id))) {
    throw new AppError("FORBIDDEN", "Only the CPU Clinic or an Administrator can complete examinations.", 403);
  }
  return { ...row, cpuClinicId: cpu?.id };
}

async function replayRequest<T>(client: PoolClient, actor: SessionUser, requestId: string,
  action: "ISSUE_CERTIFICATE" | "CORRECT_CERTIFICATE" | "REVOKE_CERTIFICATE", hash: string): Promise<T | null> {
  const prior = (await client.query<{ action: string; payloadHash: string; outcome: Outcome }>(`SELECT action,
    payload_hash AS "payloadHash",outcome FROM clinical_mutation_requests
    WHERE actor_user_id=$1 AND request_id=$2 FOR UPDATE`, [actor.userId, requestId])).rows[0];
  if (!prior) return null;
  if (prior.action !== action || prior.payloadHash !== hash) {
    throw new AppError("CLINICAL_REQUEST_CONFLICT", "This request ID was already used with different details.", 409);
  }
  return prior.outcome as T;
}

async function clinicalContext(client: PoolClient, appointmentId: string, input: CertificateCompletionInput,
  actor: SessionUser, certificateNumber: string, mode: "issue" | "correct" = "issue"): Promise<Context> {
  const current = await currentCpuActor(client, actor);
  const anchor = (await client.query<{ id: string; studentNumber: string; scheduleType: string; schedulePairId: string | null; scheduleCycleStart: number }>(
    `SELECT id::text,student_number AS "studentNumber",schedule_type AS "scheduleType",
            schedule_pair_id::text AS "schedulePairId",schedule_cycle_start AS "scheduleCycleStart"
       FROM appointments WHERE id=$1 AND is_published=TRUE`, [appointmentId],
  )).rows[0];
  if (!anchor || anchor.scheduleType !== "PHYSICAL_EXAM") {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
  }
  const pair = await resolveEffectiveAppointmentPair(client, anchor);
  const appointment = await getAppointmentMutationContext(appointmentId, client);
  if (!appointment || appointment.scheduleType !== "PHYSICAL_EXAM" || appointment.clinicId !== current.cpuClinicId) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
  }
  if (mode === "correct" ? appointment.status !== "COMPLETED"
    : appointment.status !== "PENDING" && (appointment.status !== "NO_SHOW" || !isAutomaticNoShowLog(appointment.latestLog))) {
    throw new AppError("EXAMINATION_NOT_PENDING", "This examination cannot be completed.", 409);
  }
  await assertOpenAppointmentCycle(client, appointment.scheduleCycleStart, new Date());
  const today = manilaCalendarDate(new Date());
  const year = (await client.query<{ closingDate: string }>("SELECT closing_date::text AS \"closingDate\" FROM academic_years WHERE start_year=$1", [appointment.scheduleCycleStart])).rows[0];
  if (input.examinationDate > today || input.examinationDate < `${appointment.scheduleCycleStart}-08-01`
      || input.examinationDate > year.closingDate) {
    throw new AppError("EXAMINATION_DATE_INVALID", "The examination date must fall within the open academic year and cannot be in the future.", 422);
  }
  if (mode === "issue" && (input.examinationDate < today || appointment.status === "NO_SHOW") && !input.lateReason?.trim()) {
    throw new AppError("LATE_EXAMINATION_REASON_REQUIRED", "Enter a reason for late examination encoding.", 422);
  }
  if (pair.physicalExam?.id !== appointmentId || !pair.laboratory || pair.laboratory.status !== "COMPLETED") {
    throw new AppError("LABORATORY_NOT_COMPLETED", "The effective Laboratory checklist must be complete first.", 409);
  }
  if (input.examinationDate < pair.laboratory.appointmentDate) {
    throw new AppError("EXAMINATION_DATE_INVALID", "The examination cannot predate Laboratory.", 422);
  }
  const checklist = await loadLaboratoryChecklist(client, pair.laboratory.id, true);
  if (!checklist || checklist.verifiedCount !== checklist.totalCount || !checklist.totalCount) {
    throw new AppError("LABORATORY_NOT_COMPLETED", "The effective Laboratory checklist must be complete first.", 409);
  }
  const external = await client.query<{ ovpsaBatchId: string | null }>(
    "SELECT ovpsa_batch_id::text AS \"ovpsaBatchId\" FROM appointments WHERE id=$1", [pair.laboratory.id]);
  if (external.rows[0]?.ovpsaBatchId) {
    const verified = await client.query("SELECT 1 FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [pair.laboratory.id]);
    if (!verified.rowCount) throw new AppError("LABORATORY_NOT_COMPLETED", "External Laboratory verification is incomplete.", 409);
  }
  const student = (await client.query<{ studentName: string; collegeName: string; programName: string; yearLevel: number; dateOfBirth: string | null }>(
    `SELECT snapshot.student_name AS "studentName",snapshot.college_name AS "collegeName",
            snapshot.program_name AS "programName",snapshot.year_level AS "yearLevel",
            student.date_of_birth::text AS "dateOfBirth"
       FROM student_academic_snapshots snapshot
       JOIN students student ON student.student_number=snapshot.student_number
      WHERE snapshot.student_number=$1 AND snapshot.academic_year_start=$2`,
    [appointment.studentNumber, appointment.scheduleCycleStart],
  )).rows[0];
  if (!student) throw new AppError("ACADEMIC_SNAPSHOT_MISSING", "The academic snapshot is missing.", 409);
  if (!student.dateOfBirth) throw new AppError("STUDENT_DOB_REQUIRED", "Record the student's date of birth before issuing a certificate.", 422);
  if (student.studentName.length > 200) throw new AppError("CERTIFICATE_LAYOUT_OVERFLOW", "The student name exceeds the certificate limit.", 422);
  const age = ageOn(student.dateOfBirth, input.examinationDate);
  if (age < 0 || age > 125) throw new AppError("STUDENT_DOB_INVALID", "The student date of birth is invalid for this examination.", 422);
  const physician = (await client.query<{ revisionId: string; displayName: string; licenseNumber: string; specialty: string | null; signatureBytes: Buffer }>(
    `SELECT revision.id::text AS "revisionId",revision.display_name AS "displayName",
            revision.license_number AS "licenseNumber",revision.specialty,
            revision.signature_bytes AS "signatureBytes"
       FROM medical_certificate_physicians profile
       JOIN medical_certificate_physician_revisions revision
         ON revision.physician_id=profile.id AND revision.version=profile.version
      WHERE profile.id=$1 AND profile.version=$2 AND profile.active=TRUE
      FOR SHARE OF profile`,
    [input.physicianId, input.physicianVersion],
  )).rows[0];
  if (!physician) throw new AppError("PHYSICIAN_STALE", "The selected physician profile changed. Refresh the form.", 409);
  return {
    appointmentId, appointmentUpdatedAt: appointment.updatedAt.toISOString(),
    studentNumber: appointment.studentNumber, cycleStart: appointment.scheduleCycleStart,
    checklistVersion: checklist.version, physicianRevisionId: physician.revisionId,
    render: { certificateNumber, studentName: student.studentName, studentNumber: appointment.studentNumber,
      collegeName: student.collegeName, programName: student.programName, yearLevel: student.yearLevel,
      age, sex: input.sex, examinationDate: input.examinationDate, classification: input.classification,
      remarks: input.remarks ?? null, physicianName: physician.displayName,
      physicianLicense: physician.licenseNumber, physicianSpecialty: physician.specialty,
      signatureBytes: physician.signatureBytes },
    studentSnapshot: { name: student.studentName, studentNumber: appointment.studentNumber,
      collegeName: student.collegeName, programName: student.programName,
      yearLevel: student.yearLevel, dateOfBirth: student.dateOfBirth, age, sex: input.sex },
    examinationSnapshot: { examinationDate: input.examinationDate, classification: input.classification,
      remarks: input.remarks ?? null, laboratoryAppointmentId: pair.laboratory.id,
      checklistVersion: checklist.version, certificateNumber },
    physicianSnapshot: { name: physician.displayName, licenseNumber: physician.licenseNumber,
      specialty: physician.specialty, revisionId: physician.revisionId },
    actorName: current.fullName,
  };
}

function sameContext(first: Context, second: Context) {
  return first.appointmentUpdatedAt === second.appointmentUpdatedAt
    && first.checklistVersion === second.checklistVersion
    && first.physicianRevisionId === second.physicianRevisionId
    && JSON.stringify(first.studentSnapshot) === JSON.stringify(second.studentSnapshot)
    && JSON.stringify(first.examinationSnapshot) === JSON.stringify(second.examinationSnapshot);
}

export async function previewPhysicalExam(appointmentId: string, raw: unknown, actor: SessionUser) {
  const input = certificateCompletionSchema.parse(raw);
  const context = await transaction((client) => clinicalContext(client, appointmentId, input, actor, "PREVIEW ONLY"));
  return renderMedicalCertificate(context.render, "preview");
}

export async function completePhysicalExam(appointmentId: string, raw: unknown, actor: SessionUser): Promise<Outcome> {
  const input = certificateCompletionSchema.parse(raw);
  const hash = payloadHash(appointmentId, input);
  const replay = await transaction(async (client) => {
    await currentCpuActor(client, actor);
    return replayRequest<Outcome>(client, actor, input.requestId, "ISSUE_CERTIFICATE", hash);
  });
  if (replay) return replay;
  const certificateId = randomUUID();
  const certificateNumber = `MC-${input.examinationDate.slice(0, 4)}-${certificateId.slice(0, 8).toUpperCase()}`;
  const prepared = await transaction((client) => clinicalContext(client, appointmentId, input, actor, certificateNumber));
  const jpeg = await renderMedicalCertificate(prepared.render, "issued");
  const digest = createHash("sha256").update(jpeg).digest("hex");
  return transaction(async (client) => {
    await currentCpuActor(client, actor);
    const existing = await replayRequest<Outcome>(client, actor, input.requestId, "ISSUE_CERTIFICATE", hash);
    if (existing) return existing;
    const scope = await getAppointmentMutationScope(appointmentId, client);
    if (!scope) throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const current = await clinicalContext(client, appointmentId, input, actor, certificateNumber);
    if (!sameContext(prepared, current)) {
      throw new AppError("EXAMINATION_STALE", "The appointment or clinical record changed. Refresh and preview again.", 409);
    }
    const revisionId = randomUUID();
    await client.query(`INSERT INTO medical_certificate_revisions
      (id,certificate_id,appointment_id,student_number,academic_year_start,
       revision_number,status,physician_revision_id,student_snapshot,examination_snapshot,
       physician_snapshot,classification,remarks,examination_date,sex,template_version,
       jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,request_id)
       VALUES ($1,$2,$3,$4,$5,1,'ISSUED',$6,$7::jsonb,$8::jsonb,$9::jsonb,
         $10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)`,
    [revisionId, certificateId, appointmentId, current.studentNumber, current.cycleStart,
      current.physicianRevisionId, JSON.stringify(current.studentSnapshot),
      JSON.stringify(current.examinationSnapshot), JSON.stringify(current.physicianSnapshot),
      input.classification, input.remarks ?? null, input.examinationDate, input.sex,
      CERTIFICATE_TEMPLATE_VERSION, jpeg, jpeg.length, digest, actor.userId,
      JSON.stringify({ fullName: current.actorName, role: actor.role, deleted: false }), input.requestId]);
    if (input.lateReason?.trim()) {
      await client.query(`INSERT INTO medical_certificate_events
        (certificate_id,revision_id,action,reason,actor_user_id,actor_snapshot)
        VALUES ($1,$2,'LATE_ENCODING',$3,$4,$5::jsonb)`,
      [certificateId, revisionId, input.lateReason.trim(), actor.userId,
        JSON.stringify({ fullName: current.actorName, role: actor.role, deleted: false })]);
    }
    const oldStatus = (await getAppointmentMutationContext(appointmentId, client))!.status;
    await changeAppointmentStatusWithClient(client, appointmentId, oldStatus, "COMPLETED",
      "Medical certificate issued.", actor.userId);
    await client.query(`INSERT INTO exam_results
      (student_number,appointment_id,result_status,completed_at,encoded_by)
      VALUES ($1,$2,'COMPLETED',$3,$4)`,
    [current.studentNumber, appointmentId, input.examinationDate, actor.userId]);
    await writeAudit(actor.userId, "MEDICAL_CERTIFICATE_ISSUED", "appointment", appointmentId,
      { appointmentId, certificateId, revisionId, templateVersion: CERTIFICATE_TEMPLATE_VERSION }, client);
    await createStudentNotification(client, {
      studentNumber: current.studentNumber, notificationType: "MEDICAL_CERTIFICATE_AVAILABLE",
      title: "Medical certificate available", message: "Your Physical Examination record is available in the student portal.",
      eventKey: `medical-certificate:${certificateId}:issued`, messageKind: "GENERAL",
      sourceType: "MEDICAL_CERTIFICATE", sourceId: certificateId,
    });
    const outcome: Outcome = { certificateId, revisionId, appointmentId, certificateNumber };
    await client.query(`INSERT INTO clinical_mutation_requests
      (actor_user_id,request_id,action,payload_hash,outcome)
      VALUES ($1,$2,'ISSUE_CERTIFICATE',$3,$4::jsonb)`,
    [actor.userId, input.requestId, hash, JSON.stringify(outcome)]);
    return outcome;
  });
}

export async function issuedCertificateForAppointment(appointmentId: string) {
  const result = await pool.query<{ certificateId: string; revisionId: string; classification: string;
    remarks: string | null; sex: string; examinationDate: string; physicianId: string; physicianVersion: number; issuedAt: Date }>(
    `SELECT certificate.certificate_id::text AS "certificateId",certificate.id::text AS "revisionId",
            certificate.classification,certificate.remarks,certificate.sex,
            certificate.examination_date::text AS "examinationDate",
            physician.physician_id::text AS "physicianId",physician.version AS "physicianVersion",
            certificate.issued_at AS "issuedAt"
       FROM medical_certificate_revisions certificate
       JOIN medical_certificate_physician_revisions physician ON physician.id=certificate.physician_revision_id
      WHERE certificate.appointment_id=$1 AND certificate.status='ISSUED'
      ORDER BY certificate.revision_number DESC LIMIT 1`, [appointmentId]);
  return result.rows[0] ?? null;
}

export async function certificateHistoryForAppointment(appointmentId: string, actor: SessionUser) {
  return transaction(async (client) => {
    await currentCpuActor(client, actor);
    const result = await client.query<{ certificateId: string; revisionId: string; revisionNumber: number;
      status: string; classification: string; issuedAt: Date }>(
      `SELECT certificate_id::text AS "certificateId",id::text AS "revisionId",
              revision_number AS "revisionNumber",status,classification,issued_at AS "issuedAt"
         FROM medical_certificate_revisions
        WHERE appointment_id=$1 ORDER BY issued_at DESC,revision_number DESC`, [appointmentId]);
    return result.rows;
  });
}

export async function studentCertificateHistory(studentNumber: string) {
  const result = await pool.query<{ certificateId: string; status: string; classification: string;
    academicYearStart: number; examinationDate: string; appointmentId: string;
    academicYearEnded: boolean | null }>(
    `SELECT DISTINCT ON (certificate.certificate_id)
            certificate.certificate_id::text AS "certificateId",certificate.status,
            certificate.classification,certificate.academic_year_start AS "academicYearStart",
            certificate.examination_date::text AS "examinationDate",
            certificate.appointment_id::text AS "appointmentId",
            (year.closing_date < (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date) AS "academicYearEnded"
       FROM medical_certificate_revisions certificate
       LEFT JOIN academic_years year ON year.start_year=certificate.academic_year_start
      WHERE certificate.student_number=$1
      ORDER BY certificate.certificate_id,certificate.revision_number DESC`, [studentNumber]);
  if (result.rows.some((row) => row.academicYearEnded === null)) {
    throw new AppError("ACADEMIC_YEAR_MISSING", "A certificate has no configured academic year.", 409);
  }
  return result.rows.sort((left, right) => right.academicYearStart - left.academicYearStart
    || right.examinationDate.localeCompare(left.examinationDate));
}

export async function listCertificateRevisions(certificateId: string, actor: SessionUser) {
  return transaction(async (client) => {
    await currentCpuActor(client, actor);
    const rows = await client.query<{ id: string; revisionNumber: number; status: string;
      classification: string; examinationDate: string; issuedAt: Date }>(
      `SELECT id::text,revision_number AS "revisionNumber",status,classification,
              examination_date::text AS "examinationDate",issued_at AS "issuedAt"
         FROM medical_certificate_revisions WHERE certificate_id=$1 ORDER BY revision_number DESC`, [certificateId]);
    if (!rows.rowCount) throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
    return rows.rows;
  });
}

export async function downloadMedicalCertificateRevision(certificateId: string, revisionId: string, actor: SessionUser) {
  return transaction(async (client) => {
    await currentCpuActor(client, actor);
    const result = await client.query<{ jpegBytes: Buffer; studentNumber: string; revisionNumber: number }>(
      `SELECT jpeg_bytes AS "jpegBytes",student_number AS "studentNumber",
              revision_number AS "revisionNumber"
         FROM medical_certificate_revisions WHERE certificate_id=$1 AND id=$2`, [certificateId, revisionId]);
    if (!result.rows[0]) throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate revision not found.", 404);
    return result.rows[0];
  });
}

export async function downloadMedicalCertificate(certificateId: string, audience: { kind: "STAFF"; actor: SessionUser } | { kind: "STUDENT"; studentNumber: string }) {
  return transaction(async (client) => {
    if (audience.kind === "STAFF") await currentCpuActor(client, audience.actor);
    const metadata = (await client.query<{ id: string; appointmentId: string; studentNumber: string; status: string; revisionNumber: number }>(
      `SELECT id::text,appointment_id::text AS "appointmentId",student_number AS "studentNumber",
              status,revision_number AS "revisionNumber"
         FROM medical_certificate_revisions
        WHERE certificate_id=$1 ORDER BY revision_number DESC LIMIT 1`, [certificateId])).rows[0];
    if (!metadata || (audience.kind === "STUDENT" && metadata.studentNumber !== audience.studentNumber)) {
      throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
    }
    if (metadata.status === "REVOKED") {
      throw new AppError("CERTIFICATE_REVOKED", "This certificate has been revoked.", 410);
    }
    if (metadata.status !== "ISSUED") throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
    const bytes = (await client.query<{ jpegBytes: Buffer }>(
      "SELECT jpeg_bytes AS \"jpegBytes\" FROM medical_certificate_revisions WHERE id=$1", [metadata.id])).rows[0]?.jpegBytes;
    if (!bytes) throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
    return { bytes, studentNumber: metadata.studentNumber, revisionNumber: metadata.revisionNumber };
  });
}

type ActiveRevision = {
  id: string;
  certificateId: string;
  appointmentId: string;
  revisionNumber: number;
  status: string;
};

async function activeRevision(client: PoolClient, certificateId: string, lock = false): Promise<ActiveRevision> {
  const latest = (await client.query<ActiveRevision>(`SELECT id::text,certificate_id::text AS "certificateId",
    appointment_id::text AS "appointmentId",revision_number AS "revisionNumber",status
    FROM medical_certificate_revisions WHERE certificate_id=$1
    ORDER BY revision_number DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [certificateId])).rows[0];
  if (!latest) throw new AppError("CERTIFICATE_NOT_FOUND", "Certificate not found.", 404);
  return latest;
}

export async function correctMedicalCertificate(certificateId: string, raw: unknown, actor: SessionUser): Promise<Outcome> {
  const input: CertificateCorrectionInput = certificateCorrectionSchema.parse(raw);
  const hash = createHash("sha256").update(JSON.stringify({ certificateId, ...input })).digest("hex");
  const replay = await transaction(async (client) => {
    await currentCpuActor(client, actor);
    return replayRequest<Outcome>(client, actor, input.requestId, "CORRECT_CERTIFICATE", hash);
  });
  if (replay) return replay;
  const prepared = await transaction(async (client) => {
    const revision = await activeRevision(client, certificateId);
    if (revision.id !== input.expectedRevisionId || revision.status !== "ISSUED") {
      throw new AppError("CERTIFICATE_STALE", "The issued certificate changed. Reload and try again.", 409);
    }
    const context = await clinicalContext(client, revision.appointmentId, input, actor,
      `MC-${input.examinationDate.slice(0, 4)}-${certificateId.slice(0, 8).toUpperCase()}-R${revision.revisionNumber + 1}`, "correct");
    return { revision, context };
  });
  const jpeg = await renderMedicalCertificate(prepared.context.render, "issued");
  const digest = createHash("sha256").update(jpeg).digest("hex");
  return transaction(async (client) => {
    await currentCpuActor(client, actor);
    const existing = await replayRequest<Outcome>(client, actor, input.requestId, "CORRECT_CERTIFICATE", hash);
    if (existing) return existing;
    const scope = await getAppointmentMutationScope(prepared.revision.appointmentId, client);
    if (!scope) throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const currentRevision = await activeRevision(client, certificateId, true);
    if (currentRevision.id !== input.expectedRevisionId || currentRevision.status !== "ISSUED") {
      throw new AppError("CERTIFICATE_STALE", "The issued certificate changed. Reload and try again.", 409);
    }
    const current = await clinicalContext(client, currentRevision.appointmentId, input, actor,
      prepared.context.render.certificateNumber, "correct");
    if (!sameContext(prepared.context, current)) {
      throw new AppError("EXAMINATION_STALE", "The clinical record changed. Refresh and preview again.", 409);
    }
    await client.query("UPDATE medical_certificate_revisions SET status='SUPERSEDED' WHERE id=$1 AND status='ISSUED'", [currentRevision.id]);
    const revisionId = randomUUID();
    await client.query(`INSERT INTO medical_certificate_revisions
      (id,certificate_id,appointment_id,student_number,academic_year_start,revision_number,
       supersedes_revision_id,status,physician_revision_id,student_snapshot,examination_snapshot,
       physician_snapshot,classification,remarks,examination_date,sex,template_version,
       jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ISSUED',$8,$9::jsonb,$10::jsonb,$11::jsonb,
         $12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)`,
    [revisionId, certificateId, current.appointmentId, current.studentNumber, current.cycleStart,
      currentRevision.revisionNumber + 1, currentRevision.id, current.physicianRevisionId,
      JSON.stringify(current.studentSnapshot), JSON.stringify(current.examinationSnapshot),
      JSON.stringify(current.physicianSnapshot), input.classification, input.remarks ?? null,
      input.examinationDate, input.sex, CERTIFICATE_TEMPLATE_VERSION, jpeg, jpeg.length, digest,
      actor.userId, JSON.stringify({ fullName: current.actorName, role: actor.role, deleted: false }), input.requestId]);
    await client.query(`UPDATE exam_results SET completed_at=$2,remarks=$3,encoded_by=$4,
      updated_at=clock_timestamp() WHERE appointment_id=$1 AND result_status='COMPLETED'`,
    [current.appointmentId, input.examinationDate, input.remarks ?? null, actor.userId]);
    await client.query(`INSERT INTO medical_certificate_events
      (certificate_id,revision_id,action,reason,actor_user_id,actor_snapshot)
      VALUES ($1,$2,'CORRECTED',$3,$4,$5::jsonb)`,
    [certificateId, revisionId, input.reason, actor.userId,
      JSON.stringify({ fullName: current.actorName, role: actor.role, deleted: false })]);
    await writeAudit(actor.userId, "MEDICAL_CERTIFICATE_CORRECTED", "appointment", current.appointmentId,
      { certificateId, oldRevisionId: currentRevision.id, revisionId }, client);
    await createStudentNotification(client, {
      studentNumber: current.studentNumber, notificationType: "MEDICAL_CERTIFICATE_UPDATED",
      title: "Medical certificate updated", message: "An updated Physical Examination record is available in the student portal.",
      eventKey: `medical-certificate:${certificateId}:revision:${currentRevision.revisionNumber + 1}`,
      messageKind: "GENERAL", sourceType: "MEDICAL_CERTIFICATE", sourceId: certificateId,
    });
    const outcome: Outcome = { certificateId, revisionId, appointmentId: current.appointmentId,
      certificateNumber: current.render.certificateNumber };
    await client.query(`INSERT INTO clinical_mutation_requests
      (actor_user_id,request_id,action,payload_hash,outcome)
      VALUES ($1,$2,'CORRECT_CERTIFICATE',$3,$4::jsonb)`,
    [actor.userId, input.requestId, hash, JSON.stringify(outcome)]);
    return outcome;
  });
}

export async function previewCertificateCorrection(certificateId: string, raw: unknown, actor: SessionUser) {
  const input = certificateCorrectionSchema.parse(raw);
  const context = await transaction(async (client) => {
    const revision = await activeRevision(client, certificateId);
    if (revision.id !== input.expectedRevisionId || revision.status !== "ISSUED") {
      throw new AppError("CERTIFICATE_STALE", "The issued certificate changed. Reload and try again.", 409);
    }
    return clinicalContext(client, revision.appointmentId, input, actor, "PREVIEW ONLY", "correct");
  });
  return renderMedicalCertificate(context.render, "preview");
}

export async function revokeMedicalCertificate(certificateId: string, raw: unknown, actor: SessionUser) {
  const input = certificateRevocationSchema.parse(raw);
  const hash = createHash("sha256").update(JSON.stringify({ certificateId, ...input })).digest("hex");
  return transaction(async (client) => {
    const currentActor = await currentCpuActor(client, actor);
    if (currentActor.role !== "ADMIN") throw new AppError("FORBIDDEN", "Only an Administrator can revoke a certificate.", 403);
    const replay = await replayRequest<{ certificateId: string; revisionId: string; appointmentId: string }>(
      client, actor, input.requestId, "REVOKE_CERTIFICATE", hash);
    if (replay) return replay;
    const before = await activeRevision(client, certificateId);
    const scope = await getAppointmentMutationScope(before.appointmentId, client);
    if (!scope) throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const revision = await activeRevision(client, certificateId, true);
    if (revision.id !== input.expectedRevisionId || revision.status !== "ISSUED") {
      throw new AppError("CERTIFICATE_STALE", "The issued certificate changed. Reload and try again.", 409);
    }
    const appointment = await getAppointmentMutationContext(revision.appointmentId, client);
    if (!appointment || appointment.scheduleType !== "PHYSICAL_EXAM" || appointment.status !== "COMPLETED") {
      throw new AppError("EXAMINATION_STALE", "The examination changed. Reload and try again.", 409);
    }
    await client.query("UPDATE medical_certificate_revisions SET status='REVOKED' WHERE id=$1", [revision.id]);
    const target = appointment.appointmentDate < manilaCalendarDate(new Date()) ? "NO_SHOW" : "PENDING";
    await changeAppointmentStatusWithClient(client, appointment.id, "COMPLETED", target,
      "Medical certificate revoked.", actor.userId);
    await client.query(`UPDATE exam_results SET result_status='REQUIRES_FOLLOW_UP',
      completed_at=NULL,updated_at=clock_timestamp() WHERE appointment_id=$1 AND result_status='COMPLETED'`,
    [appointment.id]);
    await client.query(`INSERT INTO medical_certificate_events
      (certificate_id,revision_id,action,reason,actor_user_id,actor_snapshot)
      VALUES ($1,$2,'REVOKED',$3,$4,$5::jsonb)`,
    [certificateId, revision.id, input.reason, actor.userId,
      JSON.stringify({ fullName: currentActor.fullName, role: currentActor.role, deleted: false })]);
    await writeAudit(actor.userId, "MEDICAL_CERTIFICATE_REVOKED", "appointment", appointment.id,
      { certificateId, revisionId: revision.id }, client);
    await createStudentNotification(client, {
      studentNumber: appointment.studentNumber, notificationType: "MEDICAL_CERTIFICATE_REVOKED",
      title: "Medical certificate update", message: "A Physical Examination record changed. Sign in to the student portal for details.",
      eventKey: `medical-certificate:${certificateId}:revoked`, messageKind: "GENERAL",
      sourceType: "MEDICAL_CERTIFICATE", sourceId: certificateId,
    });
    const outcome = { certificateId, revisionId: revision.id, appointmentId: appointment.id };
    await client.query(`INSERT INTO clinical_mutation_requests
      (actor_user_id,request_id,action,payload_hash,outcome)
      VALUES ($1,$2,'REVOKE_CERTIFICATE',$3,$4::jsonb)`,
    [actor.userId, input.requestId, hash, JSON.stringify(outcome)]);
    return outcome;
  });
}
