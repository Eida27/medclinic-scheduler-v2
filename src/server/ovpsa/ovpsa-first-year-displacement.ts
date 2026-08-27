import "server-only";
import type { PoolClient } from "pg";

import { AppError } from "@/lib/errors";
import { generatePairedSchedule } from "@/server/rule-engine/generate-paired-schedule";
import { loadSchedulingBlockedDates } from "@/server/repositories/scheduling-blocked-dates.repository";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import {
  resolveSchedulingWindow,
  type StudentCategory,
} from "@/server/services/scheduling-window";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import {
  buildAwaitingResolutionNotification,
  buildPriorityDisplacementNotification,
} from "@/server/schedule/schedule-notifications";
import { resolveAutomaticReplacementBounds } from "@/server/scheduling/automatic-replacement-bounds";
import type {
  OvpsaBatchBlocker,
  OvpsaDisplacement,
  OvpsaProposedReplacement,
  OvpsaProtectedConflict,
} from "./ovpsa-first-year-planner";
import type { StoredOvpsaBatch } from "./ovpsa-first-year.repository";

type AppointmentLineage = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  schedulePairId: string | null;
  clinicId: string;
  batchId: string | null;
  isManuallyLocked: boolean;
  category: StudentCategory | null;
  acceptedAt: string | null;
  sourceRowOrder: number | null;
  preferredMonth: number | null;
  windowStart: string | null;
  windowEnd: string | null;
};

export type OvpsaDisplacementCandidate = {
  displacementType: "PAIR" | "PHYSICAL_EXAM_ONLY";
  studentNumber: string;
  schedulePairId: string;
  category: StudentCategory;
  acceptedAt: string;
  sourceRowOrder: number;
  preferredMonth: number | null;
  schedulingWindowStart: string;
  schedulingWindowEnd: string;
  conflictingServiceType: "LABORATORY" | "PHYSICAL_EXAM";
  conflictingServiceDate: string;
  laboratory: AppointmentLineage;
  physicalExam: AppointmentLineage;
};

type PlannedReplacement = OvpsaProposedReplacement & {
  candidate: OvpsaDisplacementCandidate;
};

type PlannedFallback = OvpsaDisplacementCandidate;

export type OvpsaServiceDates = {
  laboratoryDates: string[];
  physicalExamDates: string[];
};

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function categoryTier(category: StudentCategory) {
  return category === "REGULAR" ? 2 : 1;
}

function compareDisplacementCandidates(
  left: OvpsaDisplacementCandidate,
  right: OvpsaDisplacementCandidate,
) {
  return categoryTier(left.category) - categoryTier(right.category) ||
    left.acceptedAt.localeCompare(right.acceptedAt) ||
    left.sourceRowOrder - right.sourceRowOrder ||
    left.studentNumber.localeCompare(right.studentNumber) ||
    left.schedulePairId.localeCompare(right.schedulePairId);
}

async function loadDateConflictAppointments(
  client: PoolClient,
  input: {
    batch: StoredOvpsaBatch;
    memberStudentNumbers: string[];
    forUpdate: boolean;
    serviceDates: OvpsaServiceDates;
  },
) {
  const result = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
    status: string;
    schedule_pair_id: string | null;
    clinic_id: string;
    batch_id: string | null;
    is_manually_locked: boolean;
    category: StudentCategory | null;
    accepted_at: Date | null;
    source_row_order: number | null;
    preferred_month: number | null;
    window_start: string | null;
    window_end: string | null;
  }>(
    `SELECT appointment.id::text,appointment.student_number,
            appointment.schedule_type,appointment.appointment_date::text,
            appointment.status,appointment.schedule_pair_id::text,
            appointment.clinic_id::text,appointment.batch_id::text,
            appointment.is_manually_locked,
            COALESCE(appointment.scheduling_category,import_group.student_category,'REGULAR') AS category,
            COALESCE(appointment.scheduling_accepted_at,import_group.accepted_at,
                     appointment.created_at) AS accepted_at,
            COALESCE(appointment.scheduling_source_row_order,item.source_row_order,
                     2147483647) AS source_row_order,
            import_group.preferred_month,
            appointment.scheduling_window_start::text AS window_start,
            appointment.scheduling_window_end::text AS window_end
       FROM appointments appointment
       LEFT JOIN schedule_batches batch ON batch.id=appointment.batch_id
       LEFT JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
       LEFT JOIN coordinator_schedule_items item ON item.id=appointment.schedule_item_id
      WHERE appointment.schedule_cycle_start=$1
        AND (
          (appointment.schedule_type='LABORATORY' AND appointment.appointment_date=ANY($2::date[]))
          OR
          (appointment.schedule_type='PHYSICAL_EXAM' AND appointment.appointment_date=ANY($3::date[]))
        )
        AND NOT (appointment.student_number=ANY($4::varchar[]))
        AND appointment.ovpsa_batch_id IS NULL
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        AND NOT EXISTS (
          SELECT 1 FROM appointments replacement
           WHERE replacement.rescheduled_from=appointment.id
             AND replacement.is_published=TRUE
             AND replacement.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        )
      ORDER BY CASE appointment.schedule_type WHEN 'LABORATORY' THEN 0 ELSE 1 END,
               appointment.student_number,appointment.id
      ${input.forUpdate ? "FOR UPDATE OF appointment" : ""}`,
    [
      input.batch.scheduleCycleStart,
      input.serviceDates.laboratoryDates,
      input.serviceDates.physicalExamDates,
      input.memberStudentNumbers,
    ],
  );
  return result.rows.map((row): AppointmentLineage => ({
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    schedulePairId: row.schedule_pair_id,
    clinicId: row.clinic_id,
    batchId: row.batch_id,
    isManuallyLocked: row.is_manually_locked,
    category: row.category,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    sourceRowOrder: row.source_row_order,
    preferredMonth: row.preferred_month,
    windowStart: row.window_start,
    windowEnd: row.window_end,
  }));
}

