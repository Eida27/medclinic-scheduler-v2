import "server-only";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  assertManualAppointmentDestination,
  assertReplacementPairOrder,
} from "@/server/appointments/manual-appointment-destination";
import { transaction } from "@/server/db/pool";
import { lockClinicManualResolutionCases } from "../clinic-manual-resolution-locks";
import { lockAcademicYearSchedulingBoundary } from "@/server/repositories/academic-years.repository";
import { getManualRescheduleDestinationState } from "@/server/repositories/appointments.repository";
import type {
  ClinicManualCaseDto,
  ClinicManualCasePageDto,
  ClinicManualCaseReason,
  ClinicManualCaseResolutionRequest,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import { buildManualResolutionCompletedNotification } from "@/server/schedule/schedule-notifications";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import { type ClinicCycleAppointment } from "../clinic-calendar-planner";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import {
  assertAdmin,
  validationError,
  manilaToday,
  resultProtectionAuditMetadata,
  createClosureNotification,
  previousScheduleForAppointments,
} from "./recovery-shared";

const resolutionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ASSIGN_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    laboratoryDate: z.iso.date().optional(),
    physicalExamDate: z.iso.date().optional(),
    preserveLaboratory: z.boolean().optional(),
    preservePhysicalExam: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    action: z.literal("KEEP_CURRENT_REPLACEMENT"),
    expectedOptimisticToken: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  }),
]);

export type AppointmentState = ClinicCycleAppointment & {
  clinicId: string;
  rescheduledFrom: string | null;
};

type CurrentAssignmentBlock = {
  code:
    | "DRAFT_RESULT_FILES_EXIST"
    | "PROTECTED_RESULTS_EXIST"
    | "APPOINTMENT_MANUALLY_LOCKED";
  message: string;
};

export function currentAssignmentBlock(
  appointments: Array<Pick<ClinicCycleAppointment, "isManuallyLocked" | "resultProtectionState">>,
): CurrentAssignmentBlock | null {
  if (appointments.some((appointment) => appointment.isManuallyLocked)) {
    return {
      code: "APPOINTMENT_MANUALLY_LOCKED",
      message: "Unlock the affected appointment before assigning a replacement.",
    };
  }
  if (appointments.some((appointment) =>
    appointment.resultProtectionState.type === "PROTECTED"
    && appointment.resultProtectionState.reason === "DRAFT_RESULT_FILES_EXIST")) {
    return {
      code: "DRAFT_RESULT_FILES_EXIST",
      message: "Draft result files exist. Remove them from the student result profile before assigning a replacement.",
    };
  }
  if (appointments.some((appointment) => appointment.resultProtectionState.type === "PROTECTED")) {
    return {
      code: "PROTECTED_RESULTS_EXIST",
      message: "Finalized or verified results protect this appointment from replacement.",
    };
  }
  return null;
}

