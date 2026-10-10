import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { createHash } from "node:crypto";
import { manilaCalendarDate } from "@/lib/academic-year";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { loadLaboratoryChecklist } from "./laboratory-checklist.repository";
import { getAppointmentMutationContext, changeAppointmentStatusWithClient } from "@/server/repositories/appointments.repository";
import { resolveEffectiveAppointmentPair, type EffectivePairAnchor } from "@/server/repositories/effective-appointment-pair.repository";
import { ensurePendingUploadResult } from "@/server/repositories/student-result-submissions.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import type { LaboratoryTestCode, PeLaboratoryReadiness } from "@/shared/laboratory-completion";
import type { SessionUser } from "@/types/roles";

export type PeLaboratoryCompletionPlan = PeLaboratoryReadiness & {
  checklistId: string;
  checklistVersionBefore: number;
  checklistVersionAfter: number;
  automaticallyVerifiedTestCodes: LaboratoryTestCode[];
  ovpsaBatchId: string | null;
  ovpsaRevisionId: string | null;
  fingerprint: string;
};
export type PeLaboratoryCompletionOutcome = {
  laboratoryAppointmentId: string;
  checklistVersion: number;
  automaticallyVerifiedTestCodes: LaboratoryTestCode[];
};

function provenanceMissing(): never {
  throw new AppError("LABORATORY_PROVENANCE_MISSING", "The effective Laboratory pair has invalid immutable provenance.", 409);
}

