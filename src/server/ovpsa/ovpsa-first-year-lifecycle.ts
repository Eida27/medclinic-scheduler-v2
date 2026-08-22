import "server-only";
import type { PoolClient } from "pg";

import {
  writeAudits,
  type AuditInput,
} from "@/server/repositories/audit.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAwaitingResolutionNotification,
  buildRestorationNotification,
} from "@/server/schedule/schedule-notifications";

export type PersistedClosureDateGroup = {
  closureGroupId: string;
  dates: Array<{ id: string; date: string }>;
};

type RestorationEvent = {
  id: string;
  batchId: string;
  studentNumber: string;
  oldLaboratoryId: string | null;
  newLaboratoryId: string | null;
  oldPhysicalExamId: string | null;
  newPhysicalExamId: string | null;
};

type RestorationAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  isManuallyLocked: boolean;
  rescheduledFrom: string | null;
};

export async function restoreAppointmentsDisplacedByReservationsWithClient(
  client: PoolClient,
  input: { reservationIds: string[]; actorUserId: string; reason: string },
) {
  if (!input.reservationIds.length) return { restored: 0, skipped: 0 };
  const events = await client.query<RestorationEvent>(
    `SELECT id::text,ovpsa_batch_id::text AS "batchId",student_number AS "studentNumber",
            old_laboratory_appointment_id::text AS "oldLaboratoryId",
            new_laboratory_appointment_id::text AS "newLaboratoryId",
            old_physical_exam_appointment_id::text AS "oldPhysicalExamId",
            new_physical_exam_appointment_id::text AS "newPhysicalExamId"
       FROM appointment_reschedule_events
      WHERE ovpsa_source_reservation_id=ANY($1::uuid[])
        AND cause='OVPSA_PUBLICATION'
        AND restoration_decision IS NULL
      ORDER BY student_number,id
      FOR UPDATE`,
    [input.reservationIds],
  );
  if (!events.rowCount) return { restored: 0, skipped: 0 };
  await lockEffectiveAppointmentScopes(client, events.rows.flatMap((event) => {
    const scopes: Array<{ studentNumber: string; scheduleType: "LABORATORY" | "PHYSICAL_EXAM" }> = [];
    if (event.oldLaboratoryId !== event.newLaboratoryId) {
      scopes.push({ studentNumber: event.studentNumber, scheduleType: "LABORATORY" });
    }
    if (event.oldPhysicalExamId !== event.newPhysicalExamId) {
      scopes.push({ studentNumber: event.studentNumber, scheduleType: "PHYSICAL_EXAM" });
    }
    return scopes;
  }));
  let restored = 0;
  let skipped = 0;
  const audits: AuditInput[] = [];
  for (const event of events.rows) {
    const pairs = [
      { oldId: event.oldLaboratoryId, newId: event.newLaboratoryId },
      { oldId: event.oldPhysicalExamId, newId: event.newPhysicalExamId },
    ].filter((pair): pair is { oldId: string; newId: string } => (
      Boolean(pair.oldId && pair.newId && pair.oldId !== pair.newId)
    ));
    const ids = pairs.flatMap((pair) => [pair.oldId, pair.newId]).sort();
    const appointmentRows = await client.query<RestorationAppointment>(
      `SELECT id::text,student_number AS "studentNumber",schedule_type AS "scheduleType",
              appointment_date::text AS "appointmentDate",status,
              is_published AS "isPublished",is_manually_locked AS "isManuallyLocked",
              rescheduled_from::text AS "rescheduledFrom"
         FROM appointments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    const byId = new Map(appointmentRows.rows.map((appointment) => [appointment.id, appointment]));
    const replacements = pairs.map((pair) => byId.get(pair.newId)).filter(
      (appointment): appointment is RestorationAppointment => Boolean(appointment),
    );
    const protection = await loadAppointmentResultProtectionStates(
      client,
      replacements.map((appointment) => appointment.id),
    );
    let decision: "RESTORED" | "SKIPPED_APPOINTMENT_CHANGED" | "SKIPPED_PROTECTED" | "SKIPPED_DATE_BLOCKED" | "SKIPPED_CAPACITY" = "RESTORED";
    const details: Record<string, unknown> = { reason: input.reason };
    if (
      !pairs.length
      || appointmentRows.rowCount !== ids.length
      || pairs.some(({ oldId, newId }) => {
        const original = byId.get(oldId);
        const replacement = byId.get(newId);
        return !original || !replacement
          || original.status !== "RESCHEDULED" || original.isPublished
          || replacement.status !== "PENDING" || !replacement.isPublished
          || replacement.rescheduledFrom !== original.id;
      })
    ) {
      decision = "SKIPPED_APPOINTMENT_CHANGED";
    } else if (replacements.some((appointment) => (
      appointment.isManuallyLocked
      || (protection.get(appointment.id)?.type ?? "CLEAR") !== "CLEAR"
    ))) {
      decision = "SKIPPED_PROTECTED";
    } else {
      for (const { oldId } of pairs) {
        const original = byId.get(oldId)!;
        if (await isSchedulingDateBlocked(client, {
          scheduleType: original.scheduleType,
          date: original.appointmentDate,
        })) {
          decision = "SKIPPED_DATE_BLOCKED";
          details.blockedDate = original.appointmentDate;
          details.scheduleType = original.scheduleType;
          break;
        }
        const capacity = await client.query<{ maximum: number; used: number }>(
          `SELECT setting.max_daily_capacity AS maximum,
                  (SELECT COUNT(*)::int FROM appointments appointment
                    WHERE appointment.schedule_type=$1 AND appointment.appointment_date=$2
                      AND appointment.is_published=TRUE
                      AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
                      AND NOT (
                        appointment.schedule_type='LABORATORY'
                        AND appointment.ovpsa_batch_id IS NOT NULL
                      )) AS used
             FROM clinic_capacity_settings setting
             JOIN clinics clinic ON clinic.id=setting.clinic_id
            WHERE setting.schedule_type=$1
              AND clinic.code=CASE $1 WHEN 'LABORATORY' THEN 'KABALAKA_CLINIC' ELSE 'CPU_CLINIC' END`,
          [original.scheduleType, original.appointmentDate],
        );
        if (!capacity.rowCount || capacity.rows[0].used >= capacity.rows[0].maximum) {
          decision = "SKIPPED_CAPACITY";
          details.capacityDate = original.appointmentDate;
          details.scheduleType = original.scheduleType;
          break;
        }
      }
    }
    if (decision === "RESTORED") {
      const originalIds = pairs.map((pair) => pair.oldId);
      const replacementIds = pairs.map((pair) => pair.newId);
      await client.query(
        `UPDATE appointments SET status='RESCHEDULED',is_published=FALSE,
                updated_by=$2,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [replacementIds, input.actorUserId],
      );
      await client.query(
        `UPDATE appointments SET status='PENDING',is_published=TRUE,
                updated_by=$2,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [originalIds, input.actorUserId],
      );
      await client.query(
        `INSERT INTO appointment_status_logs (appointment_id,old_status,new_status,notes,changed_by)
         SELECT id,'PENDING','RESCHEDULED',$2,$3::uuid FROM UNNEST($1::uuid[]) row(id)
         UNION ALL
         SELECT id,'RESCHEDULED','PENDING',$2,$3::uuid FROM UNNEST($4::uuid[]) row(id)`,
        [replacementIds, `OVPSA displacement restoration: ${input.reason}`, input.actorUserId, originalIds],
      );
      restored += 1;
    } else {
      skipped += 1;
    }
    await client.query(
      `UPDATE appointment_reschedule_events
          SET restoration_decision=$2,restoration_details=$3,
              restored_at=clock_timestamp(),restored_by=$4,restoration_batch_id=$5
        WHERE id=$1`,
      [event.id, decision, details, input.actorUserId, event.batchId],
    );
    if (decision === "RESTORED") {
      const previousLaboratory = replacements.find(
        (appointment) => appointment.scheduleType === "LABORATORY",
      );
      const previousPhysicalExam = replacements.find(
        (appointment) => appointment.scheduleType === "PHYSICAL_EXAM",
      );
      const previous = {
        laboratory: previousLaboratory ? {
          date: previousLaboratory.appointmentDate,
          location: "KABALAKA Clinic",
        } : undefined,
        physicalExam: previousPhysicalExam ? {
          date: previousPhysicalExam.appointmentDate,
          location: "CPU Clinic",
        } : undefined,
      };
      await queueAuthoritativeScheduleNotification(
        client,
        event.studentNumber,
        (state) => buildRestorationNotification({
          state,
          eventId: event.id,
          eventKeyDiscriminator: "restored",
          reason: input.reason,
          previous,
        }),
      );
    }
    audits.push({
      actorUserId: input.actorUserId,
      action: "OVPSA_DISPLACEMENT_RESTORATION_DECIDED",
      entityType: "appointment_reschedule_event",
      entityId: event.id,
      metadata: {
        rescheduleEventId: event.id,
        studentNumber: event.studentNumber,
        decision,
        ...details,
      },
    });
  }
  await writeAudits(client, audits);
  return { restored, skipped };
}

export async function invalidateOvpsaReservationsForClosuresWithClient(
  client: PoolClient,
  groups: PersistedClosureDateGroup[],
  actorUserId: string,
) {
  const closureByDate = new Map(
    groups.flatMap((group) => group.dates.map((date) => [
      date.date,
      { closureGroupId: group.closureGroupId, unavailableDateId: date.id },
    ] as const)),
  );
  if (!closureByDate.size) {
    return { batchCount: 0, appointmentCount: 0 };
  }
  const reservations = await client.query<{
    id: string;
    batch_id: string;
    revision_id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    reservation_date: string;
  }>(
    `SELECT id::text,batch_id::text,revision_id::text,schedule_type,
            reservation_date::text
       FROM ovpsa_first_year_service_reservations
      WHERE status='ACTIVE'
        AND reservation_date=ANY($1::date[])
      ORDER BY schedule_type,reservation_date,batch_id
      FOR UPDATE`,
    [[...closureByDate.keys()]],
  );
  if (!reservations.rowCount) {
    return { batchCount: 0, appointmentCount: 0 };
  }
  const lifecycleRows = reservations.rows.map((reservation) => ({
    reservation_id: reservation.id,
    closure_group_id: closureByDate.get(reservation.reservation_date)!.closureGroupId,
  }));
  await client.query(
    `UPDATE ovpsa_first_year_service_reservations reservation
        SET status='INVALIDATED',
            invalidated_by_closure_group_id=row.closure_group_id,
            invalidated_at=clock_timestamp()
       FROM jsonb_to_recordset($1::jsonb) AS row(
         reservation_id uuid,closure_group_id uuid
       )
      WHERE reservation.id=row.reservation_id AND reservation.status='ACTIVE'`,
    [JSON.stringify(lifecycleRows)],
  );
  const batchIds = [...new Set(reservations.rows.map((reservation) => reservation.batch_id))];
  await client.query(
    `UPDATE ovpsa_first_year_batches
        SET status='RESCHEDULE_REQUIRED',optimistic_token=gen_random_uuid(),
            updated_by=$2
      WHERE id=ANY($1::uuid[]) AND status='PUBLISHED'`,
    [batchIds, actorUserId],
  );
  const affected = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
    ovpsa_batch_id: string;
  }>(
    `UPDATE appointments appointment
        SET status='AWAITING_RESCHEDULE',updated_by=$2,updated_at=clock_timestamp()
       FROM UNNEST($1::uuid[]) reservation(id)
      WHERE appointment.ovpsa_service_reservation_id=reservation.id
        AND appointment.status='PENDING'
        AND appointment.is_published=TRUE
      RETURNING appointment.id::text,appointment.student_number,
                appointment.schedule_type,appointment.appointment_date::text,
                appointment.ovpsa_batch_id::text`,
    [reservations.rows.map((reservation) => reservation.id), actorUserId],
  );
  if (affected.rowCount) {
    await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id,old_status,new_status,notes,changed_by
       ) SELECT id,'PENDING','AWAITING_RESCHEDULE',
                'Official closure requires an administrator-approved First Year OVPSA replacement.',$2
           FROM UNNEST($1::uuid[]) row(id)`,
      [affected.rows.map((appointment) => appointment.id), actorUserId],
    );
  }
  const affectedStudents = new Map<string, typeof affected.rows>();
  for (const appointment of affected.rows) {
    affectedStudents.set(appointment.student_number, [
      ...(affectedStudents.get(appointment.student_number) ?? []),
      appointment,
    ]);
  }
  for (const [studentNumber, appointments] of affectedStudents) {
    const laboratory = appointments.find((appointment) => appointment.schedule_type === "LABORATORY");
    const physicalExam = appointments.find((appointment) => appointment.schedule_type === "PHYSICAL_EXAM");
    await queueAuthoritativeScheduleNotification(
      client,
      studentNumber,
      (state) => buildAwaitingResolutionNotification({
        state,
        eventId: appointments[0].ovpsa_batch_id,
        eventKeyDiscriminator: `awaiting-${appointments.map((appointment) => appointment.id).sort().join(".")}`,
        sourceType: "OVPSA_FIRST_YEAR_BATCH",
        reason: "Official closure requires an administrator-approved First Year OVPSA replacement",
        previous: {
          laboratory: laboratory ? {
            date: laboratory.appointment_date,
            location: "Iloilo Mission Hospital",
          } : undefined,
          physicalExam: physicalExam ? {
            date: physicalExam.appointment_date,
            location: "CPU Clinic",
          } : undefined,
        },
      }),
    );
  }
  await writeAudits(
    client,
    batchIds.map((batchId) => {
      const batchReservations = reservations.rows.filter(
        (reservation) => reservation.batch_id === batchId,
      );
      return {
        actorUserId,
        action: "OVPSA_FIRST_YEAR_RESCHEDULE_REQUIRED",
        entityType: "ovpsa_first_year_batch",
        entityId: batchId,
        metadata: {
        reservations: batchReservations.map((reservation) => ({
          reservationId: reservation.id,
          revisionId: reservation.revision_id,
          scheduleType: reservation.schedule_type,
          date: reservation.reservation_date,
          closureGroupId: closureByDate.get(reservation.reservation_date)!.closureGroupId,
        })),
        },
      };
    }),
  );
  return { batchCount: batchIds.length, appointmentCount: affected.rowCount ?? 0 };
}
