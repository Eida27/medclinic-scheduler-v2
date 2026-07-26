import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import {
  insertClinicUnavailableDate,
  softUnblockClinicUnavailableDate,
} from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicRestorationBundle,
  LockedRestorationAppointment,
  RestorationScheduleType,
} from "@/server/repositories/clinic-calendar-restoration.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { createStudentNotification } from "@/server/services/student-notifications.service";
import type {
  ClinicCalendarBatchChange,
  ClinicCalendarBatchIssue,
  ClinicCalendarBlockChange,
  ClinicCalendarUnblockChange,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";

export type ClinicCode = "KABALAKA_CLINIC" | "CPU_CLINIC";

export type ClinicCalendarPlanningContext = {
  finalBlockedByClinicCode: Map<ClinicCode, Set<string>>;
  projectedLoadByClinicCode: Map<ClinicCode, Map<string, number>>;
  maxCapacityByClinicCode: Map<ClinicCode, number>;
  retiringReplacementIds: Set<string>;
  restoringOriginalIds: Set<string>;
  searchEndDate: string;
};

type LockedAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  schedulePairId: string | null;
  scheduleCycleStart: number;
  isManuallyLocked: boolean;
  hasProtectedResult: boolean;
  createdAt: Date;
};

export type ClinicBlockPlan = {
  change: ClinicCalendarBlockChange;
  clinicCode: ClinicCode;
  affectedAppointmentIds: string[];
  replacements: Array<{
    oldAppointmentId: string;
    studentNumber: string;
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
    appointmentDate: string;
    schedulePairId: string;
    scheduleCycleStart: number;
  }>;
  affectedAppointments: LockedAppointment[];
};

export type BlockImpact = {
  blockId: string;
  studentNumbers: string[];
  movedStudentCount: number;
  movedAppointmentCount: number;
};

export type ClinicRestorationPlanningContext = ClinicCalendarPlanningContext & {
  change: ClinicCalendarUnblockChange;
};

export type ClinicRestorationMove = {
  eventId: string;
  clinicUnavailableDateId: string;
  studentNumber: string;
  schedulePairId: string;
  scheduleCycleStart: number;
  scheduleType: RestorationScheduleType;
  originalAppointmentId: string;
  originalDate: string;
  replacementAppointmentId: string;
  replacementDate: string;
};

export type ClinicRestorationPlan = {
  change: ClinicCalendarUnblockChange;
  clinicCode: ClinicCode;
  blockId: string;
  eventIds: string[];
  moves: ClinicRestorationMove[];
};

export type RestorationImpact = {
  blockId: string;
  studentNumbers: string[];
  restoredStudentCount: number;
  restoredAppointmentCount: number;
  moves: ClinicRestorationMove[];
};

