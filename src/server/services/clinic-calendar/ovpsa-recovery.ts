import "server-only";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { assertManualAppointmentDestination } from "@/server/appointments/manual-appointment-destination";
import { transaction } from "@/server/db/pool";
import { lockClinicManualResolutionCases } from "../clinic-manual-resolution-locks";
import { lockAcademicYearSchedulingBoundary } from "@/server/repositories/academic-years.repository";
import { listUnifiedBlockedDateSet } from "@/server/repositories/clinic-unavailable-dates.repository";
import type { OvpsaClosureBatchRecoveryConfirmation, OvpsaClosureBatchRecoveryPreview } from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import { buildManualResolutionCompletedNotification } from "@/server/schedule/schedule-notifications";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import {
  allocateReplacementDates,
  addCalendarDays,
  ClinicCalendarPlanningError,
  isClinicSchedulingWeekday,
  type ReplacementCycleBounds,
} from "../clinic-calendar-planner";
import {
  isSchedulingDateBlocked,
  loadSchedulingBlockedDates,
} from "@/server/repositories/scheduling-blocked-dates.repository";
import {
  manilaToday,
  loadCapacity,
  copyCapacity,
  reserveCapacity,
  assertAdmin,
  validationError,
  createClosureNotification,
} from "./recovery-shared";

const ovpsaBatchPreviewSchema = z.object({
  optimisticToken: z.string().uuid(),
  replacementLaboratoryDate: z.iso.date(),
}).strict();
const ovpsaBatchConfirmSchema = ovpsaBatchPreviewSchema.extend({
  caseTokens: z.array(z.object({
    caseId: z.string().uuid(),
    expectedOptimisticToken: z.string().uuid(),
  }).strict()).min(1),
  reason: z.string().trim().min(3).max(500),
}).strict();

type OvpsaRecoveryBatchRow = {
  batch_id: string;
  status: string;
  optimistic_token: string;
  schedule_cycle_start: number;
  revision_id: string;
  revision_number: number;
  revision_status: string;
};

type OvpsaRecoveryCaseRow = {
  case_id: string;
  optimistic_token: string;
  student_number: string;
  laboratory_id: string;
  laboratory_status: string;
  laboratory_locked: boolean;
  physical_locked: boolean;
  laboratory_date: string;
  laboratory_clinic_id: string;
  physical_id: string;
  physical_status: string;
  physical_date: string;
  physical_clinic_id: string;
  schedule_pair_id: string;
  physical_created_at: Date;
  source_order: number | null;
};

