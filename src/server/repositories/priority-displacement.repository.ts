import type { PoolClient } from "pg";

export type DisplacementCandidate = {
  displacementType: "PAIR" | "PHYSICAL_EXAM_ONLY";
  studentNumber: string;
  schedulePairId: string;
  laboratoryAppointmentId: string;
  laboratoryDate: string;
  physicalExamAppointmentId: string;
  physicalExamDate: string;
  schedulingCategory: "REGULAR" | "OJT" | "TOUR";
  acceptedAt: Date;
  sourceRowOrder: number;
  schedulingWindowStart: string;
  schedulingWindowEnd: string;
  scheduleCycleStart: number;
  scheduleCycleClosingDate: string;
};

export async function lockEligibleRegularPairs(
  client: PoolClient,
  input: {
    scheduleCycleStart: number;
    windowStart: string;
    windowEnd: string;
    limit: number;
  },
): Promise<DisplacementCandidate[]> {
  if (input.limit <= 0) return [];
  const result = await client.query<{
    student_number: string;
    schedule_pair_id: string;
    laboratory_appointment_id: string;
    laboratory_date: string;
    physical_exam_appointment_id: string;
    physical_exam_date: string;
    scheduling_category: DisplacementCandidate["schedulingCategory"];
    accepted_at: Date;
    source_row_order: number;
    scheduling_window_start: string;
    scheduling_window_end: string;
    schedule_cycle_start: number;
    schedule_cycle_closing_date: string;
  }>(
    `SELECT laboratory.student_number,
            laboratory.schedule_pair_id::text,
            laboratory.id AS laboratory_appointment_id,
            laboratory.appointment_date::text AS laboratory_date,
            physical.id AS physical_exam_appointment_id,
            physical.appointment_date::text AS physical_exam_date,
            COALESCE(laboratory.scheduling_category,import_group.student_category,'REGULAR')
              AS scheduling_category,
            COALESCE(laboratory.scheduling_accepted_at,import_group.accepted_at,laboratory.created_at)
              AS accepted_at,
            COALESCE(laboratory.scheduling_source_row_order,
                     laboratory_item.source_row_order,2147483647) AS source_row_order,
            COALESCE(laboratory.scheduling_window_start,laboratory.appointment_date)::text
              AS scheduling_window_start,
            COALESCE(laboratory.scheduling_window_end,
                     make_date(laboratory.schedule_cycle_start+1,3,31))::text
              AS scheduling_window_end,
            laboratory.schedule_cycle_start,
            academic_year.closing_date::text AS schedule_cycle_closing_date
       FROM appointments laboratory
       JOIN appointments physical
         ON physical.schedule_pair_id=laboratory.schedule_pair_id
        AND physical.schedule_type='PHYSICAL_EXAM'
       JOIN schedule_batches batch ON batch.id=laboratory.batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
       JOIN academic_years academic_year
         ON academic_year.start_year=laboratory.schedule_cycle_start
       LEFT JOIN coordinator_schedule_items laboratory_item
         ON laboratory_item.id=laboratory.schedule_item_id
      WHERE laboratory.schedule_type='LABORATORY'
        AND import_group.student_category='REGULAR'
        AND laboratory.schedule_cycle_start=$1
        AND laboratory.appointment_date BETWEEN $2::date AND $3::date
        AND laboratory.appointment_date > (NOW() AT TIME ZONE 'Asia/Manila')::date
        AND physical.appointment_date > (NOW() AT TIME ZONE 'Asia/Manila')::date
        AND laboratory.status='PENDING' AND physical.status='PENDING'
        AND laboratory.is_published=TRUE AND physical.is_published=TRUE
        AND laboratory.is_manually_locked=FALSE
        AND physical.is_manually_locked=FALSE
        AND NOT EXISTS (
          SELECT 1 FROM student_result_submissions submission
           WHERE submission.appointment_id IN (laboratory.id, physical.id)
             AND submission.status='FINALIZED'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM student_result_submissions submission
            JOIN student_result_files file ON file.submission_id=submission.id
           WHERE submission.appointment_id IN (laboratory.id, physical.id)
             AND submission.status='DRAFT'
             AND file.deleted_at IS NULL
             AND file.storage_delete_pending=FALSE
        )
        AND NOT EXISTS (
          SELECT 1 FROM laboratory_results result
           WHERE result.appointment_id=laboratory.id
             AND result.result_status <> 'PENDING_UPLOAD'
        )
        AND NOT EXISTS (
          SELECT 1 FROM exam_results result
           WHERE result.appointment_id=physical.id
             AND result.result_status <> 'PENDING_UPLOAD'
        )
      ORDER BY COALESCE(laboratory.scheduling_accepted_at,import_group.accepted_at,
                        laboratory.created_at) DESC,
               COALESCE(laboratory.scheduling_source_row_order,
                        laboratory_item.source_row_order,2147483647) DESC,
               laboratory.student_number DESC
      LIMIT $4
      FOR UPDATE OF laboratory, physical SKIP LOCKED`,
    [input.scheduleCycleStart, input.windowStart, input.windowEnd, input.limit],
  );
  return result.rows.map((row) => ({
    displacementType: "PAIR",
    studentNumber: row.student_number,
    schedulePairId: row.schedule_pair_id,
    laboratoryAppointmentId: row.laboratory_appointment_id,
    laboratoryDate: row.laboratory_date,
    physicalExamAppointmentId: row.physical_exam_appointment_id,
    physicalExamDate: row.physical_exam_date,
    schedulingCategory: row.scheduling_category,
    acceptedAt: row.accepted_at,
    sourceRowOrder: row.source_row_order,
    schedulingWindowStart: row.scheduling_window_start,
    schedulingWindowEnd: row.scheduling_window_end,
    scheduleCycleStart: row.schedule_cycle_start,
    scheduleCycleClosingDate: row.schedule_cycle_closing_date,
  }));
}