export function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function datesBetween(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function batchRejection(issue: ClinicCalendarBatchIssue) {
  return new AppError(
    "CLINIC_CALENDAR_BATCH_REJECTED",
    "No calendar changes were saved.",
    409,
    undefined,
    { issues: [issue] },
  );
}

function issueFor(
  change: ClinicCalendarBatchChange,
  code: ClinicCalendarBatchIssue["code"],
  message: string,
  appointments: Array<{ id: string; studentNumber: string }> = [],
): ClinicCalendarBatchIssue {
  return {
    clinicId: change.clinicId,
    date: change.date,
    action: change.action,
    code,
    message,
    ...(appointments.length
      ? {
          studentNumbers: [...new Set(appointments.map((appointment) => appointment.studentNumber))].sort(),
          appointmentIds: appointments.map((appointment) => appointment.id).sort(),
        }
      : {}),
  };
}

export function buildFinalBlockedSets(
  activeRecords: ClinicUnavailableDateDto[],
  changes: ClinicCalendarBatchChange[],
) {
  const blockedByClinicId = new Map<string, Set<string>>();
  for (const record of activeRecords) {
    const blocked = blockedByClinicId.get(record.clinicId) ?? new Set<string>();
    for (const date of datesBetween(record.startDate, record.endDate)) blocked.add(date);
    blockedByClinicId.set(record.clinicId, blocked);
  }
  for (const change of changes) {
    const blocked = blockedByClinicId.get(change.clinicId) ?? new Set<string>();
    if (change.action === "BLOCK") blocked.add(change.date);
    else blocked.delete(change.date);
    blockedByClinicId.set(change.clinicId, blocked);
  }
  return blockedByClinicId;
}

export function sortClinicCalendarChanges<T extends ClinicCalendarBatchChange>(changes: T[]): T[] {
  return [...changes].sort((left, right) => (
    left.date.localeCompare(right.date) || left.clinicId.localeCompare(right.clinicId)
  ));
}

export function reserveFirstAvailableDate(
  context: ClinicCalendarPlanningContext,
  clinicCode: ClinicCode,
  startDate: string,
) {
  const blocked = context.finalBlockedByClinicCode.get(clinicCode) ?? new Set<string>();
  const projectedLoad = context.projectedLoadByClinicCode.get(clinicCode) ?? new Map<string, number>();
  const capacity = Math.max(0, context.maxCapacityByClinicCode.get(clinicCode) ?? 0);
  for (let date = startDate; date <= context.searchEndDate; date = addCalendarDays(date, 1)) {
    if (!isWeekday(date) || blocked.has(date)) continue;
    if ((projectedLoad.get(date) ?? 0) >= capacity) continue;
    projectedLoad.set(date, (projectedLoad.get(date) ?? 0) + 1);
    context.projectedLoadByClinicCode.set(clinicCode, projectedLoad);
    return date;
  }
  return null;
}

export async function createPlanningContext(
  client: PoolClient,
  activeRecords: ClinicUnavailableDateDto[],
  changes: ClinicCalendarBatchChange[],
): Promise<ClinicCalendarPlanningContext> {
  const capacityRows = await client.query<{
    clinic_id: string;
    clinic_code: ClinicCode;
    max_daily_capacity: number;
  }>(
    `SELECT setting.clinic_id::text, clinic.code AS clinic_code,
            setting.max_daily_capacity
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE (clinic.code='KABALAKA_CLINIC' AND setting.schedule_type='LABORATORY')
         OR (clinic.code='CPU_CLINIC' AND setting.schedule_type='PHYSICAL_EXAM')`,
  );
  const clinicCodeById = new Map(capacityRows.rows.map((row) => [row.clinic_id, row.clinic_code]));
  for (const record of activeRecords) {
    if (record.clinicCode === "KABALAKA_CLINIC" || record.clinicCode === "CPU_CLINIC") {
      clinicCodeById.set(record.clinicId, record.clinicCode);
    }
  }
  const finalBlockedByClinicId = buildFinalBlockedSets(activeRecords, changes);
  const finalBlockedByClinicCode = new Map<ClinicCode, Set<string>>([
    ["KABALAKA_CLINIC", new Set()],
    ["CPU_CLINIC", new Set()],
  ]);
  for (const [clinicId, dates] of finalBlockedByClinicId) {
    const clinicCode = clinicCodeById.get(clinicId);
    if (!clinicCode) continue;
    const target = finalBlockedByClinicCode.get(clinicCode)!;
    for (const date of dates) target.add(date);
  }

  const sortedDates = changes.map((change) => change.date).sort();
  const earliestFutureDate = addCalendarDays(manilaToday(), 1);
  const searchStartDate = [sortedDates[0] ?? earliestFutureDate, earliestFutureDate].sort()[0];
  const searchEndDate = addCalendarDays(sortedDates.at(-1) ?? searchStartDate, 366 * 5);
  const loadRows = await client.query<{
    clinic_code: ClinicCode;
    date: string;
    count: number;
  }>(
    `SELECT clinic.code AS clinic_code, appointment.appointment_date::text AS date,
            COUNT(*)::int AS count
       FROM appointments appointment
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
      WHERE appointment.appointment_date BETWEEN $1::date AND $2::date
        AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
      GROUP BY clinic.code, appointment.appointment_date`,
    [searchStartDate, searchEndDate],
  );
  const projectedLoadByClinicCode = new Map<ClinicCode, Map<string, number>>([
    ["KABALAKA_CLINIC", new Map()],
    ["CPU_CLINIC", new Map()],
  ]);
  for (const row of loadRows.rows) {
    projectedLoadByClinicCode.get(row.clinic_code)?.set(row.date, row.count);
  }
  const maxCapacityByClinicCode = new Map<ClinicCode, number>();
  for (const row of capacityRows.rows) {
    maxCapacityByClinicCode.set(row.clinic_code, row.max_daily_capacity);
  }
  if (!maxCapacityByClinicCode.has("KABALAKA_CLINIC") || !maxCapacityByClinicCode.has("CPU_CLINIC")) {
    throw new AppError(
      "SCHEDULE_CAPACITY_NOT_CONFIGURED",
      "Both clinic capacity settings are required before editing the clinic calendar.",
      409,
    );
  }
  return {
    finalBlockedByClinicCode,
    projectedLoadByClinicCode,
    maxCapacityByClinicCode,
    retiringReplacementIds: new Set(),
    restoringOriginalIds: new Set(),
    searchEndDate,
  };
}

async function lockAppointmentsOnDate(
  client: PoolClient,
  clinicId: string,
  date: string,
) {
  const result = await client.query<{
    id: string;
    student_number: string;
    schedule_type: LockedAppointment["scheduleType"];
    appointment_date: string;
    status: string;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    is_manually_locked: boolean;
    has_protected_result: boolean;
    created_at: Date;
  }>(
    `SELECT appointment.id::text, appointment.student_number, appointment.schedule_type,
            appointment.appointment_date::text, appointment.status,
            appointment.schedule_pair_id::text, appointment.schedule_cycle_start,
            appointment.is_manually_locked, appointment.created_at,
            (
              EXISTS (SELECT 1 FROM student_result_submissions submission
                        WHERE submission.appointment_id=appointment.id
                          AND submission.status='FINALIZED')
              OR EXISTS (SELECT 1 FROM laboratory_results result
                          WHERE result.appointment_id=appointment.id
                            AND result.result_status <> 'PENDING_UPLOAD')
              OR EXISTS (SELECT 1 FROM exam_results result
                          WHERE result.appointment_id=appointment.id
                            AND result.result_status <> 'PENDING_UPLOAD')
            ) AS has_protected_result
       FROM appointments appointment
      WHERE appointment.clinic_id=$1
        AND appointment.appointment_date=$2::date
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.appointment_date, appointment.student_number, appointment.id
      FOR UPDATE OF appointment`,
    [clinicId, date],
  );
  return result.rows.map((row): LockedAppointment => ({
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    isManuallyLocked: row.is_manually_locked,
    hasProtectedResult: row.has_protected_result,
    createdAt: row.created_at,
  }));
}

async function lockAppointmentsByPair(client: PoolClient, pairIds: string[]) {
  if (!pairIds.length) return [];
  const result = await client.query<{
    id: string;
    student_number: string;
    schedule_type: LockedAppointment["scheduleType"];
    appointment_date: string;
    status: string;
    schedule_pair_id: string;
    schedule_cycle_start: number;
    is_manually_locked: boolean;
    has_protected_result: boolean;
    created_at: Date;
  }>(
    `SELECT appointment.id::text, appointment.student_number, appointment.schedule_type,
            appointment.appointment_date::text, appointment.status,
            appointment.schedule_pair_id::text, appointment.schedule_cycle_start,
            appointment.is_manually_locked, appointment.created_at,
            (
              EXISTS (SELECT 1 FROM student_result_submissions submission
                        WHERE submission.appointment_id=appointment.id
                          AND submission.status='FINALIZED')
              OR EXISTS (SELECT 1 FROM laboratory_results result
                          WHERE result.appointment_id=appointment.id
                            AND result.result_status <> 'PENDING_UPLOAD')
              OR EXISTS (SELECT 1 FROM exam_results result
                          WHERE result.appointment_id=appointment.id
                            AND result.result_status <> 'PENDING_UPLOAD')
            ) AS has_protected_result
       FROM appointments appointment
      WHERE appointment.schedule_pair_id=ANY($1::uuid[])
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.student_number, appointment.schedule_type, appointment.id
      FOR UPDATE OF appointment`,
    [pairIds],
  );
  return result.rows.map((row): LockedAppointment => ({
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    isManuallyLocked: row.is_manually_locked,
    hasProtectedResult: row.has_protected_result,
    createdAt: row.created_at,
  }));
}

function clinicCodeForScheduleType(scheduleType: LockedAppointment["scheduleType"]): ClinicCode {
  return scheduleType === "LABORATORY" ? "KABALAKA_CLINIC" : "CPU_CLINIC";
}

function releaseProjectedLoad(context: ClinicCalendarPlanningContext, appointment: LockedAppointment) {
  const load = context.projectedLoadByClinicCode.get(clinicCodeForScheduleType(appointment.scheduleType));
  if (!load) return;
  load.set(appointment.appointmentDate, Math.max(0, (load.get(appointment.appointmentDate) ?? 0) - 1));
}

function pairIntegrityFailure(
  change: ClinicCalendarBlockChange,
  appointments: LockedAppointment[],
) {
  throw batchRejection(issueFor(
    change,
    "PAIR_INTEGRITY_FAILURE",
    "An affected student no longer has one complete Laboratory and Physical Examination pair.",
    appointments,
  ));
}

export async function planClinicBlock(
  client: PoolClient,
  change: ClinicCalendarBlockChange,
  context: ClinicCalendarPlanningContext,
): Promise<ClinicBlockPlan> {
  const clinic = await client.query<{ code: ClinicCode }>(
    `SELECT code FROM clinics
      WHERE id=$1 AND code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
    [change.clinicId],
  );
  if (!clinic.rowCount) {
    throw batchRejection(issueFor(
      change,
      "INVALID_CHANGE",
      "Clinic not found or does not support calendar editing.",
    ));
  }
  const clinicCode = clinic.rows[0].code;
  const affected = (await lockAppointmentsOnDate(client, change.clinicId, change.date))
    .filter((appointment) => !context.retiringReplacementIds.has(appointment.id));
  const pairIds = [...new Set(affected.flatMap((appointment) => (
    appointment.schedulePairId ? [appointment.schedulePairId] : []
  )))].sort();
  if (affected.some((appointment) => !appointment.schedulePairId)) {
    pairIntegrityFailure(change, affected.filter((appointment) => !appointment.schedulePairId));
  }
  const pairAppointments = await lockAppointmentsByPair(client, pairIds);
  const pairMembers = new Map<string, LockedAppointment[]>();
  for (const appointment of pairAppointments) {
    if (!appointment.schedulePairId) continue;
    pairMembers.set(appointment.schedulePairId, [
      ...(pairMembers.get(appointment.schedulePairId) ?? []),
      appointment,
    ]);
  }

  const appointmentsToMove = clinicCode === "KABALAKA_CLINIC"
    ? [...new Map(pairIds.flatMap((pairId) => (
        (pairMembers.get(pairId) ?? []).map((appointment) => [appointment.id, appointment] as const)
      ))).values()]
    : affected;
  if (appointmentsToMove.some((appointment) => context.retiringReplacementIds.has(appointment.id))) {
    pairIntegrityFailure(change, appointmentsToMove);
  }
  for (const pairId of pairIds) {
    const members = pairMembers.get(pairId) ?? [];
    const laboratory = members.filter((appointment) => appointment.scheduleType === "LABORATORY");
    const physical = members.filter((appointment) => appointment.scheduleType === "PHYSICAL_EXAM");
    if (
      laboratory.length !== 1
      || physical.length !== 1
      || laboratory[0].studentNumber !== physical[0].studentNumber
    ) {
      pairIntegrityFailure(change, members);
    }
  }
  if (clinicCode === "CPU_CLINIC" && affected.some((appointment) => (
    appointment.scheduleType !== "PHYSICAL_EXAM"
  ))) {
    pairIntegrityFailure(change, affected);
  }

  await lockEffectiveAppointmentScopes(client, appointmentsToMove);
  const protectedAppointments = appointmentsToMove.filter((appointment) => (
    appointment.status !== "PENDING"
    || appointment.isManuallyLocked
    || appointment.hasProtectedResult
  ));
  if (protectedAppointments.length) {
    throw batchRejection(issueFor(
      change,
      "PROTECTED_REPLACEMENT",
      "Some affected appointments are protected and require manual resolution.",
      protectedAppointments,
    ));
  }

  for (const appointment of appointmentsToMove) releaseProjectedLoad(context, appointment);
  for (const appointment of appointmentsToMove) context.retiringReplacementIds.add(appointment.id);

  const replacements: ClinicBlockPlan["replacements"] = [];
  if (clinicCode === "KABALAKA_CLINIC") {
    const affectedPairs = pairIds
      .map((pairId) => [pairId, pairMembers.get(pairId) ?? []] as const)
      .sort((left, right) => {
        const leftLab = left[1].find((appointment) => appointment.scheduleType === "LABORATORY")!;
        const rightLab = right[1].find((appointment) => appointment.scheduleType === "LABORATORY")!;
        return leftLab.appointmentDate.localeCompare(rightLab.appointmentDate)
          || leftLab.studentNumber.localeCompare(rightLab.studentNumber)
          || left[0].localeCompare(right[0]);
      });
    for (const [, members] of affectedPairs) {
      const oldLaboratory = members.find((appointment) => appointment.scheduleType === "LABORATORY")!;
      const oldPhysical = members.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")!;
      const laboratoryDate = reserveFirstAvailableDate(
        context,
        "KABALAKA_CLINIC",
        oldLaboratory.appointmentDate,
      );
      const physicalDate = laboratoryDate
        ? reserveFirstAvailableDate(context, "CPU_CLINIC", addCalendarDays(laboratoryDate, 1))
        : null;
      if (!laboratoryDate || !physicalDate) {
        throw batchRejection(issueFor(
          change,
          "CAPACITY_CONFLICT",
          "Affected appointments could not be replaced within the scheduling horizon.",
          members,
        ));
      }
      const newPairId = randomUUID();
      replacements.push(
        {
          oldAppointmentId: oldLaboratory.id,
          studentNumber: oldLaboratory.studentNumber,
          scheduleType: "LABORATORY",
          appointmentDate: laboratoryDate,
          schedulePairId: newPairId,
          scheduleCycleStart: oldLaboratory.scheduleCycleStart,
        },
        {
          oldAppointmentId: oldPhysical.id,
          studentNumber: oldPhysical.studentNumber,
          scheduleType: "PHYSICAL_EXAM",
          appointmentDate: physicalDate,
          schedulePairId: newPairId,
          scheduleCycleStart: oldPhysical.scheduleCycleStart,
        },
      );
    }
  } else {
    const earliestReplacementDate = addCalendarDays(manilaToday(), 1);
    for (const oldPhysical of affected) {
      const members = pairMembers.get(oldPhysical.schedulePairId!) ?? [];
      const laboratory = members.find((appointment) => appointment.scheduleType === "LABORATORY")!;
      const pairedPhysicalStart = addCalendarDays(laboratory.appointmentDate, 1);
      const physicalDate = reserveFirstAvailableDate(
        context,
        "CPU_CLINIC",
        pairedPhysicalStart > earliestReplacementDate ? pairedPhysicalStart : earliestReplacementDate,
      );
      if (!physicalDate) {
        throw batchRejection(issueFor(
          change,
          "CAPACITY_CONFLICT",
          "Affected appointments could not be replaced within the scheduling horizon.",
          [oldPhysical],
        ));
      }
      replacements.push({
        oldAppointmentId: oldPhysical.id,
        studentNumber: oldPhysical.studentNumber,
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: physicalDate,
        schedulePairId: oldPhysical.schedulePairId!,
        scheduleCycleStart: oldPhysical.scheduleCycleStart,
      });
    }
  }

  return {
    change,
    clinicCode,
    affectedAppointmentIds: appointmentsToMove.map((appointment) => appointment.id),
    replacements,
    affectedAppointments: appointmentsToMove,
  };
}

function restorationRejection(
  change: ClinicCalendarUnblockChange,
  code: ClinicCalendarBatchIssue["code"],
  message: string,
  appointments: LockedRestorationAppointment[] = [],
): never {
  throw batchRejection(issueFor(change, code, message, appointments));
}

function restorationClinicCode(scheduleType: RestorationScheduleType): ClinicCode {
  return scheduleType === "LABORATORY" ? "KABALAKA_CLINIC" : "CPU_CLINIC";
}

function restorationPairFailure(
  change: ClinicCalendarUnblockChange,
  appointments: Array<LockedRestorationAppointment | null>,
): never {
  restorationRejection(
    change,
    "PAIR_INTEGRITY_FAILURE",
    "The original clinic pair and its generated replacements can no longer be restored together.",
    appointments.filter((appointment): appointment is LockedRestorationAppointment => Boolean(appointment)),
  );
}

function isUnsafeReplacement(appointment: LockedRestorationAppointment) {
  return appointment.status !== "PENDING"
    || !appointment.isPublished
    || appointment.isManuallyLocked
    || appointment.hasFinalizedSubmission
    || appointment.hasProtectedResult
    || appointment.hasPublishedReplacement
    || appointment.publishedReplacementChildren.length > 0;
}

function isRestorationLineageValid(input: {
  eventStudentNumber: string;
  scheduleType: RestorationScheduleType;
  original: LockedRestorationAppointment;
  replacement: LockedRestorationAppointment;
}) {
  const { eventStudentNumber, scheduleType, original, replacement } = input;
  return Boolean(
    original.schedulePairId
    && replacement.schedulePairId
    && original.studentNumber === eventStudentNumber
    && replacement.studentNumber === eventStudentNumber
    && original.scheduleType === scheduleType
    && replacement.scheduleType === scheduleType
    && original.clinicId === replacement.clinicId
    && original.scheduleCycleStart === replacement.scheduleCycleStart
    && replacement.rescheduledFrom === original.id
  );
}

function assertRestorationMoveSafe(
  bundle: ClinicRestorationBundle,
  context: ClinicRestorationPlanningContext,
  event: ClinicRestorationBundle["events"][number],
  scheduleType: RestorationScheduleType,
  original: LockedRestorationAppointment,
  replacement: LockedRestorationAppointment,
) {
  const pairFailure = bundle.clinicCode === "KABALAKA_CLINIC";
  const fail = (
    code: ClinicCalendarBatchIssue["code"],
    message: string,
    appointments: LockedRestorationAppointment[],
  ): never => {
    if (pairFailure) restorationPairFailure(context.change, appointments);
    restorationRejection(context.change, code, message, appointments);
  };

  if (!isRestorationLineageValid({
    eventStudentNumber: event.studentNumber,
    scheduleType,
    original,
    replacement,
  })) {
    fail(
      "PAIR_INTEGRITY_FAILURE",
      "The stored reschedule event no longer matches its appointment lineage.",
      [original, replacement],
    );
  }
  if (original.status !== "RESCHEDULED" || !original.isPublished) {
    fail(
      "MISSING_ORIGINAL",
      "The original appointment is missing or is no longer safely restorable.",
      [original],
    );
  }
  if (isUnsafeReplacement(replacement)) {
    fail(
      "PROTECTED_REPLACEMENT",
      "A generated replacement is protected and requires manual resolution.",
      [replacement],
    );
  }
  const unexpectedActiveConflicts = original.activeConflictIds.filter((appointmentId) => (
    appointmentId !== replacement.id
    && !context.retiringReplacementIds.has(appointmentId)
  ));
  if (unexpectedActiveConflicts.length) {
    fail(
      "PROTECTED_REPLACEMENT",
      "Another active appointment conflicts with restoration of the original appointment.",
      [original],
    );
  }
  if (context.restoringOriginalIds.has(original.id) || context.retiringReplacementIds.has(replacement.id)) {
    fail(
      "PAIR_INTEGRITY_FAILURE",
      "An appointment is referenced by more than one calendar restoration.",
      [original, replacement],
    );
  }
  const finalBlocked = context.finalBlockedByClinicCode.get(restorationClinicCode(scheduleType));
  if (finalBlocked?.has(original.appointmentDate)) {
    fail(
      "PROTECTED_REPLACEMENT",
      "The original appointment date remains blocked in the final calendar.",
      [original],
    );
  }
}

export function planClinicRestoration(
  bundle: ClinicRestorationBundle,
  context: ClinicRestorationPlanningContext,
): ClinicRestorationPlan {
  const { change } = context;
  if (
    bundle.block.id !== change.unavailableDateId
    || bundle.block.clinicId !== change.clinicId
    || bundle.block.startDate !== change.date
    || bundle.block.endDate !== change.date
    || bundle.block.updatedAt !== change.expectedUpdatedAt
  ) {
    restorationRejection(
      change,
      "STALE_BLOCK",
      "The clinic block changed or is no longer active. Refresh the calendar and try again.",
    );
  }

  const moves: ClinicRestorationMove[] = [];
  for (const event of bundle.events) {
    if (event.restoredAt) {
      if (bundle.clinicCode === "KABALAKA_CLINIC") {
        restorationPairFailure(change, [
          event.oldLaboratory,
          event.newLaboratory,
          event.oldPhysicalExam,
          event.newPhysicalExam,
        ]);
      }
      restorationRejection(
        change,
        "PROTECTED_REPLACEMENT",
        "A reschedule event has already been restored.",
      );
    }

    if (bundle.clinicCode === "KABALAKA_CLINIC") {
      const members = [
        event.oldLaboratory,
        event.newLaboratory,
        event.oldPhysicalExam,
        event.newPhysicalExam,
      ];
      if (members.some((appointment) => !appointment)) {
        restorationPairFailure(change, members);
      }
      const oldLaboratory = event.oldLaboratory!;
      const newLaboratory = event.newLaboratory!;
      const oldPhysicalExam = event.oldPhysicalExam!;
      const newPhysicalExam = event.newPhysicalExam!;
      if (
        oldLaboratory.schedulePairId !== oldPhysicalExam.schedulePairId
        || oldLaboratory.scheduleCycleStart !== oldPhysicalExam.scheduleCycleStart
        || newLaboratory.schedulePairId !== newPhysicalExam.schedulePairId
        || newLaboratory.schedulePairId !== event.schedulePairId
        || newLaboratory.scheduleCycleStart !== newPhysicalExam.scheduleCycleStart
        || oldLaboratory.scheduleCycleStart !== newLaboratory.scheduleCycleStart
        || oldLaboratory.studentNumber !== oldPhysicalExam.studentNumber
        || oldLaboratory.studentNumber !== event.studentNumber
        || oldLaboratory.appointmentDate !== bundle.block.startDate
        || oldLaboratory.clinicId !== bundle.block.clinicId
        || newLaboratory.clinicId !== bundle.block.clinicId
        || oldPhysicalExam.clinicId === bundle.block.clinicId
        || newPhysicalExam.clinicId === bundle.block.clinicId
      ) {
        restorationPairFailure(change, members);
      }
      // KABALAKA events retain the original pair together, while the event's pair id
      // identifies the generated replacement pair.
      assertRestorationMoveSafe(
        bundle,
        context,
        event,
        "LABORATORY",
        oldLaboratory,
        newLaboratory,
      );
      assertRestorationMoveSafe(
        bundle,
        context,
        event,
        "PHYSICAL_EXAM",
        oldPhysicalExam,
        newPhysicalExam,
      );
      moves.push(
        {
          eventId: event.id,
          clinicUnavailableDateId: bundle.block.id,
          studentNumber: event.studentNumber,
          schedulePairId: oldLaboratory.schedulePairId!,
          scheduleCycleStart: oldLaboratory.scheduleCycleStart,
          scheduleType: "LABORATORY",
          originalAppointmentId: oldLaboratory.id,
          originalDate: oldLaboratory.appointmentDate,
          replacementAppointmentId: newLaboratory.id,
          replacementDate: newLaboratory.appointmentDate,
        },
        {
          eventId: event.id,
          clinicUnavailableDateId: bundle.block.id,
          studentNumber: event.studentNumber,
          schedulePairId: oldPhysicalExam.schedulePairId!,
          scheduleCycleStart: oldPhysicalExam.scheduleCycleStart,
          scheduleType: "PHYSICAL_EXAM",
          originalAppointmentId: oldPhysicalExam.id,
          originalDate: oldPhysicalExam.appointmentDate,
          replacementAppointmentId: newPhysicalExam.id,
          replacementDate: newPhysicalExam.appointmentDate,
        },
      );
    } else {
      if (!event.oldPhysicalExam) {
        restorationRejection(
          change,
          "MISSING_ORIGINAL",
          "The original Physical Examination appointment is missing.",
        );
      }
      if (!event.newPhysicalExam) {
        restorationRejection(
          change,
          "PROTECTED_REPLACEMENT",
          "The generated Physical Examination replacement is missing.",
          [event.oldPhysicalExam],
        );
      }
      if (
        event.oldLaboratory
        || event.newLaboratory
        || event.oldPhysicalExam.appointmentDate !== bundle.block.startDate
        || event.oldPhysicalExam.clinicId !== bundle.block.clinicId
        || event.newPhysicalExam.clinicId !== bundle.block.clinicId
        || !event.schedulePairId
        || event.oldPhysicalExam.schedulePairId !== event.schedulePairId
        || event.newPhysicalExam.schedulePairId !== event.schedulePairId
      ) {
        restorationPairFailure(change, [
          event.oldLaboratory,
          event.newLaboratory,
          event.oldPhysicalExam,
          event.newPhysicalExam,
        ]);
      }
      assertRestorationMoveSafe(
        bundle,
        context,
        event,
        "PHYSICAL_EXAM",
        event.oldPhysicalExam,
        event.newPhysicalExam,
      );
      moves.push({
        eventId: event.id,
        clinicUnavailableDateId: bundle.block.id,
        studentNumber: event.studentNumber,
        schedulePairId: event.oldPhysicalExam.schedulePairId!,
        scheduleCycleStart: event.oldPhysicalExam.scheduleCycleStart,
        scheduleType: "PHYSICAL_EXAM",
        originalAppointmentId: event.oldPhysicalExam.id,
        originalDate: event.oldPhysicalExam.appointmentDate,
        replacementAppointmentId: event.newPhysicalExam.id,
        replacementDate: event.newPhysicalExam.appointmentDate,
      });
    }
  }

  const originalIds = moves.map((move) => move.originalAppointmentId);
  const replacementIds = moves.map((move) => move.replacementAppointmentId);
  if (
    new Set(originalIds).size !== originalIds.length
    || new Set(replacementIds).size !== replacementIds.length
  ) {
    restorationPairFailure(change, bundle.events.flatMap((event) => [
      event.oldLaboratory,
      event.newLaboratory,
      event.oldPhysicalExam,
      event.newPhysicalExam,
    ]));
  }

  const projected = new Map<ClinicCode, Map<string, number>>([
    ["KABALAKA_CLINIC", new Map(context.projectedLoadByClinicCode.get("KABALAKA_CLINIC"))],
    ["CPU_CLINIC", new Map(context.projectedLoadByClinicCode.get("CPU_CLINIC"))],
  ]);
  for (const move of moves) {
    const clinicCode = restorationClinicCode(move.scheduleType);
    const load = projected.get(clinicCode)!;
    load.set(move.replacementDate, Math.max(0, (load.get(move.replacementDate) ?? 0) - 1));
  }
  for (const move of moves) {
    const clinicCode = restorationClinicCode(move.scheduleType);
    const load = projected.get(clinicCode)!;
    const restoredLoad = (load.get(move.originalDate) ?? 0) + 1;
    if (restoredLoad > (context.maxCapacityByClinicCode.get(clinicCode) ?? 0)) {
      if (bundle.clinicCode === "KABALAKA_CLINIC") {
        restorationPairFailure(change, bundle.events.flatMap((event) => [
          event.oldLaboratory,
          event.newLaboratory,
          event.oldPhysicalExam,
          event.newPhysicalExam,
        ]));
      }
      restorationRejection(
        change,
        "CAPACITY_CONFLICT",
        "The original appointment date is already at capacity.",
      );
    }
    load.set(move.originalDate, restoredLoad);
  }

  context.projectedLoadByClinicCode.set("KABALAKA_CLINIC", projected.get("KABALAKA_CLINIC")!);
  context.projectedLoadByClinicCode.set("CPU_CLINIC", projected.get("CPU_CLINIC")!);
  for (const move of moves) {
    context.retiringReplacementIds.add(move.replacementAppointmentId);
    context.restoringOriginalIds.add(move.originalAppointmentId);
  }
  return {
    change,
    clinicCode: bundle.clinicCode,
    blockId: bundle.block.id,
    eventIds: bundle.events.map((event) => event.id),
    moves,
  };
}

function assertMutationCount(
  plan: ClinicRestorationPlan,
  label: string,
  actual: number | null,
  expected: number,
) {
  if (actual === expected) return;
  restorationRejection(
    plan.change,
    "PROTECTED_REPLACEMENT",
    `Clinic restoration changed concurrently while ${label}.`,
  );
}

export async function applyClinicRestorationPlan(
  client: PoolClient,
  plan: ClinicRestorationPlan,
  actor: SessionUser,
  batchId: string,
): Promise<RestorationImpact> {
  const replacementIds = plan.moves.map((move) => move.replacementAppointmentId);
  const originalIds = plan.moves.map((move) => move.originalAppointmentId);
  const notes = `Clinic unavailable date reversed. Batch ${batchId}.`;

  // Retire every generated replacement first. Activating originals first can violate
  // appointments_one_active_service_cycle_idx even inside the same transaction.
  if (replacementIds.length) {
    const retired = await client.query(
      `UPDATE appointments
          SET status='RESCHEDULED', is_published=FALSE,
              updated_by=$2, updated_at=NOW()
        WHERE id=ANY($1::uuid[])
          AND status='PENDING'
          AND is_published=TRUE`,
      [replacementIds, actor.userId],
    );
    assertMutationCount(plan, "retiring generated replacements", retired.rowCount, replacementIds.length);
    const logs = await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) SELECT id, 'PENDING', 'RESCHEDULED', $3, $2
           FROM UNNEST($1::uuid[]) AS fixture(id)`,
      [replacementIds, actor.userId, notes],
    );
    assertMutationCount(plan, "logging retired replacements", logs.rowCount, replacementIds.length);
  }

  if (originalIds.length) {
    const restored = await client.query(
      `UPDATE appointments
          SET status='PENDING', updated_by=$2, updated_at=NOW()
        WHERE id=ANY($1::uuid[]) AND status='RESCHEDULED'`,
      [originalIds, actor.userId],
    );
    assertMutationCount(plan, "restoring original appointments", restored.rowCount, originalIds.length);
    const logs = await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) SELECT id, 'RESCHEDULED', 'PENDING', $3, $2
           FROM UNNEST($1::uuid[]) AS fixture(id)`,
      [originalIds, actor.userId, notes],
    );
    assertMutationCount(plan, "logging restored originals", logs.rowCount, originalIds.length);
  }

  if (plan.eventIds.length) {
    const events = await client.query(
      `UPDATE appointment_reschedule_events
          SET restored_at=NOW(), restored_by=$2, restoration_batch_id=$3
        WHERE id=ANY($1::uuid[]) AND restored_at IS NULL`,
      [plan.eventIds, actor.userId, batchId],
    );
    assertMutationCount(plan, "marking reschedule events restored", events.rowCount, plan.eventIds.length);
  }

  const unblocked = await softUnblockClinicUnavailableDate(client, {
    id: plan.blockId,
    expectedUpdatedAt: plan.change.expectedUpdatedAt,
    actorUserId: actor.userId,
    batchId,
  });
  assertMutationCount(plan, "soft-unblocking the clinic date", unblocked ? 1 : 0, 1);

  const studentNumbers = [...new Set(plan.moves.map((move) => move.studentNumber))].sort();
  const unblockAudit = await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,'CLINIC_UNAVAILABLE_DATE_UNBLOCKED','clinic_unavailable_date',$2,
             jsonb_build_object(
               'batchId',$3::text,
               'clinicId',$4::text,
               'date',$5::text,
               'restoredStudentCount',$6::int,
               'restoredAppointmentCount',$7::int
             ))`,
    [
      actor.userId,
      plan.blockId,
      batchId,
      plan.change.clinicId,
      plan.change.date,
      studentNumbers.length,
      plan.moves.length,
    ],
  );
  assertMutationCount(plan, "auditing the unavailable-date unblock", unblockAudit.rowCount, 1);
  const restorationAudit = await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,'CLINIC_BLOCK_APPOINTMENTS_RESTORED','clinic_unavailable_date',$2,
             jsonb_build_object(
               'batchId',$3::text,
               'restoredStudentCount',$4::int,
               'restoredAppointmentCount',$5::int,
               'eventIds',$6::jsonb
             ))`,
    [
      actor.userId,
      plan.blockId,
      batchId,
      studentNumbers.length,
      plan.moves.length,
      JSON.stringify(plan.eventIds),
    ],
  );
  assertMutationCount(plan, "auditing restored appointments", restorationAudit.rowCount, 1);

  return {
    blockId: plan.blockId,
    studentNumbers,
    restoredStudentCount: studentNumbers.length,
    restoredAppointmentCount: plan.moves.length,
    moves: plan.moves,
  };
}

export async function applyClinicBlockPlan(
  client: PoolClient,
  plan: ClinicBlockPlan,
  actor: SessionUser,
  batchId: string,
): Promise<BlockImpact> {
  const blockId = await insertClinicUnavailableDate(client, plan.change, actor.userId, batchId);
  if (plan.affectedAppointmentIds.length) {
    await client.query(
      `UPDATE appointments SET status='RESCHEDULED', updated_by=$2, updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [plan.affectedAppointmentIds, actor.userId],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       ) SELECT id, 'PENDING', 'RESCHEDULED',
                'Clinic unavailable date created. Batch ' || $3::text || '.', $2
           FROM UNNEST($1::uuid[]) AS fixture(id)`,
      [plan.affectedAppointmentIds, actor.userId, batchId],
    );
  }

  const clinicRows = await client.query<{ id: string; code: ClinicCode }>(
    `SELECT id::text, code FROM clinics
      WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
  );
  const clinicIdByCode = new Map(clinicRows.rows.map((row) => [row.code, row.id]));
  const insertedReplacements: Array<ClinicBlockPlan["replacements"][number] & { id: string }> = [];
  for (const replacement of plan.replacements) {
    const destinationClinicId = clinicIdByCode.get(clinicCodeForScheduleType(replacement.scheduleType));
    if (!destinationClinicId) {
      throw new AppError("CLINIC_NOT_FOUND", "Clinic not found.", 404);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date, status,
         is_published, notes, rescheduled_from, created_by, updated_by,
         schedule_pair_id, schedule_cycle_start
       ) VALUES ($1,$2,$3,$4,'PENDING',TRUE,$5,$6,$7,$7,$8,$9)
       RETURNING id::text`,
      [
        destinationClinicId,
        replacement.studentNumber,
        replacement.scheduleType,
        replacement.appointmentDate,
        `Automatically rescheduled for clinic block: ${plan.change.reason}`,
        replacement.oldAppointmentId,
        actor.userId,
        replacement.schedulePairId,
        replacement.scheduleCycleStart,
      ],
    );
    insertedReplacements.push({ ...replacement, id: inserted.rows[0].id });
  }
  if (insertedReplacements.length) {
    await client.query(
      `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
       SELECT id, NULL, 'PENDING',
              'Published clinic closure replacement. Batch ' || $3::text || '.', $2
         FROM UNNEST($1::uuid[]) AS fixture(id)`,
      [insertedReplacements.map((replacement) => replacement.id), actor.userId, batchId],
    );
  }

  const originalById = new Map(plan.affectedAppointments.map((appointment) => [
    appointment.id,
    appointment,
  ]));
  const replacementGroups = new Map<string, typeof insertedReplacements>();
  for (const replacement of insertedReplacements) {
    const key = `${replacement.schedulePairId}:${replacement.scheduleCycleStart}`;
    replacementGroups.set(key, [
      ...(replacementGroups.get(key) ?? []),
      replacement,
    ]);
  }
  for (const newMembers of replacementGroups.values()) {
    const originalMembers = newMembers.flatMap((replacement) => {
      const original = originalById.get(replacement.oldAppointmentId);
      return original ? [original] : [];
    });
    const studentNumber = newMembers[0].studentNumber;
    await client.query(
      `INSERT INTO appointment_reschedule_events (
         student_number, schedule_pair_id, cause, clinic_unavailable_date_id,
         old_laboratory_appointment_id, new_laboratory_appointment_id,
         old_physical_exam_appointment_id, new_physical_exam_appointment_id,
         actor_user_id, block_batch_id
       ) VALUES ($1,$2,'CLINIC_CLOSURE',$3,$4,$5,$6,$7,$8,$9)`,
      [
        studentNumber,
        newMembers[0]?.schedulePairId ?? null,
        blockId,
        originalMembers.find((appointment) => appointment.scheduleType === "LABORATORY")?.id ?? null,
        newMembers.find((appointment) => appointment.scheduleType === "LABORATORY")?.id ?? null,
        originalMembers.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.id ?? null,
        newMembers.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.id ?? null,
        actor.userId,
        batchId,
      ],
    );
  }

  const studentNumbers = [...new Set(plan.replacements.map((replacement) => replacement.studentNumber))].sort();
  for (const studentNumber of studentNumbers) {
    const originalMembers = plan.affectedAppointments.filter(
      (appointment) => appointment.studentNumber === studentNumber,
    );
    const newMembers = insertedReplacements.filter(
      (appointment) => appointment.studentNumber === studentNumber,
    );
    await createStudentNotification(client, {
      studentNumber,
      notificationType: "SCHEDULE_RESCHEDULED",
      title: "Clinic schedule updated",
      message: plan.clinicCode === "KABALAKA_CLINIC"
        ? "A clinic closure changed both clinic dates. Review your updated schedule."
        : "A clinic closure changed your Physical Examination date; your Laboratory date is unchanged.",
      metadata: {
        batchId,
        reason: plan.change.reason,
        clinicUnavailableDateId: blockId,
        previousDates: Object.fromEntries(
          originalMembers.map((appointment) => [appointment.scheduleType, appointment.appointmentDate]),
        ),
        replacementDates: Object.fromEntries(
          newMembers.map((appointment) => [appointment.scheduleType, appointment.appointmentDate]),
        ),
        moves: newMembers.map((replacement) => ({
          schedulePairId: replacement.schedulePairId,
          scheduleCycleStart: replacement.scheduleCycleStart,
          scheduleType: replacement.scheduleType,
          previousDate: originalById.get(replacement.oldAppointmentId)?.appointmentDate ?? null,
          replacementDate: replacement.appointmentDate,
        })),
      },
    });
  }
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,'CLINIC_UNAVAILABLE_DATE_CREATED','clinic_unavailable_date',$2,
             jsonb_build_object(
               'batchId',$3::text,
               'clinicId',$4::text,
               'date',$5::text,
               'movedStudentCount',$6::int,
               'movedAppointmentCount',$7::int
             ))`,
    [
      actor.userId,
      blockId,
      batchId,
      plan.change.clinicId,
      plan.change.date,
      studentNumbers.length,
      plan.affectedAppointmentIds.length,
    ],
  );
  return {
    blockId,
    studentNumbers,
    movedStudentCount: studentNumbers.length,
    movedAppointmentCount: plan.affectedAppointmentIds.length,
  };
}