async function loadRelatedAppointments(
  client: PoolClient,
  schedulePairIds: string[],
  forUpdate: boolean,
) {
  if (!schedulePairIds.length) return [];
  const result = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
    status: string;
    schedule_pair_id: string;
    clinic_id: string;
    batch_id: string | null;
    is_manually_locked: boolean;
  }>(
    `SELECT appointment.id::text,appointment.student_number,appointment.schedule_type,
            appointment.appointment_date::text,appointment.status,
            appointment.schedule_pair_id::text,appointment.clinic_id::text,
            appointment.batch_id::text,appointment.is_manually_locked
       FROM appointments appointment
      WHERE appointment.schedule_pair_id=ANY($1::uuid[])
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        AND NOT EXISTS (
          SELECT 1 FROM appointments replacement
           WHERE replacement.rescheduled_from=appointment.id
             AND replacement.is_published=TRUE
             AND replacement.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        )
      ORDER BY appointment.schedule_pair_id,appointment.schedule_type,appointment.id
      ${forUpdate ? "FOR UPDATE OF appointment" : ""}`,
    [schedulePairIds],
  );
  return result.rows.map((row): AppointmentLineage => ({
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    schedulePairId: row.schedule_pair_id,
    clinicId: row.clinic_id,
    batchId: row.batch_id,
    isManuallyLocked: row.is_manually_locked,
    category: null,
    acceptedAt: null,
    sourceRowOrder: null,
    preferredMonth: null,
    windowStart: null,
    windowEnd: null,
  }));
}

function protectedConflict(
  appointment: AppointmentLineage,
  reasonCode: string,
  message: string,
): OvpsaProtectedConflict {
  return {
    studentNumber: appointment.studentNumber,
    appointmentId: appointment.id,
    scheduleType: appointment.scheduleType,
    appointmentDate: appointment.appointmentDate,
    reasonCode,
    message,
  };
}

function windowFor(appointment: AppointmentLineage, batch: StoredOvpsaBatch) {
  if (!appointment.category || !appointment.acceptedAt) return null;
  const start =
    appointment.windowStart ??
    resolveSchedulingWindow({
      category: appointment.category,
      academicYearStart: batch.scheduleCycleStart,
      preferredMonth: appointment.preferredMonth,
      acceptedAt: appointment.acceptedAt,
      timeZone: "Asia/Manila",
    });
  return {
    start,
    end: appointment.windowEnd ?? `${batch.scheduleCycleStart + 1}-03-31`,
  };
}

export async function planOvpsaLowerPriorityDisplacements(
  client: PoolClient,
  input: {
    batch: StoredOvpsaBatch;
    memberStudentNumbers: string[];
    forUpdate: boolean;
  },
) {
  return planOvpsaLowerPriorityDisplacementsForServiceDates(client, {
    ...input,
    serviceDates: {
      laboratoryDates: [input.batch.laboratoryDate],
      physicalExamDates: [input.batch.physicalExamDate],
    },
  });
}