export async function lockEligibleRegularPhysicalExams(
  client: PoolClient,
  input: {
    scheduleCycleStart: number;
    windowStart: string;
    windowEnd: string;
    limit: number;
    excludedPhysicalExamIds?: string[];
  },
): Promise<DisplacementCandidate[]> {
  if (input.limit <= 0) return [];
  const result = await client.query<{
    student_number: string;
    schedule_pair_id: string;
    laboratory_appointment_id: string;
    laboratory_date: string;
    physical_exam_appointment_id: string;
    physical_exam_date: string;
    scheduling_category: DisplacementCandidate["schedulingCategory"];
    accepted_at: Date;
    source_row_order: number;
    scheduling_window_start: string;
    scheduling_window_end: string;
    schedule_cycle_start: number;
    schedule_cycle_closing_date: string;
  }>(
    `SELECT physical.student_number,
            physical.schedule_pair_id::text,
            laboratory.id AS laboratory_appointment_id,
            laboratory.appointment_date::text AS laboratory_date,
            physical.id AS physical_exam_appointment_id,
            physical.appointment_date::text AS physical_exam_date,
            COALESCE(physical.scheduling_category,laboratory.scheduling_category,
                     import_group.student_category,'REGULAR') AS scheduling_category,
            COALESCE(physical.scheduling_accepted_at,laboratory.scheduling_accepted_at,
                     import_group.accepted_at,physical.created_at) AS accepted_at,
            COALESCE(physical.scheduling_source_row_order,
                     physical_item.source_row_order,2147483647) AS source_row_order,
            COALESCE(physical.scheduling_window_start,laboratory.scheduling_window_start,
                     physical.appointment_date)::text AS scheduling_window_start,
            COALESCE(physical.scheduling_window_end,laboratory.scheduling_window_end,
                     make_date(physical.schedule_cycle_start+1,3,31))::text
              AS scheduling_window_end,
            physical.schedule_cycle_start,
            academic_year.closing_date::text AS schedule_cycle_closing_date
       FROM appointments physical
       JOIN appointments laboratory
         ON laboratory.schedule_pair_id=physical.schedule_pair_id
        AND laboratory.schedule_type='LABORATORY'
        AND laboratory.status NOT IN ('RESCHEDULED','CANCELLED')
       JOIN schedule_batches batch ON batch.id=physical.batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
       JOIN academic_years academic_year
         ON academic_year.start_year=physical.schedule_cycle_start
       LEFT JOIN coordinator_schedule_items physical_item
         ON physical_item.id=physical.schedule_item_id
      WHERE physical.schedule_type='PHYSICAL_EXAM'
        AND import_group.student_category='REGULAR'
        AND physical.schedule_cycle_start=$1
        AND physical.appointment_date BETWEEN $2::date AND $3::date
        AND physical.appointment_date > (NOW() AT TIME ZONE 'Asia/Manila')::date
        AND physical.status='PENDING'
        AND physical.is_published=TRUE
        AND physical.is_manually_locked=FALSE
        AND NOT (physical.id = ANY($5::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM student_result_submissions submission
           WHERE submission.appointment_id=physical.id
             AND submission.status='FINALIZED'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM student_result_submissions submission
            JOIN student_result_files file ON file.submission_id=submission.id
           WHERE submission.appointment_id=physical.id
             AND submission.status='DRAFT'
             AND file.deleted_at IS NULL
             AND file.storage_delete_pending=FALSE
        )
        AND NOT EXISTS (
          SELECT 1 FROM exam_results result
           WHERE result.appointment_id=physical.id
             AND result.result_status <> 'PENDING_UPLOAD'
        )
      ORDER BY COALESCE(physical.scheduling_accepted_at,laboratory.scheduling_accepted_at,
                        import_group.accepted_at,physical.created_at) DESC,
               COALESCE(physical.scheduling_source_row_order,
                        physical_item.source_row_order,2147483647) DESC,
               physical.student_number DESC
      LIMIT $4
      FOR UPDATE OF physical SKIP LOCKED`,
    [
      input.scheduleCycleStart,
      input.windowStart,
      input.windowEnd,
      input.limit,
      input.excludedPhysicalExamIds ?? [],
    ],
  );
  return result.rows.map((row) => ({
    displacementType: "PHYSICAL_EXAM_ONLY",
    studentNumber: row.student_number,
    schedulePairId: row.schedule_pair_id,
    laboratoryAppointmentId: row.laboratory_appointment_id,
    laboratoryDate: row.laboratory_date,
    physicalExamAppointmentId: row.physical_exam_appointment_id,
    physicalExamDate: row.physical_exam_date,
    schedulingCategory: row.scheduling_category,
    acceptedAt: row.accepted_at,
    sourceRowOrder: row.source_row_order,
    schedulingWindowStart: row.scheduling_window_start,
    schedulingWindowEnd: row.scheduling_window_end,
    scheduleCycleStart: row.schedule_cycle_start,
    scheduleCycleClosingDate: row.schedule_cycle_closing_date,
  }));
}

