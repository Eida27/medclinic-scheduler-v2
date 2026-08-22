import "server-only";
import { createHash } from "node:crypto";
import { SCHEDULE_NOTICE } from "@/lib/schedule-notice";
import type { StudentNotificationInput } from "@/server/repositories/student-notifications.repository";

export type AppointmentStatus =
  | "DRAFT"
  | "PENDING"
  | "COMPLETED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "CANCELLED"
  | "AWAITING_RESCHEDULE";

export type ScheduleType = "LABORATORY" | "PHYSICAL_EXAM";

export type AuthoritativeScheduleAppointment = {
  id: string;
  scheduleType: ScheduleType;
  status: AppointmentStatus;
  date: string | null;
  affectedDate: string | null;
  location: string;
};

export type AuthoritativeScheduleState = {
  studentNumber: string;
  studentName: string;
  laboratory: AuthoritativeScheduleAppointment | null;
  physicalExam: AuthoritativeScheduleAppointment | null;
  openManualResolutionIds: string[];
};

export type PreviousScheduleState = {
  laboratory?: { date: string; location: string } | null;
  physicalExam?: { date: string; location: string } | null;
};

export function hasAuthoritativeScheduleState(state: AuthoritativeScheduleState) {
  return Boolean(
    state.laboratory
    || state.physicalExam
    || state.openManualResolutionIds.length,
  );
}

export function fingerprintScheduleState(state: AuthoritativeScheduleState) {
  const canonical = {
    appointments: [state.laboratory, state.physicalExam]
      .filter((appointment): appointment is AuthoritativeScheduleAppointment => Boolean(appointment))
      .map((appointment) => [
        appointment.scheduleType,
        appointment.id,
        appointment.status,
        appointment.date,
        appointment.affectedDate,
        appointment.location,
      ]),
    openManualResolutionIds: [...state.openManualResolutionIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function statusLabel(status: AppointmentStatus) {
  return status.toLowerCase().split("_").map((part) => (
    part === "no" ? "No" : part.charAt(0).toUpperCase() + part.slice(1)
  )).join(" ").replace("No Show", "No-show");
}

function serviceLabel(scheduleType: ScheduleType) {
  return scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination";
}

function appointmentLine(appointment: AuthoritativeScheduleAppointment) {
  const label = serviceLabel(appointment.scheduleType);
  if (appointment.status === "AWAITING_RESCHEDULE") {
    const affected = appointment.affectedDate
      ? `the prior ${appointment.affectedDate} appointment at ${appointment.location} was affected`
      : `the prior appointment at ${appointment.location} was affected`;
    return `${label}: ${affected}; a replacement date is pending administrator resolution.`;
  }
  if (!appointment.date) return `${label}: no current date is assigned (${statusLabel(appointment.status)}).`;
  return `${label}: ${appointment.date} at ${appointment.location} (${statusLabel(appointment.status)}).`;
}

function currentLines(state: AuthoritativeScheduleState) {
  return [state.laboratory, state.physicalExam]
    .filter((appointment): appointment is AuthoritativeScheduleAppointment => Boolean(appointment))
    .map(appointmentLine);
}

function previousLines(previous?: PreviousScheduleState) {
  if (!previous) return [];
  return [
    previous.laboratory
      ? `Previous Laboratory: ${previous.laboratory.date} at ${previous.laboratory.location}.`
      : null,
    previous.physicalExam
      ? `Previous Physical Examination: ${previous.physicalExam.date} at ${previous.physicalExam.location}.`
      : null,
  ].filter((line): line is string => Boolean(line));
}

function emailBody(input: {
  state: AuthoritativeScheduleState;
  introduction: string;
  reason?: string;
  previous?: PreviousScheduleState;
}) {
  return [
    `Student: ${input.state.studentName}`,
    `Student Number: ${input.state.studentNumber}`,
    "",
    input.introduction,
    ...previousLines(input.previous),
    ...currentLines(input.state),
    input.reason ? `Reason: ${input.reason}` : null,
    input.state.openManualResolutionIds.length
      ? "Status: Manual Resolution is open and awaiting administrator action."
      : null,
    "",
    "Open the MedClinic student portal: /student",
    "",
    SCHEDULE_NOTICE,
  ].filter((line): line is string => line !== null).join("\n");
}

function portalSummary(state: AuthoritativeScheduleState) {
  const lines = currentLines(state);
  return lines.length ? lines.join(" ") : "No current Laboratory or Physical Examination appointment is assigned.";
}

function notificationBase(input: {
  state: AuthoritativeScheduleState;
  notificationType: string;
  title: string;
  portalMessage: string;
  emailSubject: string;
  introduction: string;
  eventKey: string;
  sourceType: string;
  sourceId: string;
  reason?: string;
  previous?: PreviousScheduleState;
}): StudentNotificationInput {
  const scheduleFingerprint = fingerprintScheduleState(input.state);
  return {
    studentNumber: input.state.studentNumber,
    notificationType: input.notificationType,
    title: input.title,
    message: `${input.portalMessage} ${portalSummary(input.state)}`,
    metadata: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      scheduleFingerprint,
    },
    eventKey: input.eventKey,
    emailSubject: input.emailSubject,
    emailTextBody: emailBody(input),
    messageKind: "SCHEDULE",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    scheduleFingerprint,
  };
}

export function buildInitialPublicationNotification(input: {
  state: AuthoritativeScheduleState;
  sourceType: string;
  sourceId: string;
}) {
  return notificationBase({
    ...input,
    notificationType: "SCHEDULE_INITIAL_PUBLICATION",
    title: "Schedule published",
    portalMessage: "Your MedClinic schedule is ready.",
    emailSubject: "Your MedClinic schedule is ready",
    introduction: "Your initial Laboratory and Physical Examination schedule is now available.",
    eventKey: `schedule:initial:${input.sourceType}:${input.sourceId}:${input.state.studentNumber}`,
  });
}

export function buildCurrentStateNotification(state: AuthoritativeScheduleState) {
  const fingerprint = fingerprintScheduleState(state);
  return notificationBase({
    state,
    notificationType: "SCHEDULE_CURRENT_STATE",
    title: "Current schedule",
    portalMessage: "Your current authoritative MedClinic schedule is shown below.",
    emailSubject: "Your current MedClinic schedule",
    introduction: "This is your current authoritative Laboratory and Physical Examination schedule.",
    eventKey: `schedule:current:${state.studentNumber}:${fingerprint}`,
    sourceType: "CURRENT_SCHEDULE_STATE",
    sourceId: fingerprint,
  });
}

type ScheduleEventInput = {
  state: AuthoritativeScheduleState;
  eventId: string;
  reason: string;
  previous?: PreviousScheduleState;
};

function buildEvent(input: ScheduleEventInput, copy: {
  notificationType: string;
  title: string;
  portalMessage: string;
  emailSubject: string;
  introduction: string;
  sourceType: string;
}) {
  return notificationBase({
    ...input,
    ...copy,
    eventKey: `schedule:event:${input.eventId}:${input.state.studentNumber}`,
    sourceType: copy.sourceType,
    sourceId: input.eventId,
  });
}

export function buildPriorityDisplacementNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_PRIORITY_DISPLACEMENT",
    title: "Schedule changed for priority scheduling",
    portalMessage: "Approved priority scheduling changed your schedule.",
    emailSubject: "Your MedClinic schedule changed due to priority scheduling",
    introduction: "Approved priority scheduling changed your MedClinic schedule.",
    sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
  });
}