export async function planOvpsaLowerPriorityDisplacementsForServiceDates(
  client: PoolClient,
  input: {
    batch: StoredOvpsaBatch;
    memberStudentNumbers: string[];
    forUpdate: boolean;
    serviceDates: OvpsaServiceDates;
  },
) {
  const direct = await loadDateConflictAppointments(client, input);
  const pairIds = [
    ...new Set(
      direct.flatMap((appointment) =>
        appointment.schedulePairId ? [appointment.schedulePairId] : [],
      ),
    ),
  ];
  const related = await loadRelatedAppointments(
    client,
    pairIds,
    input.forUpdate,
  );
  const protection = await loadAppointmentResultProtectionStates(client, [
    ...new Set([...direct, ...related].map((appointment) => appointment.id)),
  ]);
  const relatedByPair = new Map<string, AppointmentLineage[]>();
  for (const appointment of related) {
    if (!appointment.schedulePairId) continue;
    relatedByPair.set(appointment.schedulePairId, [
      ...(relatedByPair.get(appointment.schedulePairId) ?? []),
      appointment,
    ]);
  }
  const protectedConflicts: OvpsaProtectedConflict[] = [];
  const protectedServiceDateKeys = new Set<string>();
  const candidates: OvpsaDisplacementCandidate[] = [];
  const plannedPairIds = new Set<string>();

  for (const conflict of direct) {
    const recordProtected = (protectedAppointment: OvpsaProtectedConflict) => {
      protectedConflicts.push(protectedAppointment);
      protectedServiceDateKeys.add(`${conflict.scheduleType}:${conflict.appointmentDate}`);
    };
    const state = protection.get(conflict.id);
    if (
      conflict.status !== "PENDING" ||
      conflict.isManuallyLocked ||
      state?.type === "PROTECTED"
    ) {
      recordProtected(
        protectedConflict(
          conflict,
          conflict.isManuallyLocked
            ? "APPOINTMENT_MANUALLY_LOCKED"
            : state?.type === "PROTECTED"
              ? state.reason
              : `APPOINTMENT_${conflict.status}`,
          state?.type === "PROTECTED"
            ? state.message
            : "A completed, locked, or otherwise protected appointment cannot be displaced.",
        ),
      );
      continue;
    }
    if (
      !conflict.category ||
      !conflict.acceptedAt ||
      conflict.sourceRowOrder === null
    ) {
      recordProtected(
        protectedConflict(
          conflict,
          "UNKNOWN_SCHEDULING_LINEAGE",
          "This appointment has no category, acceptance, or row-order lineage for safe replacement.",
        ),
      );
      continue;
    }
    if (!conflict.schedulePairId) {
      recordProtected(
        protectedConflict(
          conflict,
          "PAIR_MISSING_OR_INCONSISTENT",
          "This appointment is missing a paired scheduling identifier.",
        ),
      );
      continue;
    }
    if (plannedPairIds.has(conflict.schedulePairId)) continue;
    const pair = relatedByPair.get(conflict.schedulePairId) ?? [];
    const laboratory = pair.filter(
      (appointment) => appointment.scheduleType === "LABORATORY",
    );
    const physicalExam = pair.filter(
      (appointment) => appointment.scheduleType === "PHYSICAL_EXAM",
    );
    if (laboratory.length !== 1 || physicalExam.length !== 1) {
      recordProtected(
        protectedConflict(
          conflict,
          "PAIR_MISSING_OR_INCONSISTENT",
          "The conflicting appointment does not have one current Laboratory and Physical Examination pair.",
        ),
      );
      continue;
    }
    const moving =
      conflict.scheduleType === "LABORATORY"
        ? [laboratory[0], physicalExam[0]]
        : [physicalExam[0]];
    const protectedRelated = moving.find((appointment) => {
      const relatedState = protection.get(appointment.id);
      return (
        appointment.status !== "PENDING" ||
        appointment.isManuallyLocked ||
        relatedState?.type === "PROTECTED"
      );
    });
    if (protectedRelated) {
      const relatedState = protection.get(protectedRelated.id);
      recordProtected(
        protectedConflict(
          protectedRelated,
          protectedRelated.isManuallyLocked
            ? "APPOINTMENT_MANUALLY_LOCKED"
            : relatedState?.type === "PROTECTED"
              ? relatedState.reason
              : `APPOINTMENT_${protectedRelated.status}`,
          relatedState?.type === "PROTECTED"
            ? relatedState.message
            : "The paired appointment cannot be displaced safely.",
        ),
      );
      continue;
    }
    const window = windowFor(conflict, input.batch);
    if (!window) {
      recordProtected(
        protectedConflict(
          conflict,
          "UNKNOWN_SCHEDULING_LINEAGE",
          "The scheduling window could not be reconstructed.",
        ),
      );
      continue;
    }
    candidates.push({
      displacementType:
        conflict.scheduleType === "LABORATORY" ? "PAIR" : "PHYSICAL_EXAM_ONLY",
      studentNumber: conflict.studentNumber,
      schedulePairId: conflict.schedulePairId,
      category: conflict.category,
      acceptedAt: conflict.acceptedAt,
      sourceRowOrder: conflict.sourceRowOrder,
      preferredMonth: conflict.preferredMonth,
      schedulingWindowStart: window.start,
      schedulingWindowEnd: window.end,
      conflictingServiceType: conflict.scheduleType,
      conflictingServiceDate: conflict.appointmentDate,
      laboratory: {
        ...laboratory[0],
        ...(conflict.scheduleType === "LABORATORY" ? conflict : {}),
      },
      physicalExam: {
        ...physicalExam[0],
        ...(conflict.scheduleType === "PHYSICAL_EXAM" ? conflict : {}),
      },
    });
    plannedPairIds.add(conflict.schedulePairId);
  }

  const blockers: OvpsaBatchBlocker[] = [];
  const replacements: PlannedReplacement[] = [];
  const fallbacks: PlannedFallback[] = [];
  if (candidates.length) {
    const today = await client.query<{ manila_today: string }>(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS manila_today",
    );
    const boundedCandidates = candidates.map((candidate) => ({
      candidate,
      bounds: resolveAutomaticReplacementBounds({
        replacementType: candidate.displacementType,
        originalWindowStart: candidate.schedulingWindowStart,
        manilaToday: today.rows[0].manila_today,
        cycleClosingDate: input.batch.closingDate,
        laboratoryDate: candidate.displacementType === "PHYSICAL_EXAM_ONLY"
          ? candidate.laboratory.appointmentDate
          : undefined,
      }),
    }));
    const startDate = boundedCandidates
      .map(({ bounds }) => bounds.lowerBound)
      .sort()[0];
    const endDate = input.batch.closingDate;
    const capacities = await client.query<{
      clinic_id: string;
      clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      max_daily_capacity: number;
    }>(
      `SELECT setting.clinic_id::text,clinic.code AS clinic_code,
              setting.schedule_type,setting.max_daily_capacity
         FROM clinic_capacity_settings setting
         JOIN clinics clinic ON clinic.id=setting.clinic_id
        WHERE setting.is_active=TRUE AND (
          (clinic.code='KABALAKA_CLINIC' AND setting.schedule_type='LABORATORY')
          OR (clinic.code='CPU_CLINIC' AND setting.schedule_type='PHYSICAL_EXAM')
        )`,
    );
    const byType = new Map(
      capacities.rows.map((capacity) => [capacity.schedule_type, capacity]),
    );
    const laboratoryCapacity = byType.get("LABORATORY");
    const physicalExamCapacity = byType.get("PHYSICAL_EXAM");
    if (!laboratoryCapacity || !physicalExamCapacity) {
      throw new AppError(
        "SCHEDULE_CAPACITY_NOT_CONFIGURED",
        "Clinic capacity is not configured.",
        409,
      );
    }
    const movingIds = candidates.flatMap((candidate) =>
      candidate.displacementType === "PAIR"
        ? [candidate.laboratory.id, candidate.physicalExam.id]
        : [candidate.physicalExam.id],
    );
    const load = await client.query<{
      clinic_code: "KABALAKA_CLINIC" | "CPU_CLINIC";
      date: string;
      count: number;
    }>(
      `SELECT clinic.code AS clinic_code,appointment.appointment_date::text AS date,
              COUNT(*)::int AS count
         FROM appointments appointment
         JOIN clinics clinic ON clinic.id=appointment.clinic_id
        WHERE appointment.appointment_date BETWEEN $1::date AND $2::date
          AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
          AND NOT (appointment.id=ANY($3::uuid[]))
          AND NOT (
            appointment.ovpsa_batch_id IS NOT NULL
            AND appointment.schedule_type='LABORATORY'
          )
        GROUP BY clinic.code,appointment.appointment_date`,
      [startDate, endDate, movingIds],
    );
    const loadFor = (clinicCode: string) =>
      Object.fromEntries(
        load.rows
          .filter((row) => row.clinic_code === clinicCode)
          .map((row) => [row.date, row.count]),
      );
    const laboratoryLoad = loadFor("KABALAKA_CLINIC");
    const physicalExamLoad = loadFor("CPU_CLINIC");
    const blocked = await loadSchedulingBlockedDates(client, {
      startDate,
      endDate,
      excludeOvpsaBatchId: input.batch.batchId,
    });
    const blockedLaboratoryDates = [
      ...new Set([...blocked.laboratoryDates, ...input.serviceDates.laboratoryDates]),
    ];
    const blockedPhysicalExamDates = [
      ...new Set([...blocked.physicalExamDates, ...input.serviceDates.physicalExamDates]),
    ];
    const blockedPhysicalExamSet = new Set(blockedPhysicalExamDates);
    const globallyOrdered = boundedCandidates.sort((left, right) =>
      compareDisplacementCandidates(left.candidate, right.candidate));
    for (const { candidate, bounds } of globallyOrdered) {
      if (bounds.lowerBound > bounds.upperBound) {
        fallbacks.push(candidate);
        continue;
      }
      if (candidate.displacementType === "PAIR") {
        const paired = generatePairedSchedule({
          requests: [{
            requestId: `ovpsa:${candidate.schedulePairId}`,
            studentNumber: candidate.studentNumber,
            category: candidate.category,
            acceptedAt: candidate.acceptedAt,
            sourceRowOrder: candidate.sourceRowOrder,
            windowStart: bounds.lowerBound,
          }],
          laboratoryCapacity: {
            maxDailyCapacity: laboratoryCapacity.max_daily_capacity,
          },
          physicalExamCapacity: {
            maxDailyCapacity: physicalExamCapacity.max_daily_capacity,
          },
          existingLaboratoryLoad: laboratoryLoad,
          existingPhysicalExamLoad: physicalExamLoad,
          blockedLaboratoryDates,
          blockedPhysicalExamDates,
          searchEndDate: endDate,
        });
        const assignment = paired.assignments[0];
        if (!assignment) {
          fallbacks.push(candidate);
          continue;
        }
        replacements.push({
          candidate,
          studentNumber: candidate.studentNumber,
          category: candidate.category,
          laboratoryDate: assignment.laboratoryDate,
          physicalExamDate: assignment.physicalExamDate,
        });
        laboratoryLoad[assignment.laboratoryDate] =
          (laboratoryLoad[assignment.laboratoryDate] ?? 0) + 1;
        physicalExamLoad[assignment.physicalExamDate] =
          (physicalExamLoad[assignment.physicalExamDate] ?? 0) + 1;
        continue;
      }
      const start = bounds.lowerBound;
      let date: string | null = null;
      for (
        let proposed = start;
        proposed <= bounds.upperBound;
        proposed = addDays(proposed, 1)
      ) {
        if (!isWeekday(proposed) || blockedPhysicalExamSet.has(proposed))
          continue;
        if (
          (physicalExamLoad[proposed] ?? 0) <
          physicalExamCapacity.max_daily_capacity
        ) {
          date = proposed;
          physicalExamLoad[proposed] = (physicalExamLoad[proposed] ?? 0) + 1;
          break;
        }
      }
      if (!date) {
        fallbacks.push(candidate);
        continue;
      }
      replacements.push({
        candidate,
        studentNumber: candidate.studentNumber,
        category: candidate.category,
        laboratoryDate: null,
        physicalExamDate: date,
      });
    }
  }

  const displacements: OvpsaDisplacement[] = candidates.map((candidate) => ({
    studentNumber: candidate.studentNumber,
    category: candidate.category,
    acceptedAt: candidate.acceptedAt,
    sourceRowOrder: candidate.sourceRowOrder,
    oldLaboratoryDate: candidate.laboratory.appointmentDate,
    oldPhysicalExamDate: candidate.physicalExam.appointmentDate,
    displacementType: candidate.displacementType,
  }));
  return {
    candidates,
    plannedReplacements: replacements,
    plannedFallbacks: fallbacks,
    protectedConflicts,
    protectedServiceDates: [...protectedServiceDateKeys].map((key) => {
      const separator = key.indexOf(":");
      return {
        scheduleType: key.slice(0, separator) as "LABORATORY" | "PHYSICAL_EXAM",
        date: key.slice(separator + 1),
      };
    }),
    replacementBlockedServiceDates: [] as Array<{
      scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
      date: string;
    }>,
    blockers,
    displacements,
    proposedReplacements: replacements.map((replacement) => ({
      studentNumber: replacement.studentNumber,
      category: replacement.category,
      laboratoryDate: replacement.laboratoryDate,
      physicalExamDate: replacement.physicalExamDate,
    })),
  };
}