/** Read-only. CPU callers take the scheduling queue, then sorted service scopes before calling. */
export async function loadPeLaboratoryCompletionPlan(client: PoolClient, peAnchor: EffectivePairAnchor,
  mode: "issue" | "correct" = "issue"): Promise<PeLaboratoryCompletionPlan> {
  const pair = await resolveEffectiveAppointmentPair(client, peAnchor);
  if (!pair.laboratory || pair.physicalExam?.id !== peAnchor.id) {
    throw new AppError("LABORATORY_NOT_COMPLETED", "The effective Laboratory pair is missing or has been replaced.", 409);
  }
  const lab = await getAppointmentMutationContext(pair.laboratory.id, client);
  const pe = await getAppointmentMutationContext(peAnchor.id, client);
  if (!lab || !pe || lab.clinicCode !== "KABALAKA_CLINIC" || pe.clinicCode !== "CPU_CLINIC"
      || lab.appointmentDate >= pe.appointmentDate || lab.studentNumber !== pe.studentNumber
      || lab.scheduleCycleStart !== pe.scheduleCycleStart || lab.schedulePairId !== pe.schedulePairId) provenanceMissing();
  if (!["PENDING", "COMPLETED", "NO_SHOW"].includes(lab.status)
      || (lab.status === "NO_SHOW" && !isAutomaticNoShowLog(lab.latestLog))) {
    throw new AppError("LABORATORY_APPOINTMENT_INACTIVE", "The effective Laboratory appointment cannot be confirmed.", 409);
  }
  if (mode === "correct" && lab.status !== "COMPLETED") {
    throw new AppError("LABORATORY_NOT_COMPLETED", "Certificate correction requires completed Laboratory evidence.", 409);
  }
  const checklist = await loadLaboratoryChecklist(client, lab.id, true);
  if (!checklist) throw new AppError("LABORATORY_CHECKLIST_MISSING", "Laboratory checklist not found.", 409);
  const academic = (await client.query<{ snapshotId: string; yearLevel: number; category: string; sourceImportId: string; importMode: string }>(
    `SELECT s.id::text AS "snapshotId",s.year_level AS "yearLevel",c.scheduling_category_snapshot AS category,
            s.source_import_group_id::text AS "sourceImportId",g.import_mode AS "importMode"
       FROM laboratory_checklists c JOIN student_academic_snapshots s ON s.id=c.academic_snapshot_id
       JOIN schedule_import_groups g ON g.id=s.source_import_group_id
       JOIN appointments root ON root.id=c.root_appointment_id
      WHERE c.id=$1 AND c.student_number=$2 AND c.academic_year_start=$3
        AND s.student_number=c.student_number AND s.academic_year_start=c.academic_year_start
        AND s.year_level=c.year_level_snapshot AND c.scheduling_category_snapshot=$4
        AND root.student_number=c.student_number AND root.schedule_cycle_start=c.academic_year_start
        AND root.scheduling_category=c.scheduling_category_snapshot AND root.rescheduled_from IS NULL`,
    [checklist.checklistId, lab.studentNumber, lab.scheduleCycleStart, lab.schedulingCategory],
  )).rows[0];
  if (!academic) provenanceMissing();
  const policy = checklist.completionPolicy;
  const required = [...policy.manualTestCodes, ...policy.peConfirmedTestCodes];
  if (checklist.items.map((i) => i.testCode).join(",") !== required.join(",")
      || checklist.items.some((i) => (i.verifiedAt !== null) !== (i.verifiedBy !== null && i.verificationSource !== null))) provenanceMissing();
  let ovpsaIdentity: Record<string, unknown> | null = null;
  if (policy.mode === "FIRST_YEAR_EXTERNAL") {
    if (!lab.ovpsaBatchId || !lab.ovpsaRevisionId || !lab.ovpsaServiceReservationId
        || pe.ovpsaBatchId !== lab.ovpsaBatchId || pe.ovpsaRevisionId !== lab.ovpsaRevisionId
        || !pe.ovpsaServiceReservationId || academic.importMode !== "FIRST_YEAR_OVPSA"
        || Date.parse(pe.appointmentDate) - Date.parse(lab.appointmentDate) < 7 * 86_400_000) provenanceMissing();
    ovpsaIdentity = (await client.query<Record<string, unknown>>(
      `SELECT b.id::text AS "batchId",r.id::text AS "revisionId",ls.id::text AS "laboratoryReservationId",
              ps.id::text AS "physicalExamReservationId",ms.academic_snapshot_id::text AS "snapshotId",
              r.laboratory_location AS provider,ms.assigned_pe_reservation_id::text AS "assignedPeReservationId"
         FROM ovpsa_first_year_batches b
         JOIN ovpsa_first_year_batch_revisions r ON r.id=$2 AND r.batch_id=b.id
           AND ($11::boolean OR r.id=b.current_revision_id)
         JOIN ovpsa_first_year_active_memberships m ON m.batch_id=b.id AND m.revision_id=r.id
           AND m.student_number=$4 AND m.schedule_cycle_start=$5 AND ($11::boolean OR m.released_at IS NULL)
         JOIN ovpsa_first_year_membership_snapshots ms ON ms.batch_id=b.id AND ms.revision_id=r.id
           AND ms.student_number=m.student_number AND ms.academic_snapshot_id=$6 AND ms.year_level=1
         JOIN ovpsa_first_year_service_reservations ls ON ls.id=$7 AND ls.batch_id=b.id AND ls.revision_id=r.id
           AND ls.schedule_type='LABORATORY' AND ($11::boolean OR ls.status='ACTIVE') AND ls.reservation_date=$8::date
         JOIN ovpsa_first_year_service_reservations ps ON ps.id=$9 AND ps.batch_id=b.id AND ps.revision_id=r.id
           AND ps.schedule_type='PHYSICAL_EXAM' AND ($11::boolean OR ps.status='ACTIVE') AND ps.reservation_date=$10::date
        WHERE b.id=$1 AND r.id=$2 AND b.source_import_group_id=$3 AND b.schedule_cycle_start=$5
          AND ($11::boolean OR (b.status='PUBLISHED' AND r.status='PUBLISHED'))
          AND r.published_at IS NOT NULL AND r.laboratory_location='ILOILO_MISSION_HOSPITAL'
          AND r.laboratory_date=$8::date AND ms.assigned_pe_reservation_id=ps.id
        FOR SHARE OF b,r,m,ms,ls,ps`,
      [lab.ovpsaBatchId, lab.ovpsaRevisionId, academic.sourceImportId, lab.studentNumber, lab.scheduleCycleStart,
        academic.snapshotId, lab.ovpsaServiceReservationId, lab.appointmentDate, pe.ovpsaServiceReservationId, pe.appointmentDate,
        mode === "correct"],
    )).rows[0] ?? null;
    if (!ovpsaIdentity) provenanceMissing();
  } else if (lab.ovpsaBatchId || pe.ovpsaBatchId || academic.importMode === "FIRST_YEAR_OVPSA") provenanceMissing();
  const summary = (await client.query<{ batchId: string; revisionId: string; provider: string }>(
    `SELECT batch_id::text AS "batchId",revision_id::text AS "revisionId",external_provider AS provider
       FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1 FOR SHARE`, [lab.id],
  )).rows[0];
  if (summary && (policy.mode !== "FIRST_YEAR_EXTERNAL" || summary.batchId !== lab.ovpsaBatchId
      || summary.revisionId !== lab.ovpsaRevisionId || summary.provider !== "Iloilo Mission Hospital")) provenanceMissing();
  const laboratoryCompleted = lab.status === "COMPLETED";
  if (laboratoryCompleted && (checklist.verifiedCount !== checklist.totalCount
      || (policy.mode === "FIRST_YEAR_EXTERNAL" && !summary))) {
    throw new AppError("LABORATORY_NOT_COMPLETED", "The completed Laboratory record has inconsistent evidence.", 409);
  }
  if (!laboratoryCompleted && checklist.verifiedCount === checklist.totalCount) {
    throw new AppError("LABORATORY_NOT_COMPLETED", "Laboratory status and verified tests do not agree.", 409);
  }
  if (laboratoryCompleted && policy.mode === "FIRST_YEAR_EXTERNAL") {
    const result = (await client.query<{ status: string }>('SELECT result_status AS status FROM laboratory_results WHERE appointment_id=$1 FOR SHARE', [lab.id])).rows[0];
    if (result?.status !== "COMPLETED") throw new AppError("LABORATORY_NOT_COMPLETED", "The completed external Laboratory result is missing.", 409);
  }
  const missingManualTestCodes = policy.manualTestCodes.filter((code) => !checklist.items.find((i) => i.testCode === code)?.verifiedAt);
  const automaticallyVerifiedTestCodes = policy.peConfirmedTestCodes.filter((code) => !checklist.items.find((i) => i.testCode === code)?.verifiedAt);
  const readyForPe = missingManualTestCodes.length === 0 && lab.appointmentDate <= manilaCalendarDate(new Date())
    && (policy.mode === "STANDARD" ? laboratoryCompleted : lab.status === "PENDING" || laboratoryCompleted);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    laboratory: { id: lab.id, date: lab.appointmentDate, status: lab.status, updatedAt: lab.updatedAt.toISOString(),
      batchId: lab.ovpsaBatchId, revisionId: lab.ovpsaRevisionId, reservationId: lab.ovpsaServiceReservationId },
    checklist: { id: checklist.checklistId, version: checklist.version, items: checklist.items }, academic, ovpsaIdentity,
    summary: summary ?? null, policy,
  })).digest("hex");
  return { laboratoryAppointmentId: lab.id, laboratoryCompleted, readyForPe, missingManualTestCodes,
    completionPolicy: policy, checklistId: checklist.checklistId, checklistVersionBefore: checklist.version,
    checklistVersionAfter: checklist.version + (automaticallyVerifiedTestCodes.length ? 1 : 0),
    automaticallyVerifiedTestCodes, ovpsaBatchId: lab.ovpsaBatchId ?? null, ovpsaRevisionId: lab.ovpsaRevisionId ?? null, fingerprint };
}