export async function markDisplacedAppointmentsRescheduled(
  client: PoolClient,
  candidates: DisplacementCandidate[],
  actorUserId: string,
) {
  const appointmentIds = candidates.flatMap((candidate) => candidate.displacementType === "PAIR"
    ? [candidate.laboratoryAppointmentId, candidate.physicalExamAppointmentId]
    : [candidate.physicalExamAppointmentId]);
  if (!appointmentIds.length) return;
  await client.query(
    `UPDATE appointments
        SET status='RESCHEDULED', updated_by=$2, updated_at=NOW()
      WHERE id = ANY($1::uuid[])`,
    [appointmentIds, actorUserId],
  );
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     )
     SELECT id, 'PENDING', 'RESCHEDULED',
            'Automatically moved for priority scheduling capacity.', $2
       FROM UNNEST($1::uuid[]) AS fixture(id)`,
    [appointmentIds, actorUserId],
  );
}

export async function markDisplacedAppointmentsAwaitingResolution(
  client: PoolClient,
  candidates: DisplacementCandidate[],
  actorUserId: string,
) {
  const appointmentIds = candidates.flatMap((candidate) => candidate.displacementType === "PAIR"
    ? [candidate.laboratoryAppointmentId, candidate.physicalExamAppointmentId]
    : [candidate.physicalExamAppointmentId]);
  if (!appointmentIds.length) return;
  await client.query(
    `UPDATE appointments
        SET status='AWAITING_RESCHEDULE', updated_by=$2, updated_at=NOW()
      WHERE id = ANY($1::uuid[])`,
    [appointmentIds, actorUserId],
  );
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id, old_status, new_status, notes, changed_by
     )
     SELECT id, 'PENDING', 'AWAITING_RESCHEDULE',
            'Automatic priority displacement requires Manual Resolution.', $2
       FROM UNNEST($1::uuid[]) AS fixture(id)`,
    [appointmentIds, actorUserId],
  );
}
