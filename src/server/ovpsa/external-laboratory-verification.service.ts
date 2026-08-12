import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";

import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  changeAppointmentStatusWithClient,
  type AppointmentMutationContext,
} from "@/server/repositories/appointments.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import type { SessionUser } from "@/types/roles";

const verificationSchema = z.object({
  remarks: z.union([z.string().trim().max(2000), z.null()]).optional(),
}).strict();

type OvpsaCompletionContext = Pick<
  AppointmentMutationContext,
  "studentNumber" | "scheduleType" | "ovpsaBatchId"
>;

export async function assertOvpsaAppointmentCompletionAllowed(
  client: PoolClient,
  appointment: OvpsaCompletionContext,
) {
  if (!appointment.ovpsaBatchId) return;
  if (appointment.scheduleType === "LABORATORY") {
    throw new AppError(
      "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
      "First Year Mission Hospital Laboratory appointments can only be completed through external-result verification.",
      422,
    );
  }
  if (appointment.scheduleType !== "PHYSICAL_EXAM") return;
  const verified = await client.query(
    `SELECT 1
       FROM ovpsa_external_laboratory_verifications verification
       JOIN appointments laboratory ON laboratory.id=verification.appointment_id
      WHERE verification.batch_id=$1
        AND laboratory.student_number=$2
        AND laboratory.schedule_type='LABORATORY'
        AND laboratory.status='COMPLETED'
      LIMIT 1`,
    [appointment.ovpsaBatchId, appointment.studentNumber],
  );
  if (!verified.rowCount) {
    throw new AppError(
      "OVPSA_PHYSICAL_EXAM_REQUIRES_LAB_VERIFICATION",
      "Verify the student's Iloilo Mission Hospital Laboratory result before completing the Physical Examination.",
      409,
    );
  }
}

function assertVerificationActor(actor: SessionUser) {
  if (actor.role === "ADMIN") return;
  if (actor.role === "CLINIC_STAFF" && actor.clinicCode === "CPU_CLINIC") return;
  throw new AppError(
    "FORBIDDEN",
    "Only administrators and CPU Clinic staff can verify external Laboratory results.",
    403,
  );
}

export async function verifyOvpsaExternalLaboratory(
  appointmentId: string,
  raw: unknown,
  actor: SessionUser,
) {
  assertVerificationActor(actor);
  const input = verificationSchema.parse(raw);
  try {
    return await transaction(async (client) => {
      const result = await client.query<{
        id: string;
        student_number: string;
        schedule_type: string;
        status: string;
        ovpsa_batch_id: string | null;
        ovpsa_revision_id: string | null;
      }>(
        `SELECT id::text,student_number,schedule_type,status,
                ovpsa_batch_id::text,ovpsa_revision_id::text
           FROM appointments
          WHERE id=$1 AND is_published=TRUE
          FOR UPDATE`,
        [appointmentId],
      );
      const appointment = result.rows[0];
      if (!appointment) {
        throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 404);
      }
      if (
        appointment.schedule_type !== "LABORATORY"
        || !appointment.ovpsa_batch_id
        || !appointment.ovpsa_revision_id
      ) {
        throw new AppError(
          "OVPSA_EXTERNAL_LABORATORY_REQUIRED",
          "Only linked First Year Mission Hospital Laboratory appointments can be verified here.",
          422,
        );
      }
      if (appointment.status !== "PENDING") {
        throw new AppError(
          "OVPSA_EXTERNAL_LABORATORY_STATUS_INVALID",
          "Only a pending external Laboratory appointment can be verified.",
          409,
        );
      }
      const verification = await client.query<{ id: string; verified_at: Date }>(
        `INSERT INTO ovpsa_external_laboratory_verifications (
           appointment_id,batch_id,revision_id,external_provider,remarks,verified_by
         ) VALUES ($1,$2,$3,'Iloilo Mission Hospital',$4,$5)
         RETURNING id::text,verified_at`,
        [
          appointment.id,
          appointment.ovpsa_batch_id,
          appointment.ovpsa_revision_id,
          input.remarks?.trim() || null,
          actor.userId,
        ],
      );
      await changeAppointmentStatusWithClient(
        client,
        appointment.id,
        "PENDING",
        "COMPLETED",
        "Iloilo Mission Hospital Laboratory result verified by CPU Clinic.",
        actor.userId,
      );
      const laboratoryResult = await client.query(
        `INSERT INTO laboratory_results (
           student_number,appointment_id,result_status,completed_at,remarks,encoded_by
         ) VALUES (
           $1,$2,'COMPLETED',(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date,$3,$4
         )
         ON CONFLICT (appointment_id) DO UPDATE
           SET result_status='COMPLETED',
               completed_at=(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date,
               remarks=EXCLUDED.remarks,
               encoded_by=EXCLUDED.encoded_by,
               updated_at=clock_timestamp()
         WHERE laboratory_results.result_status='PENDING_UPLOAD'
         RETURNING id`,
        [
          appointment.student_number,
          appointment.id,
          input.remarks?.trim() || null,
          actor.userId,
        ],
      );
      if (!laboratoryResult.rowCount) {
        throw new AppError(
          "APPOINTMENT_RESULT_PROTECTED",
          "Existing protected Laboratory result data prevents external verification.",
          409,
        );
      }
      await writeAudit(
        actor.userId,
        "OVPSA_FIRST_YEAR_LAB_RESULT_VERIFIED",
        "appointment",
        appointment.id,
        {
          studentNumber: appointment.student_number,
          batchId: appointment.ovpsa_batch_id,
          revisionId: appointment.ovpsa_revision_id,
          externalProvider: "Iloilo Mission Hospital",
          remarks: input.remarks?.trim() || null,
          verificationId: verification.rows[0].id,
        },
        client,
      );
      return {
        verificationId: verification.rows[0].id,
        appointmentId: appointment.id,
        studentNumber: appointment.student_number,
        externalProvider: "Iloilo Mission Hospital" as const,
        verifiedAt: verification.rows[0].verified_at.toISOString(),
      };
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError(
        "OVPSA_EXTERNAL_LABORATORY_ALREADY_VERIFIED",
        "This external Laboratory result was already verified.",
        409,
      );
    }
    throw error;
  }
}