async function planOvpsaClosureBatchRecovery(
  client: PoolClient,
  input: {
    batchId: string;
    optimisticToken: string;
    replacementLaboratoryDate: string;
    lock: boolean;
  },
) {
  if (input.lock) {
    const members = await client.query<{ id: string }>(
      `SELECT id::text FROM clinic_closure_manual_cases
        WHERE status='OPEN' AND reason_code='OVPSA_LABORATORY_PROTECTED'
          AND policy_metadata->>'ovpsaBatchId'=$1::text ORDER BY id`,
      [input.batchId],
    );
    await lockClinicManualResolutionCases(client, members.rows.map((row) => row.id));
  }
  const batchResult = await client.query<OvpsaRecoveryBatchRow>(
    `SELECT batch.id::text AS batch_id,batch.status,batch.optimistic_token::text,
            batch.schedule_cycle_start,revision.id::text AS revision_id,
            revision.revision_number,revision.status AS revision_status
       FROM ovpsa_first_year_batches batch
       JOIN ovpsa_first_year_batch_revisions revision
         ON revision.id=batch.current_revision_id
      WHERE batch.id=$1
      ${input.lock ? "FOR UPDATE OF batch,revision" : ""}`,
    [input.batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new AppError("OVPSA_BATCH_NOT_FOUND", "First Year batch not found.", 404);
  if (batch.optimistic_token !== input.optimisticToken) {
    throw new AppError("OVPSA_BATCH_STALE", "The OVPSA batch changed. Reload and try again.", 409);
  }
  if (batch.status !== "RESCHEDULE_REQUIRED" || batch.revision_status !== "PUBLISHED") {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_NOT_REQUIRED",
      "This batch is not awaiting coordinated closure recovery.",
      409,
    );
  }
  const boundary = await lockAcademicYearSchedulingBoundary(client, batch.schedule_cycle_start);
  if (!boundary || boundary.closingDate <= manilaToday()) {
    throw new AppError("NO_VALID_REPLACEMENT_WITHIN_CYCLE",
      "The original academic cycle is missing or closed. Keep the batch in Manual Resolution.", 409);
  }
  const bounds: ReplacementCycleBounds = {
    cycleStartDate: `${batch.schedule_cycle_start}-08-01`,
    cycleClosingDate: boundary.closingDate, manilaToday: manilaToday(),
  };
  assertManualAppointmentDestination({
    appointment: { id: batch.batch_id, scheduleType: "LABORATORY" },
    pair: { laboratory: null, physicalExam: null },
    destinationDate: input.replacementLaboratoryDate, ...bounds,
    isBlocked: await isSchedulingDateBlocked(client, {
      scheduleType: "LABORATORY", date: input.replacementLaboratoryDate, excludeOvpsaBatchId: input.batchId,
    }),
    // Mission Hospital Laboratory is external and does not use clinic capacity.
    usedCapacity: 0, maxDailyCapacity: 1,
  });
  const cases = await client.query<OvpsaRecoveryCaseRow>(
    `SELECT manual_case.id::text AS case_id,manual_case.optimistic_token::text,
            manual_case.student_number,laboratory.id::text AS laboratory_id,
            laboratory.status AS laboratory_status,laboratory.appointment_date::text AS laboratory_date,
            laboratory.is_manually_locked AS laboratory_locked,physical.is_manually_locked AS physical_locked,
            laboratory.clinic_id::text AS laboratory_clinic_id,
            physical.id::text AS physical_id,physical.status AS physical_status,
            physical.appointment_date::text AS physical_date,
            physical.clinic_id::text AS physical_clinic_id,
            laboratory.schedule_pair_id::text,physical.created_at AS physical_created_at,
            physical.scheduling_source_row_order AS source_order
       FROM clinic_closure_manual_cases manual_case
       JOIN appointments laboratory
         ON laboratory.id=manual_case.affected_laboratory_appointment_id
       JOIN appointments physical
         ON physical.id=manual_case.affected_physical_exam_appointment_id
      WHERE manual_case.status='OPEN'
        AND manual_case.reason_code='OVPSA_LABORATORY_PROTECTED'
        AND manual_case.policy_metadata->>'ovpsaBatchId'=$1::text
      ORDER BY physical.appointment_date,physical.created_at,
               physical.scheduling_source_row_order NULLS LAST,
               manual_case.student_number,manual_case.id
      ${input.lock ? "FOR UPDATE OF manual_case,laboratory,physical" : ""}`,
    [input.batchId],
  );
  if (!cases.rowCount) {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_CASES_NOT_FOUND",
      "No open OVPSA Laboratory recovery cases were found for this batch.",
      409,
    );
  }
  const invalidLaboratory = cases.rows.find((row) => row.laboratory_status !== "AWAITING_RESCHEDULE");
  if (invalidLaboratory) {
    throw new AppError(
      "OVPSA_BATCH_RECOVERY_STALE",
      "An affected Laboratory appointment changed. Reload and review the batch again.",
      409,
    );
  }
  const protectionStates = await loadAppointmentResultProtectionStates(
    client,
    cases.rows.flatMap((row) => [row.laboratory_id, row.physical_id]),
  );
  if (cases.rows.some((row) => row.laboratory_locked
    || protectionStates.get(row.laboratory_id)?.type === "PROTECTED")) {
    throw new AppError("OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
      "An affected Laboratory appointment is protected and cannot be replaced safely.", 409);
  }
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: input.replacementLaboratoryDate,
    endDate: bounds.cycleClosingDate,
    excludeOvpsaBatchId: input.batchId,
  });
  const blockedDates = await listUnifiedBlockedDateSet(client);
  const { capacity, usedCapacity: initialCapacity } = await loadCapacity(client);
  let usedCapacity = initialCapacity;
  const minimumPhysicalExamDate = addCalendarDays(input.replacementLaboratoryDate, 7);
  const allocations: OvpsaClosureBatchRecoveryPreview["allocations"] = [];
  for (const row of cases.rows) {
    const physicalProtected = protectionStates.get(row.physical_id)?.type === "PROTECTED";
    const canPreserve = ["PENDING", "COMPLETED"].includes(row.physical_status)
      && row.physical_date >= minimumPhysicalExamDate
      && row.physical_date <= bounds.cycleClosingDate
      && isClinicSchedulingWeekday(row.physical_date)
      && !blockedDates.has(row.physical_date)
      && !blocked.physicalExamDates.includes(row.physical_date);
    if (canPreserve) {
      allocations.push({
        studentNumber: row.student_number,
        currentPhysicalExamDate: row.physical_date,
        proposedPhysicalExamDate: row.physical_date,
        physicalExamAction: "PRESERVE",
      });
      continue;
    }
    if (
      row.physical_status === "COMPLETED"
      || !["PENDING", "AWAITING_RESCHEDULE"].includes(row.physical_status)
      || physicalProtected
      || row.physical_locked
    ) {
      throw new AppError(
        "OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
        `The Physical Examination for ${row.student_number} cannot be moved safely.`,
        409,
      );
    }
    const candidateCapacity = copyCapacity(usedCapacity);
    if (row.physical_status === "PENDING") {
      candidateCapacity.PHYSICAL_EXAM.set(row.physical_date,
        Math.max(0, (candidateCapacity.PHYSICAL_EXAM.get(row.physical_date) ?? 0) - 1));
    }
    let dates: ReturnType<typeof allocateReplacementDates>;
    try {
      dates = allocateReplacementDates({
        bounds, strategy: "MOVE_PHYSICAL_ONLY",
        afterDate: addCalendarDays(input.replacementLaboratoryDate, 6),
        blockedDates, blockedDatesByService: { PHYSICAL_EXAM: new Set(blocked.physicalExamDates) },
        usedCapacity: candidateCapacity, capacity,
      });
    } catch (error) {
      if (!(error instanceof ClinicCalendarPlanningError)) throw error;
      throw new AppError(error.reasonCode, error.message, 409);
    }
    reserveCapacity(candidateCapacity, dates);
    usedCapacity = candidateCapacity;
    allocations.push({
      studentNumber: row.student_number,
      currentPhysicalExamDate: row.physical_date,
      proposedPhysicalExamDate: dates.physicalExamDate!,
      physicalExamAction: "MOVE",
    });
  }
  const preview: OvpsaClosureBatchRecoveryPreview = {
    batchId: input.batchId,
    optimisticToken: batch.optimistic_token,
    replacementLaboratoryDate: input.replacementLaboratoryDate,
    linkedCaseCount: cases.rows.length,
    preservedPhysicalExamCount: allocations.filter((row) => row.physicalExamAction === "PRESERVE").length,
    movedPhysicalExamCount: allocations.filter((row) => row.physicalExamAction === "MOVE").length,
    allocations,
  };
  return { batch, cases: cases.rows, protectionStates, preview };
}