/** Called only after the issuance writer reloads the plan under its final transaction locks. */
export async function applyPeLinkedLaboratoryCompletion(client: PoolClient, plan: PeLaboratoryCompletionPlan, context: {
  actor: SessionUser; actorFullName: string; physicalExamAppointmentId: string; certificateId: string; examinationDate: string;
}): Promise<PeLaboratoryCompletionOutcome> {
  if (!plan.readyForPe) throw new AppError("LABORATORY_NOT_COMPLETED", "Verify the required manual Laboratory tests first.", 409);
  const outcome: PeLaboratoryCompletionOutcome = { laboratoryAppointmentId: plan.laboratoryAppointmentId,
    checklistVersion: plan.checklistVersionBefore, automaticallyVerifiedTestCodes: [] };
  if (plan.completionPolicy.mode === "STANDARD") return outcome;
  const actorSnapshot = JSON.stringify({ fullName: context.actorFullName, role: context.actor.role, deleted: false });
  const confirmation = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0].at;
  for (const code of plan.automaticallyVerifiedTestCodes) {
    const changed = await client.query(`UPDATE laboratory_checklist_items SET verified_at=$3,verified_by=$4,verification_source='EXTERNAL'
      WHERE checklist_id=$1 AND test_code=$2 AND verified_at IS NULL RETURNING test_code`,
    [plan.checklistId, code, confirmation, context.actor.userId]);
    if (changed.rowCount !== 1) throw new AppError("EXAMINATION_STALE", "The Laboratory checklist changed. Refresh and review the details.", 409);
    await client.query(`INSERT INTO laboratory_checklist_events
      (checklist_id,appointment_id,test_code,old_verified,new_verified,source,reason,actor_user_id,actor_snapshot)
      VALUES($1,$2,$3,FALSE,TRUE,'EXTERNAL','Iloilo Mission Hospital test confirmed during CPU Physical Examination.',$4,$5::jsonb)`,
    [plan.checklistId, plan.laboratoryAppointmentId, code, context.actor.userId, actorSnapshot]);
    outcome.automaticallyVerifiedTestCodes.push(code);
  }
  if (outcome.automaticallyVerifiedTestCodes.length) {
    const updated = await client.query<{ version: number }>(`UPDATE laboratory_checklists SET version=version+1
      WHERE id=$1 AND version=$2 RETURNING version`, [plan.checklistId, plan.checklistVersionBefore]);
    if (!updated.rows[0]) throw new AppError("EXAMINATION_STALE", "The Laboratory checklist changed. Refresh and review the details.", 409);
    outcome.checklistVersion = updated.rows[0].version;
  }
  const checklist = await loadLaboratoryChecklist(client, plan.laboratoryAppointmentId);
  if (!checklist || checklist.verifiedCount !== checklist.totalCount || outcome.checklistVersion !== plan.checklistVersionAfter) {
    throw new AppError("EXAMINATION_STALE", "The Laboratory completion plan changed. Refresh and review the details.", 409);
  }
  const lab = await getAppointmentMutationContext(plan.laboratoryAppointmentId, client);
  if (!lab) provenanceMissing();
  if (lab.status !== "COMPLETED") await changeAppointmentStatusWithClient(client, lab.id, lab.status, "COMPLETED",
    "Laboratory confirmed during CPU Physical Examination.", context.actor.userId);
  if (plan.completionPolicy.mode === "FIRST_YEAR_EXTERNAL") await completeExternalLaboratoryWithClient(client, lab.id, context.actor.userId);
  else await ensurePendingUploadResult(client, lab);
  if (outcome.automaticallyVerifiedTestCodes.length) await writeAudit(context.actor.userId, "LABORATORY_EXTERNAL_CONFIRMED_DURING_PE",
    "appointment", lab.id, { laboratoryAppointmentId: lab.id, physicalExamAppointmentId: context.physicalExamAppointmentId,
      certificateId: context.certificateId, examinationDate: context.examinationDate, mode: plan.completionPolicy.mode,
      externalProvider: plan.completionPolicy.externalProvider, automaticallyVerifiedTestCodes: outcome.automaticallyVerifiedTestCodes,
      checklistId: plan.checklistId, checklistVersionBefore: plan.checklistVersionBefore, checklistVersionAfter: outcome.checklistVersion }, client);
  return outcome;
}

