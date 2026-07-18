import type { PoolClient } from "pg";

export type DisplacementCandidate = {
  studentNumber: string;
  schedulePairId: string;
  laboratoryAppointmentId: string;
  laboratoryDate: string;
  physicalExamAppointmentId: string;
  physicalExamDate: string;
  acceptedAt: Date;
  sourceRowOrder: number;
  scheduleCycleStart: number;
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
    accepted_at: Date;
    source_row_order: number;
    schedule_cycle_start: number;
  }>(
    `SELECT laboratory.student_number,
            laboratory.schedule_pair_id::text,
            laboratory.id AS laboratory_appointment_id,
            laboratory.appointment_date::text AS laboratory_date,
            physical.id AS physical_exam_appointment_id,
            physical.appointment_date::text AS physical_exam_date,
            import_group.accepted_at,
            COALESCE(laboratory_item.source_row_order, 2147483647) AS source_row_order,
            laboratory.schedule_cycle_start
       FROM appointments laboratory
       JOIN appointments physical
         ON physical.schedule_pair_id=laboratory.schedule_pair_id
        AND physical.schedule_type='PHYSICAL_EXAM'
       JOIN schedule_batches batch ON batch.id=laboratory.batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
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
          SELECT 1 FROM laboratory_results result
           WHERE result.appointment_id=laboratory.id
             AND result.result_status <> 'PENDING_UPLOAD'
        )
        AND NOT EXISTS (
          SELECT 1 FROM exam_results result
           WHERE result.appointment_id=physical.id
             AND result.result_status <> 'PENDING_UPLOAD'
        )
      ORDER BY import_group.accepted_at DESC,
               COALESCE(laboratory_item.source_row_order, 2147483647) DESC,
               laboratory.student_number DESC
      LIMIT $4
      FOR UPDATE OF laboratory, physical SKIP LOCKED`,
    [input.scheduleCycleStart, input.windowStart, input.windowEnd, input.limit],
  );
  return result.rows.map((row) => ({
    studentNumber: row.student_number,
    schedulePairId: row.schedule_pair_id,
    laboratoryAppointmentId: row.laboratory_appointment_id,
    laboratoryDate: row.laboratory_date,
    physicalExamAppointmentId: row.physical_exam_appointment_id,
    physicalExamDate: row.physical_exam_date,
    acceptedAt: row.accepted_at,
    sourceRowOrder: row.source_row_order,
    scheduleCycleStart: row.schedule_cycle_start,
  }));
}

export async function markPairsRescheduled(
  client: PoolClient,
  candidates: DisplacementCandidate[],
  actorUserId: string,
) {
  const appointmentIds = candidates.flatMap((candidate) => [
    candidate.laboratoryAppointmentId,
    candidate.physicalExamAppointmentId,
  ]);
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
