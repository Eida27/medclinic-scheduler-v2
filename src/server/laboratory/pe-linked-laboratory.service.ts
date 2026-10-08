import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";

/** Transaction-local finalization; the clinical writer owns authorization and locks. */
export async function completeExternalLaboratoryWithClient(client: PoolClient, appointmentId: string, actorUserId: string): Promise<void> {
  const row = (await client.query<{ studentNumber: string; batchId: string; revisionId: string }>(
    `SELECT a.student_number AS "studentNumber",a.ovpsa_batch_id::text AS "batchId",a.ovpsa_revision_id::text AS "revisionId"
       FROM appointments a
       JOIN ovpsa_first_year_batches b ON b.id=a.ovpsa_batch_id AND b.current_revision_id=a.ovpsa_revision_id
         AND b.schedule_cycle_start=a.schedule_cycle_start AND b.status='PUBLISHED'
       JOIN ovpsa_first_year_batch_revisions r ON r.id=a.ovpsa_revision_id AND r.batch_id=b.id
         AND r.status='PUBLISHED' AND r.laboratory_location='ILOILO_MISSION_HOSPITAL'
       JOIN ovpsa_first_year_service_reservations s ON s.id=a.ovpsa_service_reservation_id
         AND s.batch_id=b.id AND s.revision_id=r.id AND s.schedule_type='LABORATORY'
         AND s.reservation_date=a.appointment_date AND s.status='ACTIVE'
      WHERE a.id=$1 AND a.is_published=TRUE AND a.schedule_type='LABORATORY' AND a.status='COMPLETED'`,
    [appointmentId],
  )).rows[0];
  if (!row) throw new AppError("OVPSA_PROVENANCE_MISSING", "The external Laboratory appointment has no valid current batch provenance.", 409);
  await client.query(`INSERT INTO ovpsa_external_laboratory_verifications
    (appointment_id,batch_id,revision_id,external_provider,verified_by)
    VALUES ($1,$2,$3,'Iloilo Mission Hospital',$4) ON CONFLICT (appointment_id) DO NOTHING`,
  [appointmentId, row.batchId, row.revisionId, actorUserId]);
  const existing = (await client.query<{ batchId: string; revisionId: string; provider: string }>(
    `SELECT batch_id::text AS "batchId",revision_id::text AS "revisionId",external_provider AS provider
       FROM ovpsa_external_laboratory_verifications WHERE appointment_id=$1 FOR UPDATE`, [appointmentId],
  )).rows[0];
  if (!existing || existing.batchId !== row.batchId || existing.revisionId !== row.revisionId || existing.provider !== "Iloilo Mission Hospital") {
    throw new AppError("OVPSA_PROVENANCE_MISSING", "The external Laboratory confirmation has mismatched provenance.", 409);
  }
  const result = (await client.query<{ status: string }>(
    'SELECT result_status AS status FROM laboratory_results WHERE appointment_id=$1 FOR UPDATE', [appointmentId],
  )).rows[0];
  if (result && !["PENDING_UPLOAD", "COMPLETED"].includes(result.status)) {
    throw new AppError("APPOINTMENT_RESULT_PROTECTED", "Protected result data prevents external finalization.", 409);
  }
  await client.query(`INSERT INTO laboratory_results
    (student_number,appointment_id,result_status,completed_at,encoded_by)
    VALUES ($1,$2,'COMPLETED',(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date,$3)
    ON CONFLICT (appointment_id) DO UPDATE SET result_status='COMPLETED',
      completed_at=EXCLUDED.completed_at,encoded_by=EXCLUDED.encoded_by,
      updated_at=clock_timestamp() WHERE laboratory_results.result_status='PENDING_UPLOAD'`,
  [row.studentNumber, appointmentId, actorUserId]);
}