/** Transaction-local finalization; the clinical writer owns authorization and locks. */
export async function completeExternalLaboratoryWithClient(client: PoolClient, appointmentId: string, actorUserId: string): Promise<void> {
  const row = (await client.query<{ studentNumber: string; batchId: string; revisionId: string }>(
    `SELECT a.student_number AS "studentNumber",a.ovpsa_batch_id::text AS "batchId",a.ovpsa_revision_id::text AS "revisionId"
       FROM appointments a
       JOIN ovpsa_first_year_batches b ON b.id=a.ovpsa_batch_id AND b.current_revision_id=a.ovpsa_revision_id
         AND b.schedule_cycle_start=a.schedule_cycle_start AND b.status='PUBLISHED'
       JOIN ovpsa_first_year_batch_revisions r ON r.id=a.ovpsa_revision_id AND r.batch_id=b.id
         AND r.status='PUBLISHED' AND r.laboratory_location='ILOILO_MISSION_HOSPITAL'
       JOIN ovpsa_first_year_service_reservations s ON s.id=a.ovpsa_service_reservation_id
         AND s.batch_id=b.id AND s.revision_id=r.id AND s.schedule_type='LABORATORY'
         AND s.reservation_date=a.appointment_date AND s.status='ACTIVE'
      WHERE a.id=$1 AND a.is_published=TRUE AND a.schedule_type='LABORATORY' AND a.status='COMPLETED'`,
    [appointmentId],
  )).rows[0];
  if (!row) throw new AppError("OVPSA_PROVENANCE_MISSING", "The external Laboratory appointment has no valid current batch provenance.", 409);
  await client.query(`INSERT INTO ovpsa_external_laboratory_verifications
    (appointment_id,batch_id,revision_id,external_provider,verified_by)
    VALUES ($1,$2,$3,'Iloilo Mission Hospital',$4) ON CONFLICT (appointment_id) DO NOTHING`,
  [appointmentId, row.batchId, row.revisionId, actorUserId]);
  const existing = (await client.query<{ batchId: string; revisionId: string; provider: string }>(
    `SELECT batch_id::text AS "batchId",revision_id::text AS "revisionId",external_provider AS provider
       FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1 FOR UPDATE`, [appointmentId],
  )).rows[0];
  if (!existing || existing.batchId !== row.batchId || existing.revisionId !== row.revisionId || existing.provider !== "Iloilo Mission Hospital") {
    throw new AppError("OVPSA_PROVENANCE_MISSING", "The external Laboratory confirmation has mismatched provenance.", 409);
  }
  const result = (await client.query<{ status: string }>(
    'SELECT result_status AS status FROM laboratory_results WHERE appointment_id=$1 FOR UPDATE', [appointmentId],
  )).rows[0];
  if (result && !["PENDING_UPLOAD", "COMPLETED"].includes(result.status)) {
    throw new AppError("APPOINTMENT_RESULT_PROTECTED", "Protected result data prevents external finalization.", 409);
  }
  await client.query(`INSERT INTO laboratory_results
    (student_number,appointment_id,result_status,completed_at,encoded_by)
    VALUES ($1,$2,'COMPLETED',(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date,$3)
    ON CONFLICT (appointment_id) DO UPDATE SET result_status='COMPLETED',
      completed_at=EXCLUDED.completed_at,encoded_by=EXCLUDED.encoded_by,
      updated_at=clock_timestamp() WHERE laboratory_results.result_status='PENDING_UPLOAD'`,
  [row.studentNumber, appointmentId, actorUserId]);
}