export async function listClinicClosureManualCases(
  raw: {
    page?: number;
    pageSize?: number;
    search?: string;
    reasonCode?: string;
    status?: string;
    closureGroupId?: string;
    importGroupId?: string;
    date?: string;
    service?: string;
    academicYearStart?: number;
  },
  actor: SessionUser,
): Promise<ClinicManualCasePageDto> {
  assertAdmin(actor);
  const page = Math.max(1, Number(raw.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(raw.pageSize) || 20));
  const search = raw.search?.trim() || null;
  const reasonCode = raw.reasonCode?.trim() || null;
  const closureGroupId = raw.closureGroupId?.trim() || null;
  const importGroupId = raw.importGroupId?.trim() || null;
  if (importGroupId && !z.uuid().safeParse(importGroupId).success) throw validationError("Choose a valid import group.");
  const date = raw.date?.trim() || null;
  const service = raw.service?.trim() || null;
  const academicYearStart = raw.academicYearStart ?? null;
  if (academicYearStart !== null && (!Number.isInteger(academicYearStart)
    || academicYearStart < 2020 || academicYearStart > 2100)) {
    throw validationError("Choose a valid academic year start.");
  }
  const status = raw.status === undefined
    ? (academicYearStart === null ? "OPEN" : null)
    : raw.status.trim() || null;
  const loaded = await transaction(async (client) => {
    const selectedYearState = academicYearStart === null ? null : (
      await client.query<{ state: "CURRENT" | "UPCOMING" | "ENDED" }>(
        `SELECT CASE
           WHEN (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date < make_date(start_year,8,1)
             THEN 'UPCOMING'
           WHEN closing_date < (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
             THEN 'ENDED'
           ELSE 'CURRENT'
         END AS state
         FROM academic_years WHERE start_year=$1`,
        [academicYearStart],
      )
    ).rows[0]?.state ?? "UNKNOWN";
    const result = await client.query<{
    id: string;
    student_number: string;
    schedule_cycle_start: number;
    student_name: string;
    case_source: ClinicManualCaseDto["caseSource"];
    closure_group_id: string | null;
    group_start_date: string | null;
    group_end_date: string | null;
    reason_code: ClinicManualCaseReason;
    reason_message: string;
    status: ClinicManualCaseDto["status"];
    optimistic_token: string;
    created_at: Date;
    resolved_at: Date | null;
    resolution_action: ClinicManualCaseDto["resolutionAction"];
    resolution_details: unknown;
    policy_metadata: Record<string, unknown>;
    category: ClinicManualCaseDto["category"];
    closure_reason: string | null;
    laboratory_id: string | null;
    laboratory_date: string | null;
    laboratory_status: string | null;
    laboratory_is_manually_locked: boolean | null;
    physical_exam_id: string | null;
    physical_exam_date: string | null;
    physical_exam_status: string | null;
    physical_exam_is_manually_locked: boolean | null;
    ovpsa_batch_optimistic_token: string | null;
    replacement_laboratory_id: string | null;
    replacement_laboratory_is_manually_locked: boolean | null;
    replacement_physical_exam_id: string | null;
    replacement_physical_exam_is_manually_locked: boolean | null;
    total: number;
  }>(
    `SELECT manual_case.id::text,manual_case.student_number,manual_case.schedule_cycle_start,
            ${studentDisplayNameSql("student")} AS student_name,
            manual_case.case_source,
            manual_case.closure_group_id::text,closure.start_date::text AS group_start_date,
            closure.end_date::text AS group_end_date,manual_case.reason_code,
            manual_case.reason_message,manual_case.status,
            manual_case.optimistic_token::text,manual_case.created_at,manual_case.resolved_at,
            manual_case.resolution_action,manual_case.resolution_details,
            manual_case.policy_metadata,
            closure.category,closure.reason AS closure_reason,
            laboratory.id::text AS laboratory_id,laboratory.appointment_date::text AS laboratory_date,
            laboratory.status AS laboratory_status,
            laboratory.is_manually_locked AS laboratory_is_manually_locked,
            physical.id::text AS physical_exam_id,physical.appointment_date::text AS physical_exam_date,
            physical.status AS physical_exam_status,
            physical.is_manually_locked AS physical_exam_is_manually_locked,
            replacement_laboratory.id::text AS replacement_laboratory_id,
            replacement_laboratory.is_manually_locked AS replacement_laboratory_is_manually_locked,
            replacement_physical.id::text AS replacement_physical_exam_id,
            replacement_physical.is_manually_locked AS replacement_physical_exam_is_manually_locked,
            ovpsa_batch.optimistic_token::text AS ovpsa_batch_optimistic_token,
            COUNT(*) OVER()::int AS total
       FROM clinic_closure_manual_cases manual_case
       JOIN academic_years academic_year ON academic_year.start_year=manual_case.schedule_cycle_start
       JOIN students student ON student.student_number=manual_case.student_number
       LEFT JOIN clinic_closure_groups closure ON closure.id=manual_case.closure_group_id
       LEFT JOIN appointments laboratory ON laboratory.id=manual_case.affected_laboratory_appointment_id
       LEFT JOIN appointments physical ON physical.id=manual_case.affected_physical_exam_appointment_id
       LEFT JOIN appointment_reschedule_events event ON event.manual_case_id=manual_case.id
       LEFT JOIN appointments replacement_laboratory
         ON replacement_laboratory.id=event.new_laboratory_appointment_id
       LEFT JOIN appointments replacement_physical
         ON replacement_physical.id=event.new_physical_exam_appointment_id
       LEFT JOIN ovpsa_first_year_batches ovpsa_batch
         ON ovpsa_batch.id::text=manual_case.policy_metadata->>'ovpsaBatchId'
      WHERE ($1::text IS NULL OR manual_case.student_number ILIKE '%'||$1||'%'
             OR student.first_name ILIKE '%'||$1||'%' OR student.last_name ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR manual_case.reason_code=$2)
        AND ($3::text IS NULL OR manual_case.status=$3)
        AND ($4::uuid IS NULL OR manual_case.closure_group_id=$4)
        AND ($10::uuid IS NULL OR EXISTS (
          SELECT 1 FROM appointments source LEFT JOIN schedule_batches source_batch ON source_batch.id=source.batch_id
            LEFT JOIN ovpsa_first_year_batches source_ovpsa ON source_ovpsa.id=source.ovpsa_batch_id
            JOIN schedule_import_groups import_group ON import_group.id=COALESCE(source_batch.import_group_id,source_ovpsa.source_import_group_id)
          WHERE source.id IN (manual_case.affected_laboratory_appointment_id,manual_case.affected_physical_exam_appointment_id)
            AND import_group.id=$10 AND import_group.academic_year_start=manual_case.schedule_cycle_start))
        AND ($5::date IS NULL OR $5 BETWEEN closure.start_date AND closure.end_date
             OR laboratory.appointment_date=$5 OR physical.appointment_date=$5)
        AND ($6::text IS NULL
             OR ($6='LABORATORY' AND laboratory.id IS NOT NULL)
             OR ($6='PHYSICAL_EXAM' AND physical.id IS NOT NULL))
        AND (($7::int IS NULL
              AND make_date(academic_year.start_year,8,1) <=
                (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
              AND academic_year.closing_date >=
                (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)
          OR ($7::int IS NOT NULL AND manual_case.schedule_cycle_start=$7))
      ORDER BY manual_case.created_at,manual_case.id
      LIMIT $8 OFFSET $9`,
    [search, reasonCode, status || null, closureGroupId, date, service,
      academicYearStart, pageSize, (page - 1) * pageSize, importGroupId],
    );
    const appointmentIds = result.rows.flatMap((row) =>
      [
        row.laboratory_id,
        row.physical_exam_id,
        row.replacement_laboratory_id,
        row.replacement_physical_exam_id,
      ].filter((id): id is string => Boolean(id)));
    const protectionStates = await loadAppointmentResultProtectionStates(client, appointmentIds);
    return { result, protectionStates, selectedYearState };
  });
  const { result, protectionStates, selectedYearState } = loaded;
  return {
    page,
    pageSize,
    total: result.rows[0]?.total ?? 0,
    selectedYearState,
    items: result.rows.map((row) => {
      const affectedIds = new Set(
        Array.isArray(row.policy_metadata.affectedAppointmentIds)
          ? row.policy_metadata.affectedAppointmentIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      const isAssignmentRelevant = (appointmentId: string) =>
        row.case_source !== "AUTOMATIC_DISPLACEMENT"
        || affectedIds.size === 0
        || affectedIds.has(appointmentId);
      return ({
      id: row.id,
      studentNumber: row.student_number,
      academicYearStart: row.schedule_cycle_start,
      studentName: row.student_name,
      caseSource: row.case_source,
      closureGroupId: row.closure_group_id,
      groupStartDate: row.group_start_date,
      groupEndDate: row.group_end_date,
      reasonCode: row.reason_code,
      reasonMessage: row.reason_message,
      status: row.status,
      optimisticToken: row.optimistic_token,
      createdAt: row.created_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      resolutionAction: row.resolution_action,
      resolutionDetails: row.resolution_details,
      policyMetadata: row.policy_metadata,
      ovpsaBatchId: typeof row.policy_metadata.ovpsaBatchId === "string"
        ? row.policy_metadata.ovpsaBatchId
        : null,
      ovpsaBatchOptimisticToken: row.ovpsa_batch_optimistic_token,
      category: row.category,
      closureReason: row.closure_reason,
      laboratory: row.laboratory_id ? {
        id: row.laboratory_id,
        date: row.laboratory_date!,
        status: row.laboratory_status!,
        affected: affectedIds.has(row.laboratory_id),
      } : null,
      physicalExam: row.physical_exam_id ? {
        id: row.physical_exam_id,
        date: row.physical_exam_date!,
        status: row.physical_exam_status!,
        affected: affectedIds.has(row.physical_exam_id),
      } : null,
      currentAssignmentBlock: currentAssignmentBlock([
        ...(row.laboratory_id && isAssignmentRelevant(row.laboratory_id) ? [{
          isManuallyLocked: Boolean(row.laboratory_is_manually_locked),
          resultProtectionState: protectionStates.get(row.laboratory_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.physical_exam_id && isAssignmentRelevant(row.physical_exam_id) ? [{
          isManuallyLocked: Boolean(row.physical_exam_is_manually_locked),
          resultProtectionState: protectionStates.get(row.physical_exam_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.replacement_laboratory_id && isAssignmentRelevant(row.replacement_laboratory_id) ? [{
          isManuallyLocked: Boolean(row.replacement_laboratory_is_manually_locked),
          resultProtectionState: protectionStates.get(row.replacement_laboratory_id) ?? { type: "CLEAR" as const },
        }] : []),
        ...(row.replacement_physical_exam_id && isAssignmentRelevant(row.replacement_physical_exam_id) ? [{
          isManuallyLocked: Boolean(row.replacement_physical_exam_is_manually_locked),
          resultProtectionState: protectionStates.get(row.replacement_physical_exam_id) ?? { type: "CLEAR" as const },
        }] : []),
      ]),
    }); }),
  };
}

export async function loadAppointmentStates(client: PoolClient, ids: string[]) {
  if (!ids.length) return [];
  const result = await client.query<{
    id: string;
    clinic_id: string;
    student_number: string;
    schedule_type: AppointmentState["scheduleType"];
    appointment_date: string;
    status: string;
    is_published: boolean;
    is_manually_locked: boolean;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    rescheduled_from: string | null;
    ovpsa_batch_id: string | null;
    ovpsa_revision_id: string | null;
    ovpsa_service_reservation_id: string | null;
  }>(
    `SELECT appointment.id::text,appointment.clinic_id::text,appointment.student_number,
            appointment.schedule_type,appointment.appointment_date::text,appointment.status,
            appointment.is_published,appointment.is_manually_locked,
            appointment.schedule_pair_id::text,appointment.schedule_cycle_start,
            appointment.rescheduled_from::text,appointment.ovpsa_batch_id::text,
            appointment.ovpsa_revision_id::text,appointment.ovpsa_service_reservation_id::text
       FROM appointments appointment WHERE appointment.id=ANY($1::uuid[]) ORDER BY appointment.id FOR UPDATE`,
    [ids],
  );
  const protectionStates = await loadAppointmentResultProtectionStates(
    client,
    result.rows.map((row) => row.id),
  );
  return result.rows.map((row): AppointmentState => ({
    id: row.id,
    clinicId: row.clinic_id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    isPublished: row.is_published,
    isManuallyLocked: row.is_manually_locked,
    resultProtectionState: protectionStates.get(row.id) ?? { type: "CLEAR" },
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    rescheduledFrom: row.rescheduled_from,
    ovpsaBatchId: row.ovpsa_batch_id,
    ovpsaRevisionId: row.ovpsa_revision_id,
    ovpsaServiceReservationId: row.ovpsa_service_reservation_id,
  }));
}

export async function assertAutomaticManualDateAvailable(
  client: PoolClient,
  appointment: AppointmentState,
  date: string,
  scheduleCycleStart: number,
  projectedUsedCapacity?: number,
) {
  const isBlocked = await isSchedulingDateBlocked(client, {
    scheduleType: appointment.scheduleType,
    date,
  });
  const destination = await getManualRescheduleDestinationState(client, {
    appointmentId: appointment.id,
    clinicId: appointment.clinicId,
    scheduleType: appointment.scheduleType,
    appointmentDate: date,
    scheduleCycleStart,
  });
  if (!destination.cycleClosingDate) {
    throw new AppError(
      "OUTSIDE_SCHEDULING_CYCLE",
      "The appointment scheduling cycle is not configured.",
      409,
    );
  }
  if (destination.maxDailyCapacity === null) {
    throw new AppError(
      "SCHEDULE_CAPACITY_NOT_CONFIGURED",
      "Daily capacity is not configured for this service.",
      409,
    );
  }
  assertManualAppointmentDestination({
    appointment,
    pair: { laboratory: null, physicalExam: null },
    destinationDate: date,
    manilaToday: manilaToday(),
    cycleStartDate: `${scheduleCycleStart}-08-01`,
    cycleClosingDate: destination.cycleClosingDate,
    isBlocked,
    usedCapacity: projectedUsedCapacity ?? destination.usedCapacity,
    maxDailyCapacity: destination.maxDailyCapacity,
  });
}

export async function resolveClinicClosureManualCase(
  caseId: string,
  raw: unknown,
  actor: SessionUser,
) {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(caseId).success) throw validationError("The manual case ID is invalid.");
  const parsed = resolutionSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the manual resolution.", parsed.error.flatten());
  const request = parsed.data as ClinicManualCaseResolutionRequest;
  return transaction((client) => resolveClinicClosureManualCaseWithClient(client, caseId, request, actor));
}

/** The caller owns commit/rollback; bulk callers must prelock their entire selection. */
export async function resolveClinicClosureManualCaseWithClient(
  client: PoolClient,
  caseId: string,
  request: ClinicManualCaseResolutionRequest,
  actor: SessionUser,
  options?: { projectedUsedCapacity: ReadonlyMap<string, number> },
) {
  assertAdmin(actor);
  await lockClinicManualResolutionCases(client, [caseId]);
  const caseResult = await client.query<{
    id: string;
    student_number: string;
    case_source: ClinicManualCaseDto["caseSource"];
    closure_group_id: string | null;
    schedule_pair_id: string | null;
    schedule_cycle_start: number;
    affected_laboratory_appointment_id: string | null;
    affected_physical_exam_appointment_id: string | null;
    status: string;
    optimistic_token: string;
    reason_code: string;
  }>(
    `SELECT id::text,student_number,case_source,closure_group_id::text,schedule_pair_id::text,
            schedule_cycle_start,affected_laboratory_appointment_id::text,
            affected_physical_exam_appointment_id::text,status,optimistic_token::text,reason_code
       FROM clinic_closure_manual_cases WHERE id=$1 FOR UPDATE`,
    [caseId],
  );
  const manualCase = caseResult.rows[0];
  if (!manualCase) throw new AppError("MANUAL_CASE_NOT_FOUND", "Manual case not found.", 404);
  if (manualCase.status !== "OPEN") throw new AppError("MANUAL_CASE_ALREADY_RESOLVED", "This manual case is already resolved.", 409);
  if (manualCase.optimistic_token !== request.expectedOptimisticToken) {
    throw new AppError("MANUAL_CASE_STALE", "The manual case changed. Reload and try again.", 409);
  }
  const cycle = await lockAcademicYearSchedulingBoundary(client, manualCase.schedule_cycle_start);
  if (!cycle) {
    throw new AppError("ACADEMIC_YEAR_MISSING", "The manual case has no configured academic year.", 409);
  }
  if (cycle.closingDate < manilaToday()) {
    throw new AppError("ACADEMIC_YEAR_ENDED", "This academic year has ended; the manual case is historical.", 409);
  }
  if (manualCase.reason_code === "OVPSA_LABORATORY_PROTECTED") {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_REQUIRED",
      "Resolve this Laboratory closure through the coordinated OVPSA batch recovery.",
      409,
    );
  }
  const affectedIds = [
    manualCase.affected_laboratory_appointment_id,
    manualCase.affected_physical_exam_appointment_id,
  ].filter((id): id is string => Boolean(id));
  const affected = await loadAppointmentStates(client, affectedIds);
  const event = await client.query<{
    new_laboratory_appointment_id: string | null;
    new_physical_exam_appointment_id: string | null;
  }>(
    `SELECT new_laboratory_appointment_id::text,new_physical_exam_appointment_id::text
       FROM appointment_reschedule_events WHERE manual_case_id=$1 FOR UPDATE`,
    [caseId],
  );
  const replacementIds = event.rows.flatMap((row) => [
    row.new_laboratory_appointment_id,
    row.new_physical_exam_appointment_id,
  ].filter((id): id is string => Boolean(id)));
  const replacements = await loadAppointmentStates(client, replacementIds);
  const recheckedAppointments = [...affected, ...replacements];
  let auditedAppointments: AppointmentState[] = recheckedAppointments;
  const insertedByType: Partial<Record<AppointmentState["scheduleType"], string>> = {};
  if (request.action === "ASSIGN_REPLACEMENT") {
    const dateByType = {
      LABORATORY: request.laboratoryDate,
      PHYSICAL_EXAM: request.physicalExamDate,
    };
    const preserveByType = {
      LABORATORY: request.preserveLaboratory,
      PHYSICAL_EXAM: request.preservePhysicalExam,
    };
    const awaiting = affected.filter((appointment) => appointment.status === "AWAITING_RESCHEDULE");
    if (!awaiting.length) throw new AppError("MANUAL_CASE_NO_AWAITING_APPOINTMENT", "No appointment is awaiting a replacement.", 409);
    if (awaiting.some((appointment) => !dateByType[appointment.scheduleType])) {
      throw validationError("A replacement date is required for every unfinished service.");
    }
    for (const appointment of affected) {
      const date = dateByType[appointment.scheduleType];
      const preserve = preserveByType[appointment.scheduleType];
      if (date && preserve) {
        throw validationError(`Choose either a replacement or preservation for ${appointment.scheduleType}.`);
      }
      if (appointment.status !== "AWAITING_RESCHEDULE" && !date && preserve !== true) {
        throw validationError(`Explicitly preserve or replace the related ${appointment.scheduleType} appointment.`);
      }
      if (date && !["DRAFT", "PENDING", "AWAITING_RESCHEDULE"].includes(appointment.status)) {
        throw validationError(`The ${appointment.scheduleType} appointment cannot be replaced in its current state.`);
      }
    }
    const finalDateByType = {
      LABORATORY: request.laboratoryDate
        ?? affected.find((appointment) => appointment.scheduleType === "LABORATORY")?.appointmentDate,
      PHYSICAL_EXAM: request.physicalExamDate
        ?? affected.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.appointmentDate,
    };
    if (finalDateByType.LABORATORY && finalDateByType.PHYSICAL_EXAM) {
      assertReplacementPairOrder(finalDateByType.LABORATORY, finalDateByType.PHYSICAL_EXAM,
        affected.some((appointment) => appointment.ovpsaBatchId) ? 7 : 1);
    }
    const moving = affected.filter((appointment) => Boolean(dateByType[appointment.scheduleType]));
    const assignmentBlock = currentAssignmentBlock(moving);
    if (assignmentBlock) {
      throw new AppError(assignmentBlock.code, assignmentBlock.message, 409);
    }
    for (const appointment of moving) {
      const date = dateByType[appointment.scheduleType]!;
      await assertAutomaticManualDateAvailable(client, appointment, date, manualCase.schedule_cycle_start,
        options?.projectedUsedCapacity.get(appointment.id));
    }
    await client.query(
      `UPDATE appointments
          SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [moving.map((appointment) => appointment.id), actor.userId],
    );
    for (const appointment of moving) {
      const date = dateByType[appointment.scheduleType]!;
      let recoveryReservationId: string | null = null;
      if (appointment.ovpsaBatchId && appointment.ovpsaRevisionId) {
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO ovpsa_first_year_service_reservations (
             batch_id,revision_id,schedule_type,reservation_date,status,
             reservation_kind,created_by
           ) VALUES ($1,$2,$3,$4,'ACTIVE','CLOSURE_RECOVERY',$5)
           RETURNING id::text`,
          [
            appointment.ovpsaBatchId,
            appointment.ovpsaRevisionId,
            appointment.scheduleType,
            date,
            actor.userId,
          ],
        );
        recoveryReservationId = reservation.rows[0].id;
      }
      const inserted = recoveryReservationId
        ? await client.query<{ id: string }>(
            `INSERT INTO appointments (
               batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
               notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
               ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
               scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
               scheduling_window_start,scheduling_window_end
             ) SELECT batch_id,clinic_id,student_number,schedule_type,$2,'PENDING',TRUE,$3,id,$4,$4,
                      schedule_pair_id,schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,$5,
                      scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
                      scheduling_window_start,scheduling_window_end
                 FROM appointments WHERE id=$1
             RETURNING id::text`,
            [appointment.id, date, `Manual clinic closure resolution ${caseId}.`, actor.userId, recoveryReservationId],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO appointments (
               batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
               notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
               scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
               scheduling_window_start,scheduling_window_end
             ) SELECT batch_id,clinic_id,student_number,schedule_type,$2,'PENDING',TRUE,$3,id,$4,$4,
                      schedule_pair_id,schedule_cycle_start,scheduling_category,
                      scheduling_accepted_at,scheduling_source_row_order,
                      scheduling_window_start,scheduling_window_end
                 FROM appointments WHERE id=$1
             RETURNING id::text`,
            [
              appointment.id,
              date,
              `Manual clinic closure resolution ${caseId}.`,
              actor.userId,
            ],
          );
      insertedByType[appointment.scheduleType] = inserted.rows[0].id;
      await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
    }
  } else {
    auditedAppointments = replacements;
    const assignmentBlock = currentAssignmentBlock(replacements);
    if (!replacements.length || replacements.some((appointment) =>
      appointment.status !== "PENDING"
      || !appointment.isPublished) || assignmentBlock) {
      throw new AppError("CURRENT_REPLACEMENT_NOT_SAFE", "There is no safe current replacement to keep.", 409);
    }
  }
  const details = {
    action: request.action,
    reason: request.reason,
    laboratoryDate: request.action === "ASSIGN_REPLACEMENT" ? request.laboratoryDate ?? null : null,
    physicalExamDate: request.action === "ASSIGN_REPLACEMENT" ? request.physicalExamDate ?? null : null,
    preserveLaboratory: request.action === "ASSIGN_REPLACEMENT" ? request.preserveLaboratory ?? false : false,
    preservePhysicalExam: request.action === "ASSIGN_REPLACEMENT" ? request.preservePhysicalExam ?? false : false,
    laboratoryAppointmentId: insertedByType.LABORATORY ?? null,
    physicalExamAppointmentId: insertedByType.PHYSICAL_EXAM ?? null,
  };
  await client.query(
    `UPDATE clinic_closure_manual_cases
        SET status='RESOLVED',resolved_at=NOW(),resolved_by=$2,
            resolution_action=$3,resolution_details=$4::jsonb,
            optimistic_token=gen_random_uuid(),updated_at=NOW()
      WHERE id=$1`,
    [caseId, actor.userId, request.action, JSON.stringify(details)],
  );
  await client.query(
    `UPDATE appointment_reschedule_events
        SET outcome='MANUALLY_RESOLVED',
            new_laboratory_appointment_id=COALESCE($2,new_laboratory_appointment_id),
            new_physical_exam_appointment_id=COALESCE($3,new_physical_exam_appointment_id),
            restoration_decision=CASE WHEN $4='KEEP_CURRENT_REPLACEMENT' THEN 'KEEP_CURRENT_REPLACEMENT' ELSE restoration_decision END,
            restoration_details=COALESCE(restoration_details,'{}'::jsonb)||$5::jsonb
      WHERE manual_case_id=$1`,
    [
      caseId,
      insertedByType.LABORATORY ?? null,
      insertedByType.PHYSICAL_EXAM ?? null,
      request.action,
      JSON.stringify({ manualResolutionReason: request.reason }),
    ],
  );
  const protectionMetadata = resultProtectionAuditMetadata(auditedAppointments);
  const resolutionAuditAction = manualCase.case_source === "AUTOMATIC_DISPLACEMENT"
    ? "AUTOMATIC_DISPLACEMENT_MANUAL_CASE_RESOLVED"
    : "CLINIC_CLOSURE_MANUAL_CASE_RESOLVED";
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES ($1,$2,'clinic_closure_manual_case',$3::text,
             jsonb_build_object(
               'studentNumber',$4::text,'resolutionAction',$5::text,'reasonCode',$6::text,
               'appointmentIds',$7::jsonb,'submissionIds',$8::jsonb,
               'activeDraftFileCount',$9::int
             ))`,
    [
      actor.userId,
      resolutionAuditAction,
      caseId,
      manualCase.student_number,
      request.action,
      manualCase.reason_code,
      JSON.stringify(protectionMetadata.appointmentIds),
      JSON.stringify(protectionMetadata.submissionIds),
      protectionMetadata.activeDraftFileCount,
    ],
  );
  const notificationWarningCount = await createClosureNotification(client, {
    studentNumber: manualCase.student_number,
    build: (state) => buildManualResolutionCompletedNotification({
      state,
      eventId: caseId,
      eventKeyDiscriminator: "resolved",
      sourceType: manualCase.case_source === "AUTOMATIC_DISPLACEMENT"
        ? "AUTOMATIC_DISPLACEMENT_MANUAL_CASE"
        : "CLINIC_CLOSURE_MANUAL_CASE",
      reason: request.reason,
      previous: previousScheduleForAppointments(affected),
    }),
    actorUserId: actor.userId,
    auditEntityId: caseId,
    auditEntityType: "clinic_closure_manual_case",
  });
  return {
    caseId,
    status: "RESOLVED" as const,
    resolutionAction: request.action,
    notificationWarningCount,
  };
}
