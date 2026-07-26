import "server-only";
import type { PoolClient } from "pg";
import type { LockedClinicUnavailableDate } from "./clinic-unavailable-dates.repository";
import { lockEffectiveAppointmentScopes } from "./effective-appointment-scope-lock.repository";

export type RestorationScheduleType = "LABORATORY" | "PHYSICAL_EXAM";

export type PublishedReplacementChildState = {
  id: string;
  studentNumber: string;
  scheduleType: RestorationScheduleType;
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  schedulePairId: string | null;
  scheduleCycleStart: number;
  isManuallyLocked: boolean;
  hasFinalizedSubmission: boolean;
  hasProtectedResult: boolean;
  rescheduledFrom: string | null;
};

export type LockedRestorationAppointment = PublishedReplacementChildState & {
  clinicId: string;
  hasPublishedReplacement: boolean;
  publishedReplacementChildren: PublishedReplacementChildState[];
  activeConflictIds: string[];
};

export type ClinicRestorationBundle = {
  block: LockedClinicUnavailableDate;
  clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
  events: Array<{
    id: string;
    studentNumber: string;
    schedulePairId: string | null;
    restoredAt: Date | null;
    oldLaboratory: LockedRestorationAppointment | null;
    newLaboratory: LockedRestorationAppointment | null;
    oldPhysicalExam: LockedRestorationAppointment | null;
    newPhysicalExam: LockedRestorationAppointment | null;
  }>;
};

type BlockRow = {
  id: string;
  clinic_id: string;
  clinic_code: ClinicRestorationBundle["clinicCode"];
  start_date: string;
  end_date: string;
  category: LockedClinicUnavailableDate["category"];
  reason: string;
  created_by: string;
  created_batch_id: string | null;
  updated_at: string;
};

type EventRow = {
  id: string;
  clinic_unavailable_date_id: string;
  student_number: string;
  schedule_pair_id: string | null;
  restored_at: Date | null;
  old_laboratory_appointment_id: string | null;
  new_laboratory_appointment_id: string | null;
  old_physical_exam_appointment_id: string | null;
  new_physical_exam_appointment_id: string | null;
};

type AppointmentRow = {
  id: string;
  clinic_id: string;
  student_number: string;
  schedule_type: RestorationScheduleType;
  appointment_date: string;
  status: string;
  is_published: boolean;
  schedule_pair_id: string | null;
  schedule_cycle_start: number;
  is_manually_locked: boolean;
  has_finalized_submission: boolean;
  has_protected_result: boolean;
  rescheduled_from: string | null;
};

function appointmentState(row: AppointmentRow): PublishedReplacementChildState {
  return {
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    isPublished: row.is_published,
    schedulePairId: row.schedule_pair_id,
    scheduleCycleStart: row.schedule_cycle_start,
    isManuallyLocked: row.is_manually_locked,
    hasFinalizedSubmission: row.has_finalized_submission,
    hasProtectedResult: row.has_protected_result,
    rescheduledFrom: row.rescheduled_from,
  };
}

async function lockAppointments(client: PoolClient, appointmentIds: string[]) {
  if (!appointmentIds.length) return [];
  const result = await client.query<AppointmentRow>(
    `SELECT appointment.id::text, appointment.clinic_id::text,
            appointment.student_number, appointment.schedule_type,
            appointment.appointment_date::text, appointment.status,
            appointment.is_published, appointment.schedule_pair_id::text,
            appointment.schedule_cycle_start, appointment.is_manually_locked,
            appointment.rescheduled_from::text,
            EXISTS (
              SELECT 1
                FROM student_result_submissions submission
               WHERE submission.appointment_id=appointment.id
                 AND submission.status='FINALIZED'
            ) AS has_finalized_submission,
            (
              EXISTS (
                SELECT 1 FROM laboratory_results result
                 WHERE result.appointment_id=appointment.id
                   AND result.result_status <> 'PENDING_UPLOAD'
              )
              OR EXISTS (
                SELECT 1 FROM exam_results result
                 WHERE result.appointment_id=appointment.id
                   AND result.result_status <> 'PENDING_UPLOAD'
              )
            ) AS has_protected_result
       FROM appointments appointment
      WHERE appointment.id=ANY($1::uuid[])
      ORDER BY appointment.id
      FOR UPDATE OF appointment`,
    [appointmentIds],
  );
  return result.rows;
}

