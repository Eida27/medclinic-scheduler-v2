import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  hasOverlappingClinicUnavailableDate,
  insertClinicUnavailableDateRecord,
  listClinicUnavailableDateRecords,
  type ClinicUnavailableDateInput,
} from "@/server/repositories/clinic-unavailable-dates.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import type { SessionUser } from "@/types/roles";
import { createStudentNotification } from "@/server/services/student-notifications.service";

const inputSchema = z.object({
  clinicId: z.string().uuid(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  category: z.enum(["HOLIDAY", "CLOSURE", "MAINTENANCE", "STAFF_UNAVAILABILITY"]),
  reason: z.string().trim().min(3).max(500),
}).superRefine((value, context) => {
  if (value.endDate < value.startDate) {
    context.addIssue({ code: "custom", path: ["endDate"], message: "End date must not precede start date." });
  }
});

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

type Replacement = {
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  schedulePairId: string;
  scheduleCycleStart: number;
  oldAppointmentId: string;
};

function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  }
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
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

function datesBetween(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

async function lockAppointments(
  client: PoolClient,
  clinicId: string,
  startDate: string,
  endDate: string,
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
    `SELECT appointment.id, appointment.student_number, appointment.schedule_type,
            appointment.appointment_date::text, appointment.status,
            appointment.schedule_pair_id::text, appointment.schedule_cycle_start,
            appointment.is_manually_locked, appointment.created_at,
            (
              EXISTS (
                SELECT 1 FROM student_result_submissions submission
                 WHERE submission.appointment_id=appointment.id
                   AND submission.status='FINALIZED'
              )
              OR EXISTS (
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
      WHERE appointment.clinic_id=$1
        AND appointment.appointment_date BETWEEN $2::date AND $3::date
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.appointment_date, appointment.student_number
      FOR UPDATE OF appointment`,
    [clinicId, startDate, endDate],
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

async function lockPairAppointments(client: PoolClient, pairIds: string[]) {
  if (!pairIds.length) return [];
  return lockAppointmentsByPair(client, pairIds);
}

async function lockAppointmentsByPair(
  client: PoolClient,
  pairIds: string[],
) {
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
    `SELECT appointment.id, appointment.student_number, appointment.schedule_type,
            appointment.appointment_date::text, appointment.status,
            appointment.schedule_pair_id::text, appointment.schedule_cycle_start,
            appointment.is_manually_locked, appointment.created_at,
            (
              EXISTS (SELECT 1 FROM student_result_submissions submission
                       WHERE submission.appointment_id=appointment.id AND submission.status='FINALIZED')
              OR EXISTS (SELECT 1 FROM laboratory_results result
                         WHERE result.appointment_id=appointment.id AND result.result_status <> 'PENDING_UPLOAD')
              OR EXISTS (SELECT 1 FROM exam_results result
                         WHERE result.appointment_id=appointment.id AND result.result_status <> 'PENDING_UPLOAD')
            ) AS has_protected_result
      FROM appointments appointment
      WHERE appointment.schedule_pair_id = ANY($1::uuid[])
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.student_number, appointment.schedule_type
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

export async function listClinicUnavailableDates(actor: SessionUser) {
  assertAdmin(actor);
  return listClinicUnavailableDateRecords();
}

export async function createClinicUnavailableDate(raw: unknown, actor: SessionUser) {
  assertAdmin(actor);
  const input = inputSchema.parse(raw) satisfies ClinicUnavailableDateInput;
  if (input.startDate <= manilaToday()) {
    throw new AppError(
      "CLINIC_BLOCK_NOT_FUTURE",
      "Automatic clinic blocks must begin after today in Manila.",
      422,
    );
  }
  if (datesBetween(input.startDate, input.endDate).length > 366) {
    throw new AppError("CLINIC_BLOCK_RANGE_TOO_LONG", "Clinic blocks may span at most 366 days.", 422);
  }

  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const clinic = await client.query<{ code: "KABALAKA_CLINIC" | "CPU_CLINIC" }>(
      "SELECT code FROM clinics WHERE id=$1",
      [input.clinicId],
    );
    if (!clinic.rowCount) {
      throw new AppError("CLINIC_NOT_FOUND", "Clinic not found.", 404);
    }
    if (await hasOverlappingClinicUnavailableDate(client, input)) {
      throw new AppError("CLINIC_BLOCK_OVERLAP", "This clinic already has an overlapping unavailable date.", 409);
    }

    const affected = await lockAppointments(client, input.clinicId, input.startDate, input.endDate);
    const pairIds = [...new Set(affected.flatMap((appointment) => (
      appointment.schedulePairId ? [appointment.schedulePairId] : []
    )))];
    const pairs = await lockPairAppointments(client, pairIds);
    const pairMembers = new Map<string, LockedAppointment[]>();
    for (const appointment of pairs) {
      if (!appointment.schedulePairId) continue;
      pairMembers.set(appointment.schedulePairId, [
        ...(pairMembers.get(appointment.schedulePairId) ?? []),
        appointment,
      ]);
    }
    const appointmentsToMove = clinic.rows[0].code === "KABALAKA_CLINIC"
      ? [...new Map(pairIds.flatMap((pairId) => (
          (pairMembers.get(pairId) ?? []).map((appointment) => [appointment.id, appointment] as const)
        ))).values()]
      : affected;
    await lockEffectiveAppointmentScopes(client, appointmentsToMove);
    const unresolved = appointmentsToMove.filter((appointment) => (
      appointment.status !== "PENDING"
      || appointment.isManuallyLocked
      || appointment.hasProtectedResult
    ));
    if (unresolved.length) {
      throw new AppError(
        "CLINIC_BLOCK_PROTECTED_APPOINTMENTS",
        "Some affected appointments are protected and require manual resolution.",
        409,
        {
          unresolved: unresolved.map(
            (appointment) => `${appointment.id}:${appointment.studentNumber}`,
          ),
        },
      );
    }

    const capacityRows = await client.query<{
      clinic_id: string;
      clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      max_daily_capacity: number;
    }>(
      `SELECT setting.clinic_id, clinic.code AS clinic_code, setting.schedule_type,
              setting.max_daily_capacity
         FROM clinic_capacity_settings setting
         JOIN clinics clinic ON clinic.id=setting.clinic_id`,
    );
    const capacityByType = new Map(capacityRows.rows.map((row) => [row.schedule_type, row]));
    const laboratoryCapacity = capacityByType.get("LABORATORY")!;
    const physicalCapacity = capacityByType.get("PHYSICAL_EXAM")!;
    const earliestReplacementDate = addDays(manilaToday(), 1);
    const searchStartDate = [
      input.startDate,
      ...pairIds.flatMap((pairId) => (
        (pairMembers.get(pairId) ?? []).map((appointment) => appointment.appointmentDate)
      )),
    ].sort()[0];
    const searchEndDate = addDays(input.endDate, 366 * 5);
    const loadRows = await client.query<{ clinic_code: string; date: string; count: number }>(
      `SELECT clinic.code AS clinic_code, appointment.appointment_date::text AS date,
              COUNT(*)::int AS count
         FROM appointments appointment
         JOIN clinics clinic ON clinic.id=appointment.clinic_id
        WHERE appointment.appointment_date BETWEEN $1 AND $2
          AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
        GROUP BY clinic.code, appointment.appointment_date`,
      [searchStartDate, searchEndDate],
    );
    const laboratoryLoad = Object.fromEntries(loadRows.rows
      .filter((row) => row.clinic_code === "KABALAKA_CLINIC").map((row) => [row.date, row.count]));
    const physicalLoad = Object.fromEntries(loadRows.rows
      .filter((row) => row.clinic_code === "CPU_CLINIC").map((row) => [row.date, row.count]));
    for (const appointment of appointmentsToMove) {
      const load = appointment.scheduleType === "LABORATORY" ? laboratoryLoad : physicalLoad;
      load[appointment.appointmentDate] = Math.max(0, (load[appointment.appointmentDate] ?? 0) - 1);
    }
    const existingBlocked = await client.query<{ clinic_code: string; start_date: string; end_date: string }>(
      `SELECT clinic.code AS clinic_code, unavailable.start_date::text, unavailable.end_date::text
         FROM clinic_unavailable_dates unavailable
         JOIN clinics clinic ON clinic.id=unavailable.clinic_id
        WHERE unavailable.end_date >= $1::date AND unavailable.start_date <= $2::date`,
      [searchStartDate, searchEndDate],
    );
    const blockedLaboratory = new Set(existingBlocked.rows
      .filter((row) => row.clinic_code === "KABALAKA_CLINIC")
      .flatMap((row) => datesBetween(row.start_date, row.end_date)));
    const blockedPhysical = new Set(existingBlocked.rows
      .filter((row) => row.clinic_code === "CPU_CLINIC")
      .flatMap((row) => datesBetween(row.start_date, row.end_date)));
    const newBlocked = datesBetween(input.startDate, input.endDate);
    const targetBlocked = clinic.rows[0].code === "KABALAKA_CLINIC" ? blockedLaboratory : blockedPhysical;
    for (const date of newBlocked) targetBlocked.add(date);

    const firstAvailable = (
      startDate: string,
      blocked: Set<string>,
      load: Record<string, number>,
      maxCapacity: number,
    ) => {
      const ceiling = Math.max(0, maxCapacity);
      for (let date = startDate; date <= searchEndDate; date = addDays(date, 1)) {
        if (!isWeekday(date) || blocked.has(date)) continue;
        if ((load[date] ?? 0) < ceiling) return date;
      }
      return null;
    };

    const replacements: Replacement[] = [];
    const affectedByPair = [...pairMembers.entries()].filter(([pairId]) => pairIds.includes(pairId));
    if (clinic.rows[0].code === "KABALAKA_CLINIC") {
      for (const [pairId, members] of affectedByPair) {
        const oldLaboratory = members.find((appointment) => appointment.scheduleType === "LABORATORY")!;
        const oldPhysical = members.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")!;
        const laboratoryDate = firstAvailable(
          oldLaboratory.appointmentDate,
          blockedLaboratory,
          laboratoryLoad,
          laboratoryCapacity.max_daily_capacity,
        );
        const physicalDate = laboratoryDate && firstAvailable(
          addDays(laboratoryDate, 1),
          blockedPhysical,
          physicalLoad,
          physicalCapacity.max_daily_capacity,
        );
        if (!laboratoryDate || !physicalDate) {
          throw new AppError("CLINIC_BLOCK_REPLACEMENT_UNAVAILABLE", "Affected appointments could not be replaced.", 409);
        }
        const newPairId = randomUUID();
        laboratoryLoad[laboratoryDate] = (laboratoryLoad[laboratoryDate] ?? 0) + 1;
        physicalLoad[physicalDate] = (physicalLoad[physicalDate] ?? 0) + 1;
        replacements.push(
          {
            studentNumber: oldLaboratory.studentNumber,
            scheduleType: "LABORATORY",
            appointmentDate: laboratoryDate,
            schedulePairId: newPairId,
            scheduleCycleStart: oldLaboratory.scheduleCycleStart,
            oldAppointmentId: oldLaboratory.id,
          },
          {
            studentNumber: oldPhysical.studentNumber,
            scheduleType: "PHYSICAL_EXAM",
            appointmentDate: physicalDate,
            schedulePairId: newPairId,
            scheduleCycleStart: oldPhysical.scheduleCycleStart,
            oldAppointmentId: oldPhysical.id,
          },
        );
        void pairId;
      }
    } else {
      for (const oldPhysical of affected) {
        const members = oldPhysical.schedulePairId
          ? pairMembers.get(oldPhysical.schedulePairId) ?? []
          : [];
        const laboratory = members.find((appointment) => appointment.scheduleType === "LABORATORY");
        if (!laboratory || !oldPhysical.schedulePairId) {
          throw new AppError("CLINIC_BLOCK_PAIR_NOT_FOUND", "The paired Laboratory appointment could not be found.", 409);
        }
        const pairedPhysicalStart = addDays(laboratory.appointmentDate, 1);
        const physicalDate = firstAvailable(
          pairedPhysicalStart > earliestReplacementDate
            ? pairedPhysicalStart
            : earliestReplacementDate,
          blockedPhysical,
          physicalLoad,
          physicalCapacity.max_daily_capacity,
        );
        if (!physicalDate) {
          throw new AppError("CLINIC_BLOCK_REPLACEMENT_UNAVAILABLE", "Affected appointments could not be replaced.", 409);
        }
        physicalLoad[physicalDate] = (physicalLoad[physicalDate] ?? 0) + 1;
        replacements.push({
          studentNumber: oldPhysical.studentNumber,
          scheduleType: "PHYSICAL_EXAM",
          appointmentDate: physicalDate,
          schedulePairId: oldPhysical.schedulePairId,
          scheduleCycleStart: oldPhysical.scheduleCycleStart,
          oldAppointmentId: oldPhysical.id,
        });
      }
    }

    const blockId = await insertClinicUnavailableDateRecord(client, input, actor.userId);
    const movedIds = appointmentsToMove.map((appointment) => appointment.id);
    if (movedIds.length) {
      await client.query(
        `UPDATE appointments SET status='RESCHEDULED', updated_by=$2, updated_at=NOW()
          WHERE id = ANY($1::uuid[])`,
        [movedIds, actor.userId],
      );
      await client.query(
        `INSERT INTO appointment_status_logs (
           appointment_id, old_status, new_status, notes, changed_by
         ) SELECT id, 'PENDING', 'RESCHEDULED', 'Clinic unavailable date created.', $2
             FROM UNNEST($1::uuid[]) AS fixture(id)`,
        [movedIds, actor.userId],
      );
    }
    const insertedReplacements: Array<Replacement & { id: string }> = [];
    for (const replacement of replacements) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO appointments (
           clinic_id, student_number, schedule_type, appointment_date, status,
           is_published, notes, rescheduled_from, created_by, updated_by,
           schedule_pair_id, schedule_cycle_start
         ) VALUES ($1,$2,$3,$4,'PENDING',TRUE,$5,$6,$7,$7,$8,$9)
         RETURNING id`,
        [
          replacement.scheduleType === "LABORATORY"
            ? laboratoryCapacity.clinic_id
            : physicalCapacity.clinic_id,
          replacement.studentNumber,
          replacement.scheduleType,
          replacement.appointmentDate,
          `Automatically rescheduled for clinic block: ${input.reason}`,
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
         SELECT id, NULL, 'PENDING', 'Published clinic closure replacement.', $2
           FROM UNNEST($1::uuid[]) AS fixture(id)`,
        [insertedReplacements.map((replacement) => replacement.id), actor.userId],
      );
    }
    for (const studentNumber of [...new Set(replacements.map((replacement) => replacement.studentNumber))]) {
      const originalMembers = appointmentsToMove.filter((appointment) => appointment.studentNumber === studentNumber);
      const newMembers = insertedReplacements.filter((appointment) => appointment.studentNumber === studentNumber);
      await client.query(
        `INSERT INTO appointment_reschedule_events (
           student_number, schedule_pair_id, cause, clinic_unavailable_date_id,
           old_laboratory_appointment_id, new_laboratory_appointment_id,
           old_physical_exam_appointment_id, new_physical_exam_appointment_id,
           actor_user_id
         ) VALUES ($1,$2,'CLINIC_CLOSURE',$3,$4,$5,$6,$7,$8)`,
        [
          studentNumber,
          newMembers[0]?.schedulePairId ?? null,
          blockId,
          originalMembers.find((appointment) => appointment.scheduleType === "LABORATORY")?.id ?? null,
          newMembers.find((appointment) => appointment.scheduleType === "LABORATORY")?.id ?? null,
          originalMembers.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.id ?? null,
          newMembers.find((appointment) => appointment.scheduleType === "PHYSICAL_EXAM")?.id ?? null,
          actor.userId,
        ],
      );
      await createStudentNotification(client, {
        studentNumber,
        notificationType: "SCHEDULE_RESCHEDULED",
        title: "Clinic schedule updated",
        message: clinic.rows[0].code === "KABALAKA_CLINIC"
          ? "A clinic closure changed both clinic dates. Review your updated schedule."
          : "A clinic closure changed your Physical Examination date; your Laboratory date is unchanged.",
        metadata: {
          reason: input.reason,
          clinicUnavailableDateId: blockId,
          previousDates: Object.fromEntries(originalMembers.map((item) => [item.scheduleType, item.appointmentDate])),
          replacementDates: Object.fromEntries(newMembers.map((item) => [item.scheduleType, item.appointmentDate])),
        },
      });
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'CLINIC_UNAVAILABLE_DATE_CREATED','clinic_unavailable_date',$2,
               jsonb_build_object('clinicId',$3::text,'movedStudentCount',$4::int,'movedAppointmentCount',$5::int))`,
      [
        actor.userId,
        blockId,
        input.clinicId,
        new Set(replacements.map((replacement) => replacement.studentNumber)).size,
        appointmentsToMove.length,
      ],
    );
    return {
      id: blockId,
      movedStudentCount: new Set(replacements.map((replacement) => replacement.studentNumber)).size,
      movedAppointmentCount: appointmentsToMove.length,
    };
  });
}
