import "server-only";
import { manilaCalendarDate } from "@/lib/academic-year";
import { AppError } from "@/lib/errors";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";
import { loadLaboratoryChecklist } from "@/server/laboratory/laboratory-checklist.repository";
import { currentCpuActor } from "@/server/medical-certificates/certificate.service";
import { listPhysicians } from "@/server/medical-certificates/physician.service";
import { getAppointmentMutationContext, getPublishedAppointment } from "@/server/repositories/appointments.repository";
import { resolveEffectiveAppointmentPair } from "@/server/repositories/effective-appointment-pair.repository";
import type { SessionUser } from "@/types/roles";

export async function loadPhysicalExamCompletionContext(appointmentId: string, actor: SessionUser) {
  const clinical = await transaction(async (client) => {
    const current = await currentCpuActor(client, actor);
    const appointment = await getAppointmentMutationContext(appointmentId, client);
    if (!appointment || !appointment.isPublished || appointment.scheduleType !== "PHYSICAL_EXAM"
        || appointment.clinicId !== current.cpuClinicId) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "Physical Examination appointment not found.", 404);
    }
    const pair = await resolveEffectiveAppointmentPair(client, appointment);
    const blockers: string[] = [];
    if (pair.physicalExam?.id !== appointmentId) blockers.push("This is not the effective Physical Examination record. Open the current replacement.");
    if (appointment.status !== "PENDING" && (appointment.status !== "NO_SHOW" || !isAutomaticNoShowLog(appointment.latestLog))) {
      blockers.push("This examination cannot be completed from its current status.");
    }
    const year = (await client.query<{ closingDate: string }>(
      'SELECT closing_date::text AS "closingDate" FROM academic_years WHERE start_year=$1',
      [appointment.scheduleCycleStart],
    )).rows[0];
    const today = manilaCalendarDate(new Date());
    if (!year || year.closingDate < today) blockers.push("This academic year has ended.");
    let laboratoryReady = false;
    if (pair.laboratory?.status === "COMPLETED") {
      const checklist = await loadLaboratoryChecklist(client, pair.laboratory.id);
      laboratoryReady = Boolean(checklist && checklist.totalCount > 0 && checklist.verifiedCount === checklist.totalCount);
      if (laboratoryReady) {
        const external = (await client.query<{ ovpsaBatchId: string | null }>(
          'SELECT ovpsa_batch_id::text AS "ovpsaBatchId" FROM appointments WHERE id=$1', [pair.laboratory.id],
        )).rows[0];
        if (external?.ovpsaBatchId) {
          laboratoryReady = Boolean((await client.query(
            "SELECT 1 FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1", [pair.laboratory.id],
          )).rowCount);
        }
      }
    }
    if (!laboratoryReady) blockers.push("Complete and verify the effective Laboratory checklist before this examination.");
    return { today, status: appointment.status, automaticNoShowEligible: appointment.status === "NO_SHOW"
      && isAutomaticNoShowLog(appointment.latestLog), laboratoryReady, blockers };
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