/**
 * Locks every row whose state can make a clinic-block reversal unsafe.
 * Callers must keep the surrounding transaction open through planning and apply.
 */
export async function lockRestorationBundles(
  client: PoolClient,
  blockIds: string[],
): Promise<ClinicRestorationBundle[]> {
  const uniqueBlockIds = [...new Set(blockIds)].sort();
  if (!uniqueBlockIds.length) return [];

  const blocks = await client.query<BlockRow>(
    `SELECT unavailable.id::text, unavailable.clinic_id::text,
            clinic.code AS clinic_code, unavailable.start_date::text,
            unavailable.end_date::text, unavailable.category, unavailable.reason,
            unavailable.created_by::text, unavailable.created_batch_id::text,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
      WHERE unavailable.id=ANY($1::uuid[])
        AND unavailable.unblocked_at IS NULL
        AND clinic.code IN ('KABALAKA_CLINIC','CPU_CLINIC')
      ORDER BY unavailable.id
      FOR UPDATE OF unavailable`,
    [uniqueBlockIds],
  );
  if (!blocks.rowCount) return [];

  const lockedBlockIds = blocks.rows.map((block) => block.id);
  const events = await client.query<EventRow>(
    `SELECT event.id::text, event.clinic_unavailable_date_id::text,
            event.student_number, event.schedule_pair_id::text, event.restored_at,
            event.old_laboratory_appointment_id::text,
            event.new_laboratory_appointment_id::text,
            event.old_physical_exam_appointment_id::text,
            event.new_physical_exam_appointment_id::text
       FROM appointment_reschedule_events event
      WHERE event.clinic_unavailable_date_id=ANY($1::uuid[])
      ORDER BY event.clinic_unavailable_date_id, event.created_at, event.id
      FOR UPDATE OF event`,
    [lockedBlockIds],
  );
  const eventAppointmentIds = [...new Set(events.rows.flatMap((event) => [
    event.old_laboratory_appointment_id,
    event.new_laboratory_appointment_id,
    event.old_physical_exam_appointment_id,
    event.new_physical_exam_appointment_id,
  ].filter((id): id is string => Boolean(id))))].sort();
  const appointmentRows = await lockAppointments(client, eventAppointmentIds);
  const appointmentRowById = new Map(appointmentRows.map((appointment) => [appointment.id, appointment]));

  const originalIds = [...new Set(events.rows.flatMap((event) => [
    event.old_laboratory_appointment_id,
    event.old_physical_exam_appointment_id,
  ].filter((id): id is string => Boolean(id))))].sort();
  const originalRows = originalIds.flatMap((id) => {
    const appointment = appointmentRowById.get(id);
    return appointment ? [appointment] : [];
  });
  await lockEffectiveAppointmentScopes(client, originalRows.map((appointment) => ({
    studentNumber: appointment.student_number,
    scheduleType: appointment.schedule_type,
  })));

  const replacementIds = [...new Set(events.rows.flatMap((event) => [
    event.new_laboratory_appointment_id,
    event.new_physical_exam_appointment_id,
  ].filter((id): id is string => Boolean(id))))].sort();
  const childRows = replacementIds.length
    ? (await client.query<AppointmentRow>(
        `SELECT child.id::text, child.clinic_id::text, child.student_number,
                child.schedule_type, child.appointment_date::text, child.status,
                child.is_published, child.schedule_pair_id::text,
                child.schedule_cycle_start, child.is_manually_locked,
                child.rescheduled_from::text,
                EXISTS (
                  SELECT 1 FROM student_result_submissions submission
                   WHERE submission.appointment_id=child.id
                     AND submission.status='FINALIZED'
                ) AS has_finalized_submission,
                (
                  EXISTS (
                    SELECT 1 FROM laboratory_results result
                     WHERE result.appointment_id=child.id
                       AND result.result_status <> 'PENDING_UPLOAD'
                  )
                  OR EXISTS (
                    SELECT 1 FROM exam_results result
                     WHERE result.appointment_id=child.id
                       AND result.result_status <> 'PENDING_UPLOAD'
                  )
                ) AS has_protected_result
           FROM appointments child
          WHERE child.rescheduled_from=ANY($1::uuid[])
            AND child.is_published=TRUE
          ORDER BY child.id
          FOR UPDATE OF child`,
        [replacementIds],
      )).rows
    : [];
  const childrenByParentId = new Map<string, PublishedReplacementChildState[]>();
  for (const child of childRows) {
    if (!child.rescheduled_from) continue;
    childrenByParentId.set(child.rescheduled_from, [
      ...(childrenByParentId.get(child.rescheduled_from) ?? []),
      appointmentState(child),
    ]);
  }

  const activeRows = originalRows.length
    ? (await client.query<{ original_id: string; conflict_id: string }>(
        `SELECT original.id::text AS original_id, active.id::text AS conflict_id
           FROM appointments original
           JOIN appointments active
             ON active.student_number=original.student_number
            AND active.clinic_id=original.clinic_id
            AND active.schedule_type=original.schedule_type
            AND active.schedule_cycle_start=original.schedule_cycle_start
            AND active.id <> original.id
            AND active.status IN ('DRAFT','PENDING')
          WHERE original.id=ANY($1::uuid[])
          ORDER BY original.id, active.id
          FOR UPDATE OF active`,
        [originalIds],
      )).rows
    : [];
  const activeConflictIdsByOriginalId = new Map<string, string[]>();
  for (const active of activeRows) {
    activeConflictIdsByOriginalId.set(active.original_id, [
      ...(activeConflictIdsByOriginalId.get(active.original_id) ?? []),
      active.conflict_id,
    ]);
  }

  const appointmentsById = new Map<string, LockedRestorationAppointment>();
  for (const appointment of appointmentRows) {
    const publishedReplacementChildren = childrenByParentId.get(appointment.id) ?? [];
    appointmentsById.set(appointment.id, {
      ...appointmentState(appointment),
      clinicId: appointment.clinic_id,
      hasPublishedReplacement: publishedReplacementChildren.length > 0,
      publishedReplacementChildren,
      activeConflictIds: activeConflictIdsByOriginalId.get(appointment.id) ?? [],
    });
  }

  return blocks.rows.map((block) => ({
    block: {
      id: block.id,
      clinicId: block.clinic_id,
      startDate: block.start_date,
      endDate: block.end_date,
      category: block.category,
      reason: block.reason,
      createdBy: block.created_by,
      createdBatchId: block.created_batch_id,
      updatedAt: block.updated_at,
    },
    clinicCode: block.clinic_code,
    events: events.rows
      .filter((event) => event.clinic_unavailable_date_id === block.id)
      .map((event) => ({
        id: event.id,
        studentNumber: event.student_number,
        schedulePairId: event.schedule_pair_id,
        restoredAt: event.restored_at,
        oldLaboratory: event.old_laboratory_appointment_id
          ? appointmentsById.get(event.old_laboratory_appointment_id) ?? null
          : null,
        newLaboratory: event.new_laboratory_appointment_id
          ? appointmentsById.get(event.new_laboratory_appointment_id) ?? null
          : null,
        oldPhysicalExam: event.old_physical_exam_appointment_id
          ? appointmentsById.get(event.old_physical_exam_appointment_id) ?? null
          : null,
        newPhysicalExam: event.new_physical_exam_appointment_id
          ? appointmentsById.get(event.new_physical_exam_appointment_id) ?? null
          : null,
      })),
  }));
}
