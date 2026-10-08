import "server-only";
import { z } from "zod";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { manilaCalendarDate } from "@/lib/academic-year";
import { assertOpenAppointmentCycle } from "@/server/appointments/academic-year-visibility";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { loadLaboratoryChecklist } from "@/server/laboratory/laboratory-checklist.repository";
import { completeExternalLaboratoryWithClient } from "./pe-linked-laboratory.service";
import { changeAppointmentStatusWithClient, getAppointmentMutationContext } from "@/server/repositories/appointments.repository";
import { resolveEffectiveAppointmentPair } from "@/server/repositories/effective-appointment-pair.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  deletePendingResultPlaceholder,
  ensurePendingUploadResult,
  getAppointmentResultCorrectionState,
} from "@/server/repositories/student-result-submissions.repository";
import type { SessionUser } from "@/types/roles";

export const laboratoryVerificationSchema = z.object({
  testCode: z.enum(["CBC", "URINE", "STOOL", "XRAY"]),
  checked: z.boolean(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000).optional(),
}).strict();

type AppointmentScope = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  schedulePairId: string | null;
  scheduleCycleStart: number;
  clinicId: string;
  ovpsaBatchId: string | null;
};

async function currentClinicalActor(client: PoolClient, actor: SessionUser, scope: AppointmentScope) {
  const result = await client.query<{
    role: string;
    clinicId: string | null;
    fullName: string;
    credentialVersion: number;
    emailVerified: boolean;
    mustChangePassword: boolean;
  }>(`SELECT role,clinic_id::text AS "clinicId",full_name AS "fullName",
       credential_version AS "credentialVersion",email_verified_at IS NOT NULL AS "emailVerified",
       must_change_password AS "mustChangePassword"
      FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, [actor.userId]);
  const current = result.rows[0];
  if (!current || (actor.credentialVersion !== undefined && actor.credentialVersion !== current.credentialVersion)) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  if (!current.emailVerified || current.mustChangePassword) {
    throw new AppError("ONBOARDING_REQUIRED", "Complete account security onboarding before editing clinical results.", 403);
  }
  const allowedClinic = scope.ovpsaBatchId
    ? "CPU_CLINIC"
    : "KABALAKA_CLINIC";
  const expectedClinic = await client.query<{ id: string }>("SELECT id::text FROM clinics WHERE code=$1", [allowedClinic]);
  const bookingClinic = await client.query<{ id: string }>("SELECT id::text FROM clinics WHERE code='KABALAKA_CLINIC'");
  if (!expectedClinic.rows[0] || scope.clinicId !== bookingClinic.rows[0]?.id) {
    throw new AppError("LABORATORY_CLINIC_INVALID", "The Laboratory appointment has an invalid clinic assignment.", 409);
  }
  if (current.role !== "ADMIN" && (current.role !== "CLINIC_STAFF"
      || !current.clinicId || current.clinicId !== expectedClinic.rows[0]?.id)) {
    throw new AppError("FORBIDDEN", "You do not have permission to verify this Laboratory appointment.", 403);
  }
  return current;
}

async function appointmentScope(client: PoolClient, appointmentId: string) {
  const result = await client.query<AppointmentScope>(`SELECT id::text,student_number AS "studentNumber",
    schedule_type AS "scheduleType",schedule_pair_id::text AS "schedulePairId",
    schedule_cycle_start AS "scheduleCycleStart",clinic_id::text AS "clinicId",
    ovpsa_batch_id::text AS "ovpsaBatchId"
    FROM appointments WHERE id=$1 AND is_published=TRUE`, [appointmentId]);
  const scope = result.rows[0];
  if (!scope || scope.scheduleType !== "LABORATORY") {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Laboratory appointment not found.", 404);
  }
  return scope;
}

export async function getLaboratoryChecklist(appointmentId: string, actor: SessionUser) {
  return transaction(async (client) => {
    const scope = await appointmentScope(client, appointmentId);
    await currentClinicalActor(client, actor, scope);
    const checklist = await loadLaboratoryChecklist(client, appointmentId);
    if (!checklist) throw new AppError("LABORATORY_CHECKLIST_MISSING", "Laboratory checklist not found.", 409);
    return checklist;
  });
}

export async function setLaboratoryTestVerification(appointmentId: string, raw: unknown, actor: SessionUser) {
  const input = laboratoryVerificationSchema.parse(raw);
  return transaction(async (client) => {
    const scope = await appointmentScope(client, appointmentId);
    await currentClinicalActor(client, actor, scope);
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const pair = await resolveEffectiveAppointmentPair(client, scope);
    if (pair.laboratory?.id !== appointmentId) {
      throw new AppError("LABORATORY_APPOINTMENT_REPLACED", "This appointment is no longer current.", 409);
    }
    const appointment = await getAppointmentMutationContext(appointmentId, client);
    if (!appointment || !["PENDING", "NO_SHOW", "COMPLETED"].includes(appointment.status)) {
      throw new AppError("LABORATORY_APPOINTMENT_INACTIVE", "This Laboratory appointment cannot be edited.", 409);
    }
    await assertOpenAppointmentCycle(client, appointment.scheduleCycleStart, new Date());
    if (appointment.appointmentDate > manilaCalendarDate(new Date())) {
      throw new AppError("LABORATORY_APPOINTMENT_FUTURE", "Tests cannot be verified before the appointment date.", 409);
    }
    const checklist = await loadLaboratoryChecklist(client, appointmentId, true);
    if (!checklist) throw new AppError("LABORATORY_CHECKLIST_MISSING", "Laboratory checklist not found.", 409);
    if (checklist.version !== input.expectedVersion) {
      throw new AppError("LABORATORY_CHECKLIST_STALE", "The checklist changed. Refresh and try again.", 409);
    }
    const item = checklist.items.find((current) => current.testCode === input.testCode);
    if (!item) throw new AppError("LABORATORY_TEST_NOT_REQUIRED", "This test is not required for this appointment.", 422);
    if (checklist.completionPolicy.peConfirmedTestCodes.includes(input.testCode)) {
      throw new AppError("LABORATORY_TEST_PE_MANAGED",
        "This test is confirmed when CPU Clinic completes the Physical Examination.", 422);
    }
    const wasVerified = item.verifiedAt !== null;
    if (wasVerified === input.checked) return checklist;
    const reason = input.reason?.trim() || null;
    if ((!input.checked || appointment.status === "NO_SHOW") && !reason) {
      throw new AppError("CORRECTION_REASON_REQUIRED", "Enter a reason for correcting this checklist.", 422);
    }
    if (appointment.status === "NO_SHOW" && !isAutomaticNoShowLog(appointment.latestLog)) {
      throw new AppError("NO_SHOW_CORRECTION_NOT_ALLOWED", "Only an automatic no-show can be corrected here.", 422);
    }
    if (!input.checked) {
      if (pair.physicalExam?.status === "COMPLETED") {
        throw new AppError("PHYSICAL_ALREADY_COMPLETED", "The paired examination is already completed.", 409);
      }
      const certificateHistory = pair.physicalExam
        ? await client.query("SELECT id FROM medical_certificate_revisions WHERE appointment_id=$1 LIMIT 1",
          [pair.physicalExam.id])
        : null;
      if (certificateHistory?.rowCount) {
        throw new AppError("CERTIFICATE_ALREADY_ISSUED", "A certificate has been issued for this examination; its Laboratory evidence cannot be changed.", 409);
      }
      const resultState = await getAppointmentResultCorrectionState(client, appointment);
      if (resultState.type === "PROTECTED") {
        throw new AppError("APPOINTMENT_RESULT_PROTECTED", "Protected result data prevents this correction.", 409);
      }
      if (resultState.type === "PENDING_PLACEHOLDER") await deletePendingResultPlaceholder(client, resultState);
    }
    const verificationSource = scope.ovpsaBatchId ? "EXTERNAL" : "INTERNAL";
    await client.query(`UPDATE laboratory_checklist_items
      SET verified_at=CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END,
          verified_by=CASE WHEN $3::boolean THEN $4::uuid ELSE NULL END,
          verification_source=CASE WHEN $3::boolean THEN $5::varchar ELSE NULL END
      WHERE checklist_id=$1 AND test_code=$2`,
    [checklist.checklistId, input.testCode, input.checked, actor.userId, verificationSource]);
    await client.query("UPDATE laboratory_checklists SET version=version+1 WHERE id=$1", [checklist.checklistId]);
    const current = await currentClinicalActor(client, actor, scope);
    await client.query(`INSERT INTO laboratory_checklist_events
      (checklist_id,appointment_id,test_code,old_verified,new_verified,source,reason,actor_user_id,actor_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [checklist.checklistId, appointmentId, input.testCode, wasVerified, input.checked,
      verificationSource, reason, actor.userId, JSON.stringify({ fullName: current.fullName, role: current.role, deleted: false })]);
    const updated = await loadLaboratoryChecklist(client, appointmentId);
    if (!updated) throw new Error("Checklist disappeared during verification");
    const targetStatus = updated.verifiedCount === updated.totalCount
      ? "COMPLETED"
      : updated.verifiedCount === 0 && appointment.appointmentDate < manilaCalendarDate(new Date())
        ? "NO_SHOW"
        : "PENDING";
    if (appointment.status !== targetStatus) {
      await changeAppointmentStatusWithClient(client, appointmentId, appointment.status, targetStatus,
        reason ?? `Laboratory ${input.testCode} ${input.checked ? "verified" : "corrected"}.`, actor.userId);
    }
    if (targetStatus === "COMPLETED") {
      if (scope.ovpsaBatchId) {
        await completeExternalLaboratoryWithClient(client, appointmentId, actor.userId);
      } else {
        await ensurePendingUploadResult(client, appointment);
      }
    }
    await writeAudit(actor.userId, "LABORATORY_TEST_VERIFICATION_CHANGED", "appointment", appointmentId,
      { testCode: input.testCode, checked: input.checked, checklistVersion: updated.version }, client);
    return { ...updated, appointmentStatus: targetStatus };
  });
}