export async function applyOvpsaLowerPriorityDisplacements(
  client: PoolClient,
  input: {
    batch: StoredOvpsaBatch;
    actorUserId: string;
    plannedReplacements: PlannedReplacement[];
    plannedFallbacks: PlannedFallback[];
    laboratoryReservationId: string;
    physicalExamReservationId?: string;
    physicalExamReservationIdsByDate?: Record<string, string>;
  },
) {
  if (!input.plannedReplacements.length && !input.plannedFallbacks.length) {
    return { displacedCount: 0, automaticReplacementCount: 0, manualResolutionCount: 0 };
  }
  const movingIds = input.plannedReplacements.flatMap(({ candidate }) =>
    candidate.displacementType === "PAIR"
      ? [candidate.laboratory.id, candidate.physicalExam.id]
      : [candidate.physicalExam.id],
  );
  const changed = await client.query<{ id: string }>(
    `UPDATE appointments
        SET status='RESCHEDULED',is_published=FALSE,updated_by=$2,updated_at=clock_timestamp()
      WHERE id=ANY($1::uuid[]) AND status='PENDING' AND is_published=TRUE
      RETURNING id::text`,
    [movingIds, input.actorUserId],
  );
  if (changed.rowCount !== movingIds.length) {
    throw new AppError(
      "OVPSA_CONCURRENT_APPOINTMENT_CHANGE",
      "A conflicting appointment changed during publication.",
      409,
    );
  }
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id,old_status,new_status,notes,changed_by
     ) SELECT id,'PENDING','RESCHEDULED',
              'Displaced by a First Year OVPSA service reservation.',$2
         FROM UNNEST($1::uuid[]) fixture(id)`,
    [movingIds, input.actorUserId],
  );
  const fallbackMovingIds = input.plannedFallbacks.flatMap((candidate) =>
    candidate.displacementType === "PAIR"
      ? [candidate.laboratory.id, candidate.physicalExam.id]
      : [candidate.physicalExam.id],
  );
  if (fallbackMovingIds.length) {
    const awaiting = await client.query<{ id: string }>(
      `UPDATE appointments
          SET status='AWAITING_RESCHEDULE',updated_by=$2,updated_at=clock_timestamp()
        WHERE id=ANY($1::uuid[]) AND status='PENDING' AND is_published=TRUE
        RETURNING id::text`,
      [fallbackMovingIds, input.actorUserId],
    );
    if (awaiting.rowCount !== fallbackMovingIds.length) {
      throw new AppError(
        "OVPSA_CONCURRENT_APPOINTMENT_CHANGE",
        "A conflicting appointment changed during publication.",
        409,
      );
    }
    await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id,old_status,new_status,notes,changed_by
       ) SELECT id,'PENDING','AWAITING_RESCHEDULE',
                'First Year OVPSA displacement requires Manual Resolution.',$2
           FROM UNNEST($1::uuid[]) fixture(id)`,
      [fallbackMovingIds, input.actorUserId],
    );
  }
  const replacementRows = input.plannedReplacements.flatMap(
    ({ candidate, ...replacement }) => {
      const common = {
        student_number: candidate.studentNumber,
        schedule_pair_id: candidate.schedulePairId,
        schedule_cycle_start: input.batch.scheduleCycleStart,
        batch_id: candidate.physicalExam.batchId,
        category: candidate.category,
        accepted_at: candidate.acceptedAt,
        source_row_order: candidate.sourceRowOrder,
        window_start: candidate.schedulingWindowStart,
        window_end: candidate.schedulingWindowEnd,
      };
      return candidate.displacementType === "PAIR"
        ? [
            {
              ...common,
              clinic_id: candidate.laboratory.clinicId,
              schedule_type: "LABORATORY",
              appointment_date: replacement.laboratoryDate,
              old_id: candidate.laboratory.id,
            },
            {
              ...common,
              clinic_id: candidate.physicalExam.clinicId,
              schedule_type: "PHYSICAL_EXAM",
              appointment_date: replacement.physicalExamDate,
              old_id: candidate.physicalExam.id,
            },
          ]
        : [
            {
              ...common,
              clinic_id: candidate.physicalExam.clinicId,
              schedule_type: "PHYSICAL_EXAM",
              appointment_date: replacement.physicalExamDate,
              old_id: candidate.physicalExam.id,
            },
          ];
    },
  );
  const inserted = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    rescheduled_from: string;
  }>(
    `INSERT INTO appointments (
       batch_id,clinic_id,student_number,schedule_type,appointment_date,status,
       is_published,notes,rescheduled_from,created_by,updated_by,schedule_pair_id,
       schedule_cycle_start,scheduling_category,scheduling_accepted_at,
       scheduling_source_row_order,scheduling_window_start,scheduling_window_end
     )
     SELECT row.batch_id,row.clinic_id,row.student_number,row.schedule_type,row.appointment_date,
            'PENDING',TRUE,'Automatically rescheduled for First Year OVPSA priority.',
            row.old_id,$2,$2,row.schedule_pair_id,row.schedule_cycle_start,row.category,
            row.accepted_at,row.source_row_order,row.window_start,row.window_end
       FROM jsonb_to_recordset($1::jsonb) AS row(
         batch_id uuid,clinic_id uuid,student_number text,schedule_type text,
         appointment_date date,old_id uuid,schedule_pair_id uuid,schedule_cycle_start integer,
         category text,accepted_at timestamptz,source_row_order integer,
         window_start date,window_end date
       )
     RETURNING id::text,student_number,schedule_type,rescheduled_from::text`,
    [JSON.stringify(replacementRows), input.actorUserId],
  );
  await client.query(
    `INSERT INTO appointment_status_logs (
       appointment_id,old_status,new_status,notes,changed_by
     ) SELECT id,NULL,'PENDING','Published OVPSA priority replacement.',$2
         FROM UNNEST($1::uuid[]) fixture(id)`,
    [inserted.rows.map((appointment) => appointment.id), input.actorUserId],
  );
  const newByOld = new Map(
    inserted.rows.map((appointment) => [
      appointment.rescheduled_from,
      appointment.id,
    ]),
  );
  const eventRows = input.plannedReplacements.map(({ candidate }) => ({
    student_number: candidate.studentNumber,
    schedule_pair_id: candidate.schedulePairId,
    schedule_cycle_start: input.batch.scheduleCycleStart,
    old_laboratory_id: candidate.laboratory.id,
    new_laboratory_id:
      candidate.displacementType === "PAIR"
        ? newByOld.get(candidate.laboratory.id)
        : candidate.laboratory.id,
    old_physical_id: candidate.physicalExam.id,
    new_physical_id: newByOld.get(candidate.physicalExam.id),
    reservation_id:
      candidate.displacementType === "PAIR"
        ? input.laboratoryReservationId
        : input.physicalExamReservationIdsByDate?.[candidate.physicalExam.appointmentDate]
          ?? input.physicalExamReservationId,
  }));
  const events = await client.query<{ id: string; student_number: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number,schedule_pair_id,cause,schedule_cycle_start,
       old_laboratory_appointment_id,new_laboratory_appointment_id,
       old_physical_exam_appointment_id,new_physical_exam_appointment_id,
       actor_user_id,ovpsa_batch_id,ovpsa_source_reservation_id,
       ovpsa_target_revision_id
     )
     SELECT row.student_number,row.schedule_pair_id,'OVPSA_PUBLICATION',
            row.schedule_cycle_start,row.old_laboratory_id,row.new_laboratory_id,
            row.old_physical_id,row.new_physical_id,$2,$3,row.reservation_id,$4
       FROM jsonb_to_recordset($1::jsonb) AS row(
         student_number text,schedule_pair_id uuid,schedule_cycle_start integer,
         old_laboratory_id uuid,new_laboratory_id uuid,
         old_physical_id uuid,new_physical_id uuid,reservation_id uuid
       )
     RETURNING id::text,student_number`,
    [
      JSON.stringify(eventRows),
      input.actorUserId,
      input.batch.batchId,
      input.batch.revisionId,
    ],
  );
  const eventByStudent = new Map(
    events.rows.map((event) => [event.student_number, event.id]),
  );
  for (const { candidate } of input.plannedReplacements) {
    await queueAuthoritativeScheduleNotification(
      client,
      candidate.studentNumber,
      (state) => buildPriorityDisplacementNotification({
        state,
        eventId: eventByStudent.get(candidate.studentNumber)!,
        reason: "First Year OVPSA priority scheduling",
        previous: {
          laboratory: {
            date: candidate.laboratory.appointmentDate,
            location: "KABALAKA Clinic",
          },
          physicalExam: {
            date: candidate.physicalExam.appointmentDate,
            location: "CPU Clinic",
          },
        },
      }),
    );
  }
  for (const candidate of input.plannedFallbacks) {
    const displacedAppointmentIds = candidate.displacementType === "PAIR"
      ? [candidate.laboratory.id, candidate.physicalExam.id]
      : [candidate.physicalExam.id];
    const policyMetadata = {
      studentNumber: candidate.studentNumber,
      displacementType: candidate.displacementType,
      originAppointmentIds: [candidate.laboratory.id, candidate.physicalExam.id],
      affectedAppointmentIds: displacedAppointmentIds,
      schedulePairId: candidate.schedulePairId,
      scheduleCycleStart: input.batch.scheduleCycleStart,
      scheduleCycleClosingDate: input.batch.closingDate,
      schedulingCategory: candidate.category,
      schedulingAcceptedAt: candidate.acceptedAt,
      schedulingSourceRowOrder: candidate.sourceRowOrder,
      preferredMonth: candidate.preferredMonth,
      schedulingWindowStart: candidate.schedulingWindowStart,
      schedulingWindowEnd: candidate.schedulingWindowEnd,
      ovpsaBatchId: input.batch.batchId,
      ovpsaRevisionId: input.batch.revisionId,
    };
    const manualCase = await client.query<{ id: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,case_source,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
         reason_code,reason_message,policy_metadata
       ) VALUES ($1,'AUTOMATIC_DISPLACEMENT',NULL,$2,$3,$4,$5,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',$6,$7::jsonb)
       RETURNING id::text`,
      [
        candidate.studentNumber,
        candidate.schedulePairId,
        input.batch.scheduleCycleStart,
        candidate.laboratory.id,
        candidate.physicalExam.id,
        "No valid automatic replacement is available within the current scheduling cycle.",
        JSON.stringify(policyMetadata),
      ],
    );
    await client.query(
      `INSERT INTO appointment_reschedule_events (
         student_number,schedule_pair_id,cause,schedule_cycle_start,
         old_laboratory_appointment_id,old_physical_exam_appointment_id,
         actor_user_id,ovpsa_batch_id,ovpsa_source_reservation_id,
         ovpsa_target_revision_id,strategy,outcome,manual_case_id,
         policy_reason_code,policy_metadata
       ) VALUES ($1,$2,'OVPSA_PUBLICATION',$3,$4,$5,$6,$7,$8,$9,
                 'MANUAL_RESOLUTION_REQUIRED','AWAITING_RESCHEDULE',$10,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',$11::jsonb)`,
      [
        candidate.studentNumber,
        candidate.schedulePairId,
        input.batch.scheduleCycleStart,
        candidate.laboratory.id,
        candidate.physicalExam.id,
        input.actorUserId,
        input.batch.batchId,
        candidate.displacementType === "PAIR"
          ? input.laboratoryReservationId
          : input.physicalExamReservationIdsByDate?.[candidate.conflictingServiceDate]
            ?? input.physicalExamReservationId,
        input.batch.revisionId,
        manualCase.rows[0].id,
        JSON.stringify(policyMetadata),
      ],
    );
    await queueAuthoritativeScheduleNotification(
      client,
      candidate.studentNumber,
      (state) => buildAwaitingResolutionNotification({
        state,
        eventId: manualCase.rows[0].id,
        sourceType: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE",
        reason: "No valid automatic replacement is available within the current scheduling cycle.",
        previous: {
          laboratory: {
            date: candidate.laboratory.appointmentDate,
            location: "KABALAKA Clinic",
          },
          physicalExam: {
            date: candidate.physicalExam.appointmentDate,
            location: "CPU Clinic",
          },
        },
      }),
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'OVPSA_DISPLACEMENT_MANUAL_RESOLUTION_REQUIRED',
               'clinic_closure_manual_case',$2,$3::jsonb)`,
      [input.actorUserId, manualCase.rows[0].id, JSON.stringify(policyMetadata)],
    );
  }
  return {
    displacedCount: input.plannedReplacements.length + input.plannedFallbacks.length,
    automaticReplacementCount: input.plannedReplacements.length,
    manualResolutionCount: input.plannedFallbacks.length,
  };
}