export async function previewOvpsaClinicClosureBatchRecovery(
  batchId: string,
  raw: unknown,
  actor: SessionUser,
): Promise<OvpsaClosureBatchRecoveryPreview> {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(batchId).success) throw validationError("The OVPSA batch ID is invalid.");
  const parsed = ovpsaBatchPreviewSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the OVPSA batch recovery preview.", parsed.error.flatten());
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    return (await planOvpsaClosureBatchRecovery(client, {
      batchId, ...parsed.data, lock: false,
    })).preview;
  });
}

export async function confirmOvpsaClinicClosureBatchRecovery(
  batchId: string,
  raw: unknown,
  actor: SessionUser,
): Promise<OvpsaClosureBatchRecoveryConfirmation> {
  assertAdmin(actor);
  if (!z.string().uuid().safeParse(batchId).success) throw validationError("The OVPSA batch ID is invalid.");
  const parsed = ovpsaBatchConfirmSchema.safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the OVPSA batch recovery confirmation.", parsed.error.flatten());
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const planned = await planOvpsaClosureBatchRecovery(client, {
      batchId,
      optimisticToken: parsed.data.optimisticToken,
      replacementLaboratoryDate: parsed.data.replacementLaboratoryDate,
      lock: true,
    });
    const expectedTokens = new Map(
      parsed.data.caseTokens.map((item) => [item.caseId, item.expectedOptimisticToken]),
    );
    if (
      expectedTokens.size !== planned.cases.length
      || planned.cases.some((item) => expectedTokens.get(item.case_id) !== item.optimistic_token)
    ) {
      throw new AppError(
        "OVPSA_BATCH_RECOVERY_CASES_STALE",
        "The linked Manual Resolution cases changed. Reload and review the batch again.",
        409,
      );
    }
    const reason = parsed.data.reason.trim();
    await client.query(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='RELEASED',released_at=clock_timestamp(),released_by=$3,
              release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2
          AND status IN ('ACTIVE','INVALIDATED')`,
      [batchId, planned.batch.revision_id, actor.userId, reason],
    );
    const earliestPhysicalExamDate = [...planned.preview.allocations]
      .sort((left, right) => left.proposedPhysicalExamDate.localeCompare(right.proposedPhysicalExamDate))[0]
      .proposedPhysicalExamDate;
    const defaultPhysicalExamDate = addCalendarDays(parsed.data.replacementLaboratoryDate, 7);
    const revision = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         batch_id,revision_number,status,laboratory_date,physical_exam_date,
         physical_exam_exception_reason,validation_snapshot,validated_by,validated_at,
         published_by,published_at,created_by
       ) VALUES ($1,$2,'VALIDATED',$3,$4,$5,$6::jsonb,$7,clock_timestamp(),
                 NULL,NULL,$7)
       RETURNING id::text`,
      [
        batchId,
        planned.batch.revision_number + 1,
        parsed.data.replacementLaboratoryDate,
        earliestPhysicalExamDate,
        earliestPhysicalExamDate === defaultPhysicalExamDate ? null : reason,
        JSON.stringify(planned.preview),
        actor.userId,
      ],
    );
    const revisionId = revision.rows[0].id;
    const laboratoryReservation = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_service_reservations (
         batch_id,revision_id,schedule_type,reservation_date,status,
         reservation_kind,created_by
       ) VALUES ($1,$2,'LABORATORY',$3,'ACTIVE','EXCLUSIVE',$4)
       RETURNING id::text`,
      [batchId, revisionId, parsed.data.replacementLaboratoryDate, actor.userId],
    );
    const preservedDates = [...new Set(
      planned.preview.allocations
        .filter((item) => item.physicalExamAction === "PRESERVE")
        .map((item) => item.proposedPhysicalExamDate),
    )];
    const preservedReservations = preservedDates.length
      ? await client.query<{ id: string; reservation_date: string }>(
          `INSERT INTO ovpsa_first_year_service_reservations (
             batch_id,revision_id,schedule_type,reservation_date,status,
             reservation_kind,created_by
           ) SELECT $1,$2,'PHYSICAL_EXAM',date,'ACTIVE','EXCLUSIVE',$4
               FROM UNNEST($3::date[]) AS reservation(date)
           RETURNING id::text,reservation_date::text`,
          [batchId, revisionId, preservedDates, actor.userId],
        )
      : { rows: [] as Array<{ id: string; reservation_date: string }> };
    const preservedReservationByDate = new Map(
      preservedReservations.rows.map((item) => [item.reservation_date, item.id]),
    );
    const movedAllocations = planned.preview.allocations.filter(
      (item) => item.physicalExamAction === "MOVE",
    );
    const movedReservationRows: Array<{ id: string; student_number: string }> = [];
    for (const allocation of movedAllocations) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,
           reservation_kind,created_by
         ) VALUES ($1,$2,'PHYSICAL_EXAM',$3,'ACTIVE','CLOSURE_RECOVERY',$4)
         RETURNING id::text`,
        [batchId, revisionId, allocation.proposedPhysicalExamDate, actor.userId],
      );
      movedReservationRows.push({
        id: inserted.rows[0].id,
        student_number: allocation.studentNumber,
      });
    }
    const movedReservationByStudent = new Map(
      movedReservationRows.map((item) => [item.student_number, item.id]),
    );
    const allocationByStudent = new Map(
      planned.preview.allocations.map((item) => [item.studentNumber, item]),
    );
    const membershipAssignments = planned.cases.map((item) => {
      const allocation = allocationByStudent.get(item.student_number)!;
      return {
        student_number: item.student_number,
        reservation_id: allocation.physicalExamAction === "PRESERVE"
          ? preservedReservationByDate.get(allocation.proposedPhysicalExamDate)
          : movedReservationByStudent.get(item.student_number),
      };
    });
    if (membershipAssignments.some((item) => !item.reservation_id)) {
      throw new Error("OVPSA closure recovery reservation assignment is incomplete.");
    }
    await client.query(
      `INSERT INTO ovpsa_first_year_membership_snapshots (
         revision_id,batch_id,student_number,academic_snapshot_id,student_name,
         college_id,college_name,program_id,program_code,program_name,year_level,
         source_row_number,allocation_position,assigned_pe_reservation_id
       ) SELECT $1,membership.batch_id,membership.student_number,
                membership.academic_snapshot_id,membership.student_name,
                membership.college_id,membership.college_name,membership.program_id,
                membership.program_code,membership.program_name,membership.year_level,
                membership.source_row_number,membership.allocation_position,
                CASE WHEN membership.source_row_number IS NULL THEN NULL
                     ELSE COALESCE(row.reservation_id,membership.assigned_pe_reservation_id)
                END
           FROM ovpsa_first_year_membership_snapshots membership
           LEFT JOIN jsonb_to_recordset($3::jsonb)
             AS row(student_number text,reservation_id uuid)
             ON row.student_number=membership.student_number
          WHERE membership.revision_id=$2`,
      [revisionId, planned.batch.revision_id, JSON.stringify(membershipAssignments)],
    );
    await client.query(
      `UPDATE appointments
          SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=clock_timestamp()
        WHERE id=ANY($1::uuid[])`,
      [planned.cases.map((item) => item.laboratory_id), actor.userId],
    );
    const newLaboratories = await client.query<{ id: string; student_number: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
         ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
         scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
         scheduling_window_start,scheduling_window_end
       ) SELECT laboratory.clinic_id,laboratory.student_number,'LABORATORY',$2,'PENDING',TRUE,
                $3,laboratory.id,$4,$4,laboratory.schedule_pair_id,laboratory.schedule_cycle_start,
                $5,$6,$7,laboratory.scheduling_category,laboratory.scheduling_accepted_at,
                laboratory.scheduling_source_row_order,laboratory.scheduling_window_start,
                laboratory.scheduling_window_end
           FROM appointments laboratory
          WHERE laboratory.id=ANY($1::uuid[])
       RETURNING id::text,student_number`,
      [
        planned.cases.map((item) => item.laboratory_id),
        parsed.data.replacementLaboratoryDate,
        reason,
        actor.userId,
        batchId,
        revisionId,
        laboratoryReservation.rows[0].id,
      ],
    );
    await linkPublishedLaboratoryAppointments(client, newLaboratories.rows.map((appointment) => appointment.id));
    const newLaboratoryByStudent = new Map(
      newLaboratories.rows.map((item) => [item.student_number, item.id]),
    );
    const movedCaseRows = planned.cases.filter(
      (item) => allocationByStudent.get(item.student_number)?.physicalExamAction === "MOVE",
    );
    if (movedCaseRows.length) {
      await client.query(
        `UPDATE appointments
            SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [movedCaseRows.map((item) => item.physical_id), actor.userId],
      );
    }
    const movedAppointmentInput = movedCaseRows.map((item) => ({
      appointment_id: item.physical_id,
      student_number: item.student_number,
      date: allocationByStudent.get(item.student_number)!.proposedPhysicalExamDate,
      reservation_id: movedReservationByStudent.get(item.student_number),
    }));
    const newPhysicals = movedAppointmentInput.length
      ? await client.query<{ id: string; student_number: string }>(
          `INSERT INTO appointments (
             clinic_id,student_number,schedule_type,appointment_date,status,is_published,
             notes,rescheduled_from,created_by,updated_by,schedule_pair_id,schedule_cycle_start,
             ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,
             scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
             scheduling_window_start,scheduling_window_end
           ) SELECT physical.clinic_id,physical.student_number,'PHYSICAL_EXAM',row.date,
                    'PENDING',TRUE,$2,physical.id,$3,$3,physical.schedule_pair_id,
                    physical.schedule_cycle_start,$4,$5,row.reservation_id,
                    physical.scheduling_category,physical.scheduling_accepted_at,
                    physical.scheduling_source_row_order,physical.scheduling_window_start,
                    physical.scheduling_window_end
               FROM jsonb_to_recordset($1::jsonb)
                 AS row(appointment_id uuid,student_number text,date date,reservation_id uuid)
               JOIN appointments physical ON physical.id=row.appointment_id
           RETURNING id::text,student_number`,
          [JSON.stringify(movedAppointmentInput), reason, actor.userId, batchId, revisionId],
        )
      : { rows: [] as Array<{ id: string; student_number: string }> };
    const newPhysicalByStudent = new Map(
      newPhysicals.rows.map((item) => [item.student_number, item.id]),
    );
    for (const item of planned.cases) {
      const allocation = allocationByStudent.get(item.student_number)!;
      if (allocation.physicalExamAction === "PRESERVE") {
        await client.query(
          `UPDATE appointments
              SET ovpsa_revision_id=$2,ovpsa_service_reservation_id=$3,
                  updated_by=$4,updated_at=clock_timestamp()
            WHERE id=$1`,
          [
            item.physical_id,
            revisionId,
            preservedReservationByDate.get(allocation.proposedPhysicalExamDate),
            actor.userId,
          ],
        );
      }
      const newLaboratoryId = newLaboratoryByStudent.get(item.student_number)!;
      const newPhysicalId = allocation.physicalExamAction === "PRESERVE"
        ? item.physical_id
        : newPhysicalByStudent.get(item.student_number)!;
      await client.query(
        `UPDATE clinic_closure_manual_cases
            SET status='RESOLVED',resolved_at=clock_timestamp(),resolved_by=$2,
                resolution_action='ASSIGN_REPLACEMENT',
                resolution_details=jsonb_build_object(
                  'batchRecovery',TRUE,'revisionId',$3::text,
                  'laboratoryDate',$4::text,'physicalExamDate',$5::text,
                  'physicalExamAction',$6::text,'reason',$7::text
                ),optimistic_token=gen_random_uuid(),updated_at=clock_timestamp()
          WHERE id=$1 AND status='OPEN'`,
        [
          item.case_id,
          actor.userId,
          revisionId,
          parsed.data.replacementLaboratoryDate,
          allocation.proposedPhysicalExamDate,
          allocation.physicalExamAction,
          reason,
        ],
      );
      await client.query(
        `UPDATE appointment_reschedule_events
            SET outcome='MANUALLY_RESOLVED',new_laboratory_appointment_id=$2,
                new_physical_exam_appointment_id=$3,ovpsa_target_revision_id=$4,
                policy_metadata=policy_metadata||jsonb_build_object(
                  'batchRecovery',TRUE,'physicalExamAction',$5::text
                )
          WHERE manual_case_id=$1`,
        [item.case_id, newLaboratoryId, newPhysicalId, revisionId, allocation.physicalExamAction],
      );
    }
    await client.query(
      `UPDATE ovpsa_first_year_active_memberships
          SET released_at=clock_timestamp(),released_by=$3,release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2 AND released_at IS NULL`,
      [batchId, planned.batch.revision_id, actor.userId, reason],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_active_memberships (
         batch_id,revision_id,student_number,schedule_cycle_start
       ) SELECT $1,$2,student_number,$3
           FROM ovpsa_first_year_membership_snapshots WHERE revision_id=$2`,
      [batchId, revisionId, planned.batch.schedule_cycle_start],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='SUPERSEDED',superseded_by_revision_id=$2,
              superseded_at=clock_timestamp()
        WHERE id=$1 AND status='PUBLISHED'`,
      [planned.batch.revision_id, revisionId],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='PUBLISHED',published_by=$2,published_at=clock_timestamp()
        WHERE id=$1 AND status='VALIDATED'`,
      [revisionId, actor.userId],
    );
    const nextToken = randomUUID();
    await client.query(
      `UPDATE ovpsa_first_year_batches
          SET status='PUBLISHED',current_revision_id=$2,optimistic_token=$3,
              updated_by=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND status='RESCHEDULE_REQUIRED'`,
      [batchId, revisionId, nextToken, actor.userId],
    );
    let notificationWarningCount = 0;
    for (const item of planned.cases) {
      notificationWarningCount += await createClosureNotification(client, {
        studentNumber: item.student_number,
        build: (state) => buildManualResolutionCompletedNotification({
          state,
          eventId: item.case_id,
          eventKeyDiscriminator: "resolved",
          reason,
          previous: {
            laboratory: {
              date: item.laboratory_date,
              location: "Iloilo Mission Hospital",
            },
            physicalExam: {
              date: item.physical_date,
              location: "CPU Clinic",
            },
          },
        }),
        actorUserId: actor.userId,
        auditEntityId: batchId,
        auditEntityType: "ovpsa_first_year_batch",
      });
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'OVPSA_CLINIC_CLOSURE_BATCH_RECOVERED','ovpsa_first_year_batch',$2,
               jsonb_build_object(
                 'previousRevisionId',$3::text,'revisionId',$4::text,
                 'linkedCaseCount',$5::int,'preservedPhysicalExamCount',$6::int,
                 'movedPhysicalExamCount',$7::int,'notificationWarningCount',$8::int,
                 'reason',$9::text
               ))`,
      [
        actor.userId,
        batchId,
        planned.batch.revision_id,
        revisionId,
        planned.preview.linkedCaseCount,
        planned.preview.preservedPhysicalExamCount,
        planned.preview.movedPhysicalExamCount,
        notificationWarningCount,
        reason,
      ],
    );
    return {
      ...planned.preview,
      optimisticToken: nextToken,
      revisionId,
      revisionNumber: planned.batch.revision_number + 1,
      notificationWarningCount,
    };
  });
}
