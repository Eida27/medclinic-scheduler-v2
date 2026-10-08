import "server-only";
import { manilaCalendarDate } from "@/lib/academic-year";
import { AppError } from "@/lib/errors";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { loadPeLaboratoryCompletionPlan } from "@/server/laboratory/pe-linked-laboratory.service";
import { currentCpuActor } from "@/server/medical-certificates/certificate.service";
import { listPhysicians } from "@/server/medical-certificates/physician.service";
import { getAppointmentMutationContext, getAppointmentMutationScope, getPublishedAppointment } from "@/server/repositories/appointments.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import type { PeLaboratoryReadiness } from "@/shared/laboratory-completion";
import type { SessionUser } from "@/types/roles";

export async function loadPhysicalExamCompletionContext(appointmentId: string, actor: SessionUser) {
  const clinical = await transaction(async (client) => {
    const current = await currentCpuActor(client, actor);
    const scope = await getAppointmentMutationScope(appointmentId, client);
    if (!scope || scope.scheduleType !== "PHYSICAL_EXAM" || scope.clinicId !== current.cpuClinicId) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    }
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: scope.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: scope.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const appointment = await getAppointmentMutationContext(appointmentId, client);
    if (!appointment || !appointment.isPublished || appointment.scheduleType !== "PHYSICAL_EXAM"
        || appointment.clinicId !== current.cpuClinicId) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    }
    const plan = await loadPeLaboratoryCompletionPlan(client, appointment);
    const blockers: string[] = [];
    if (appointment.status !== "PENDING" && (appointment.status !== "NO_SHOW" || !isAutomaticNoShowLog(appointment.latestLog))) {
      blockers.push("This examination cannot be completed from its current status.");
    }
    const year = (await client.query<{ closingDate: string }>(
      'SELECT closing_date::text AS "closingDate" FROM academic_years WHERE start_year=$1',
      [appointment.scheduleCycleStart],
    )).rows[0];
    const today = manilaCalendarDate(new Date());
    if (!year || year.closingDate < today) blockers.push("This academic year has ended.");
    const laboratoryCompletion: PeLaboratoryReadiness = {
      laboratoryAppointmentId: plan.laboratoryAppointmentId, laboratoryCompleted: plan.laboratoryCompleted,
      readyForPe: plan.readyForPe, missingManualTestCodes: plan.missingManualTestCodes, completionPolicy: plan.completionPolicy,
    };
    const laboratoryReady = laboratoryCompletion.readyForPe;
    if (!laboratoryReady) {
      if (plan.completionPolicy.mode === "FOURTH_YEAR_OJT" && plan.missingManualTestCodes.length) {
        const names = { CBC: "CBC", URINE: "Urine", STOOL: "Stool", XRAY: "X-ray" };
        blockers.push(`Verify the missing Laboratory tests at KABALAKA before this examination: ${plan.missingManualTestCodes.map((code) => names[code]).join(", ")}.`);
      } else blockers.push("Complete and verify the effective Laboratory checklist before this examination.");
    }
    return { today, status: appointment.status, automaticNoShowEligible: appointment.status === "NO_SHOW"
      && isAutomaticNoShowLog(appointment.latestLog), laboratoryReady, laboratoryCompletion, blockers };
  });
  const [appointment, physicians] = await Promise.all([
    getPublishedAppointment(appointmentId), listPhysicians(actor),
  ]);
  if (!appointment || appointment.scheduleType !== "PHYSICAL_EXAM") {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
  }
  if (!appointment.certificateStudentName) clinical.blockers.push("The academic snapshot is missing. Resolve the student record before completion.");
  if (!appointment.dateOfBirth) clinical.blockers.push("The date of birth is missing. Resolve the student record before completion.");
  if (!physicians.length) clinical.blockers.push("An Administrator must configure an active physician and signature first.");
  return {
    appointmentId, studentName: appointment.studentName, studentNumber: appointment.studentNumber,
    appointmentDate: appointment.appointmentDate, scheduleCycleStart: appointment.scheduleCycleStart,
    dateOfBirth: appointment.dateOfBirth,
    studentAcademicSnapshot: appointment.certificateStudentName ? {
      studentName: appointment.certificateStudentName, collegeName: appointment.certificateCollegeName ?? "",
      programName: appointment.certificateProgramName ?? "", yearLevel: appointment.certificateYearLevel,
    } : null,
    physicians: physicians.map(({ id, version, displayName, licenseNumber, specialty }) =>
      ({ id, version, displayName, licenseNumber, specialty })),
    canConfigurePhysicians: actor.role === "ADMIN",
    ...clinical,
  };
}