export function buildClosureRescheduledNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_CLOSURE_RESCHEDULED",
    title: "Schedule changed for a clinic closure",
    portalMessage: "A clinic closure changed your schedule.",
    emailSubject: "Your MedClinic schedule changed due to a clinic closure",
    introduction: "A clinic closure changed your MedClinic schedule.",
    sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
  });
}

export function buildAwaitingResolutionNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_AWAITING_RESOLUTION",
    title: "Schedule awaiting administrator resolution",
    portalMessage: "An affected schedule is awaiting administrator resolution.",
    emailSubject: "Your MedClinic schedule needs administrator resolution",
    introduction: "Your prior schedule was affected. No replacement date has been authorized yet.",
    sourceType: "CLINIC_CLOSURE_MANUAL_CASE",
  });
}

export function buildManualResolutionCompletedNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_MANUAL_RESOLUTION_COMPLETED",
    title: "Replacement schedule assigned",
    portalMessage: "Manual Resolution is complete and your replacement schedule is available.",
    emailSubject: "Your MedClinic replacement schedule is ready",
    introduction: "Manual Resolution is complete. Your authoritative replacement schedule is below.",
    sourceType: "CLINIC_CLOSURE_MANUAL_CASE",
  });
}

export function buildAdministratorRescheduledNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_ADMINISTRATOR_RESCHEDULED",
    title: "Schedule updated by an administrator",
    portalMessage: "An administrator authorized a schedule change.",
    emailSubject: "Your MedClinic schedule was updated by an administrator",
    introduction: "An administrator authorized the following MedClinic schedule change.",
    sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
  });
}

export function buildRestorationNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_RESTORED",
    title: "Earlier schedule restored",
    portalMessage: "Your earlier MedClinic schedule was restored.",
    emailSubject: "Your earlier MedClinic schedule was restored",
    introduction: "Your earlier MedClinic schedule has been restored and is authoritative again.",
    sourceType: "APPOINTMENT_RESCHEDULE_EVENT",
  });
}

export function buildCancellationNotification(input: ScheduleEventInput) {
  return buildEvent(input, {
    notificationType: "SCHEDULE_CANCELLED",
    title: "Schedule cancelled",
    portalMessage: "An authorized scheduling action cancelled your schedule.",
    emailSubject: "Your MedClinic schedule was cancelled",
    introduction: "An authorized scheduling action cancelled your MedClinic schedule.",
    sourceType: "OVPSA_FIRST_YEAR_BATCH",
  });
}
