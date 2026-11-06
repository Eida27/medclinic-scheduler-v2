import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  createClosureGroupWithDates,
  listActiveClinicUnavailableDateRecords,
  listActiveUnavailableDatesWithClient,
  listUnifiedBlockedDateSet,
  lockActiveUnavailableDates,
  lockAllActiveUnavailableDates,
  reopenUnavailableDate,
} from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarBlockChange,
  ClinicCalendarChange,
  ClinicCalendarOperationRequest,
  ClinicCalendarOperationResult,
  ClinicCalendarPreviewResult,
  ClinicClosureRecoveryMode,
  ClinicManualCaseReason,
} from "@/types/clinic-calendar";
import type { SessionUser } from "@/types/roles";
import {
  ClinicCalendarPlanningError,
  groupContiguousClosureChanges,
  isClinicSchedulingWeekday,
  normalizeClosureReason,
  type ReplacementCapacity,
} from "./clinic-calendar-planner";
import { loadSchedulingBlockedDates } from "@/server/repositories/scheduling-blocked-dates.repository";
import {
  sortRecoveryCycles,
  loadAffectedCycles,
  loadRecoveryBounds,
  applicableGroups,
  evaluateCycleRecovery,
  addReasonCount,
  allocateCycleRecovery,
  movedAppointmentCount,
  reasonGroups,
  type PersistedGroup,
  markOvpsaLaboratoryClosure,
  createManualFallback,
  applyAutomaticMove,
} from "./clinic-calendar/closure-recovery";
import {
  validationError,
  manilaToday,
  assertAdmin,
  loadCapacity,
} from "./clinic-calendar/recovery-shared";

const categorySchema = z.enum([
  "HOLIDAY",
  "CLOSURE",
  "EMERGENCY_CLOSURE",
  "MAINTENANCE",
  "STAFF_UNAVAILABILITY",
]);
const blockSchema = z.object({
  action: z.literal("BLOCK"),
  date: z.iso.date(),
  category: categorySchema,
  reason: z.string().trim().min(3).max(500),
}).strict();
const reopenSchema = z.object({
  action: z.literal("REOPEN"),
  date: z.iso.date(),
  unavailableDateId: z.string().uuid(),
  expectedUpdatedAt: z.string().trim().min(1).max(64),
}).strict();
const recoveryModeSchema = z.enum(["AUTO_ELIGIBLE", "MANUAL_ALL"]);
const requestShape = {
  requestId: z.string().uuid(),
  changes: z.array(z.discriminatedUnion("action", [blockSchema, reopenSchema])).min(1).max(366),
  emergencyAcknowledged: z.boolean(),
};
const previewRequestSchema = z.object(requestShape).strict();
const requestSchema = z.object({
  ...requestShape,
  recoveryMode: recoveryModeSchema,
}).strict();

type ParsedCalendarRequest = Omit<ClinicCalendarOperationRequest, "recoveryMode"> & {
  recoveryMode?: ClinicClosureRecoveryMode;
};

function assertCalendarReader(actor: SessionUser) {
  if (actor.role !== "ADMIN" && actor.role !== "CLINIC_STAFF") {
    throw new AppError("FORBIDDEN", "You do not have permission to view the clinic calendar.", 403);
  }
}

function parseRequest(
  raw: unknown,
  options: {
    requireEmergencyAcknowledgement?: boolean;
    requireRecoveryMode?: boolean;
  } = {},
): ParsedCalendarRequest {
  const parsed = (
    options.requireRecoveryMode === false ? previewRequestSchema : requestSchema
  ).safeParse(raw);
  if (!parsed.success) throw validationError("Please correct the clinic calendar request.", parsed.error.flatten());
  const request = parsed.data as ParsedCalendarRequest;
  const today = manilaToday();
  const seen = new Set<string>();
  for (const change of request.changes) {
    if (seen.has(change.date)) throw validationError("Only one change is allowed for each date.");
    seen.add(change.date);
    if (Number(change.date.slice(0, 4)) > 2100) {
      throw validationError("Calendar dates may not be later than 2100.");
    }
    if (change.date < today) throw validationError("Past dates cannot be edited.");
    if (change.action === "BLOCK") {
      if (!isClinicSchedulingWeekday(change.date)) throw validationError("Weekends cannot be blocked.");
      if (change.date === today && change.category !== "EMERGENCY_CLOSURE") {
        throw validationError("Today may be blocked only as an Emergency Closure.");
      }
      if (
        change.date === today
        && options.requireEmergencyAcknowledgement !== false
        && !request.emergencyAcknowledged
      ) {
        throw new AppError(
          "EMERGENCY_ACKNOWLEDGMENT_REQUIRED",
          "A same-day emergency closure requires explicit acknowledgment.",
          422,
        );
      }
      change.reason = normalizeClosureReason(change.reason);
    }
  }
  return request;
}

function payloadHash(request: ParsedCalendarRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

async function validateCalendarState(
  activeDates: Awaited<ReturnType<typeof lockAllActiveUnavailableDates>>,
  changes: ClinicCalendarChange[],
) {
  const activeByDate = new Map(activeDates.map((date) => [date.blockedDate, date]));
  const activeById = new Map(activeDates.map((date) => [date.id, date]));
  for (const change of changes) {
    if (change.action === "BLOCK" && activeByDate.has(change.date)) {
      throw new AppError("CLINIC_CALENDAR_CONFLICT", `${change.date} is already blocked.`, 409);
    }
    if (change.action === "REOPEN") {
      const active = activeById.get(change.unavailableDateId);
      if (!active || active.blockedDate !== change.date || active.updatedAt !== change.expectedUpdatedAt) {
        throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload before reopening this date.", 409);
      }
    }
  }
}

export async function listClinicUnavailableDates(actor: SessionUser) {
  assertCalendarReader(actor);
  return listActiveClinicUnavailableDateRecords();
}

export async function previewClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarPreviewResult> {
  assertAdmin(actor);
  const request = parseRequest(raw, {
    requireEmergencyAcknowledgement: false,
    requireRecoveryMode: false,
  });
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const active = await listActiveUnavailableDatesWithClient(client);
    await validateCalendarState(active, request.changes);
    const blockChanges = request.changes.filter((change): change is ClinicCalendarBlockChange => change.action === "BLOCK");
    const groups = groupContiguousClosureChanges(blockChanges);
    const cycles = sortRecoveryCycles(
      await loadAffectedCycles(client, blockChanges.map((change) => change.date), false),
      groups,
    );
    const reopenChanges = request.changes.filter((change) => change.action === "REOPEN");
    const blockedDates = await listUnifiedBlockedDateSet(client);
    for (const change of reopenChanges) blockedDates.delete(change.date);
    for (const change of blockChanges) blockedDates.add(change.date);
    const recoveryBounds = await loadRecoveryBounds(client, cycles);
    const serviceBlockedDates = await loadSchedulingBlockedDates(client, {
      // Simulate global reopenings without removing independent service reservations.
      excludeUnavailableDateIds: reopenChanges.map((change) => change.unavailableDateId),
      startDate: manilaToday(),
      endDate: [manilaToday(), ...[...recoveryBounds.values()].flatMap((bounds) => bounds ? [bounds.cycleClosingDate] : [])].sort().at(-1)!,
    });
    const { capacity, usedCapacity: initialCapacity } = await loadCapacity(client);
    let usedCapacity = initialCapacity;
    let automaticRecoveryEligibleCount = 0;
    let manualResolutionRequiredCount = 0;
    let completePairMoveEstimate = 0;
    let laboratoryOnlyMoveEstimate = 0;
    let physicalOnlyMoveEstimate = 0;
    let preservedAppointmentCount = 0;
    let expectedCapacityFallbackCount = 0;
    const reasonCounts = new Map<ClinicManualCaseReason, number>();
    for (const cycle of cycles) {
      const cycleGroups = applicableGroups(cycle, groups);
      if (!cycleGroups.length) continue;
      const policy = evaluateCycleRecovery({
        cycle,
        groups: cycleGroups,
        recoveryMode: "AUTO_ELIGIBLE",
        policyEffectiveDate: manilaToday(),
      });
      if (policy.decision === "MANUAL_RESOLUTION_REQUIRED") {
        manualResolutionRequiredCount += 1;
        addReasonCount(reasonCounts, policy.reasonCode!);
        preservedAppointmentCount += cycle.appointments.filter((appointment) =>
          !policy.affectedAppointmentIds.has(appointment.id)
          || appointment.status === "COMPLETED").length;
        continue;
      }
      try {
        const planned = allocateCycleRecovery({
          cycle,
          bounds: recoveryBounds.get(cycle.scheduleCycleStart) ?? null,
          affectedAppointmentIds: policy.affectedAppointmentIds,
          afterDate: cycleGroups.reduce(
            (latest, group) => group.endDate > latest ? group.endDate : latest,
            cycleGroups[0].endDate,
          ),
          blockedDates,
          blockedDatesByService: {
            LABORATORY: new Set(serviceBlockedDates.laboratoryDates),
            PHYSICAL_EXAM: new Set(serviceBlockedDates.physicalExamDates),
          },
          usedCapacity,
          capacity,
        });
        if (planned.classification.strategy === "PRESERVE_COMPLETION") {
          preservedAppointmentCount += cycle.appointments.length;
          automaticRecoveryEligibleCount += 1;
          continue;
        }
        if (planned.classification.strategy === "MANUAL_RESOLUTION_REQUIRED") {
          manualResolutionRequiredCount += 1;
          addReasonCount(reasonCounts, planned.classification.reasonCode);
          continue;
        }
        automaticRecoveryEligibleCount += 1;
        if (planned.classification.strategy === "MOVE_COMPLETE_PAIR") completePairMoveEstimate += 1;
        if (planned.classification.strategy === "MOVE_LABORATORY_ONLY") laboratoryOnlyMoveEstimate += 1;
        if (planned.classification.strategy === "MOVE_PHYSICAL_ONLY") physicalOnlyMoveEstimate += 1;
        preservedAppointmentCount += cycle.appointments.length
          - movedAppointmentCount(planned.classification);
        usedCapacity = planned.usedCapacity;
      } catch (error) {
        if (!(error instanceof ClinicCalendarPlanningError)) throw error;
        expectedCapacityFallbackCount += 1;
        manualResolutionRequiredCount += 1;
        addReasonCount(reasonCounts, error.reasonCode);
        preservedAppointmentCount += cycle.appointments.filter((appointment) =>
          !policy.affectedAppointmentIds.has(appointment.id)
          || appointment.status === "COMPLETED").length;
      }
    }
    return {
      requestId: request.requestId,
      closureGroups: groups,
      datesBeingReopened: request.changes.filter((change) => change.action === "REOPEN").map((change) => change.date),
      affectedStudentCount: new Set(cycles.map((cycle) => cycle.studentNumber)).size,
      automaticRecoveryEligibleCount,
      manualResolutionRequiredCount,
      completePairMoveEstimate,
      laboratoryOnlyMoveEstimate,
      physicalOnlyMoveEstimate,
      preservedAppointmentCount,
      expectedCapacityFallbackCount,
      manualReasonGroups: reasonGroups(reasonCounts),
    };
  });
}

export async function saveClinicCalendarChanges(
  raw: unknown,
  actor: SessionUser,
): Promise<ClinicCalendarOperationResult> {
  assertAdmin(actor);
  const request = parseRequest(raw, { requireRecoveryMode: true });
  if (!request.recoveryMode) throw validationError("Choose a closure recovery mode.");
  const recoveryMode = request.recoveryMode;
  const hash = payloadHash(request);
  try {
    return await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      const prior = await client.query<{ payload_hash: string; result: ClinicCalendarOperationResult }>(
        "SELECT payload_hash,result FROM clinic_calendar_requests WHERE request_id=$1 FOR UPDATE",
        [request.requestId],
      );
      if (prior.rowCount) {
        if (prior.rows[0].payload_hash !== hash) {
          throw new AppError(
            "CLINIC_CALENDAR_REQUEST_CONFLICT",
            "This request ID was already used with a different payload.",
            409,
          );
        }
        return prior.rows[0].result;
      }

      const active = await lockAllActiveUnavailableDates(client);
      await validateCalendarState(active, request.changes);
      const batchId = randomUUID();
      const blockChanges = request.changes.filter((change): change is ClinicCalendarBlockChange => change.action === "BLOCK");
      const groups = groupContiguousClosureChanges(blockChanges);
      const persistedGroups: PersistedGroup[] = [];
      for (const group of groups) {
        const inserted = await createClosureGroupWithDates(
          client,
          group,
          actor.userId,
          batchId,
          recoveryMode,
          manilaToday(),
        );
        persistedGroups.push({
          ...group,
          closureGroupId: inserted.closureGroupId,
          dateIds: inserted.dates,
        });
      }

      const reopenChanges = request.changes.filter((change) => change.action === "REOPEN");
      const lockedReopenings = await lockActiveUnavailableDates(
        client,
        reopenChanges.map((change) => change.unavailableDateId),
      );
      if (lockedReopenings.length !== reopenChanges.length) {
        throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload and try again.", 409);
      }
      for (const change of reopenChanges) {
        const reopened = await reopenUnavailableDate(client, {
          id: change.unavailableDateId,
          expectedUpdatedAt: change.expectedUpdatedAt,
          actorUserId: actor.userId,
          batchId,
        });
        if (!reopened) throw new AppError("CLINIC_CALENDAR_STALE_REOPEN", "The calendar changed. Reload and try again.", 409);
      }

      const cycles = sortRecoveryCycles(
        await loadAffectedCycles(client, blockChanges.map((change) => change.date), true),
        persistedGroups,
      );
      const blockedDates = await listUnifiedBlockedDateSet(client);
      const recoveryBounds = await loadRecoveryBounds(client, cycles);
      const serviceBlockedDates = await loadSchedulingBlockedDates(client, {
        startDate: manilaToday(),
        endDate: [manilaToday(), ...[...recoveryBounds.values()].flatMap((bounds) => bounds ? [bounds.cycleClosingDate] : [])].sort().at(-1)!,
      });
      const { capacity, usedCapacity: initialCapacity } = await loadCapacity(client);
      let usedCapacity = initialCapacity;
      const clinicRows = await client.query<{ id: string; code: keyof ReplacementCapacity }>(
        `SELECT id::text,CASE code
           WHEN 'KABALAKA_CLINIC' THEN 'LABORATORY'
           WHEN 'CPU_CLINIC' THEN 'PHYSICAL_EXAM'
         END AS code
           FROM clinics WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
      );
      const clinicIds = Object.fromEntries(clinicRows.rows.map((row) => [row.code, row.id])) as {
        LABORATORY: string;
        PHYSICAL_EXAM: string;
      };
      let movedStudentCount = 0;
      let movedAppointmentCount = 0;
      let preservedAppointmentCount = 0;
      let manualCaseCount = 0;
      let capacityFallbackCount = 0;
      let notificationWarningCount = 0;
      const manualReasonCounts = new Map<ClinicManualCaseReason, number>();
      const ovpsaPhysicalReservationsToRelease = new Set<string>();
      for (const [index, cycle] of cycles.entries()) {
        const cycleGroups = applicableGroups(cycle, persistedGroups) as PersistedGroup[];
        if (!cycleGroups.length) continue;
        const policy = evaluateCycleRecovery({
          cycle,
          groups: cycleGroups,
          recoveryMode,
          policyEffectiveDate: manilaToday(),
        });
        const group = policy.group as PersistedGroup;
        const affectsOvpsaLaboratory = cycle.appointments.some((appointment) =>
          appointment.scheduleType === "LABORATORY"
          && appointment.ovpsaBatchId
          && policy.affectedAppointmentIds.has(appointment.id));
        if (!affectsOvpsaLaboratory) {
          for (const appointment of cycle.appointments) {
            if (
              appointment.scheduleType === "PHYSICAL_EXAM"
              && appointment.ovpsaServiceReservationId
              && policy.affectedAppointmentIds.has(appointment.id)
            ) {
              ovpsaPhysicalReservationsToRelease.add(appointment.ovpsaServiceReservationId);
            }
          }
        }
        const unavailableDateIds = [...new Set(cycleGroups.flatMap((item) => item.dateIds.map((date) => date.id)))];
        const policyMetadata = { ...policy.policyMetadata, recoveryQueuePosition: index + 1 };
        const savepoint = `clinic_student_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          if (policy.decision === "MANUAL_RESOLUTION_REQUIRED") {
            if (policy.reasonCode === "OVPSA_LABORATORY_PROTECTED") {
              await markOvpsaLaboratoryClosure(client, {
                cycle,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                closureGroupId: group.closureGroupId,
                actorUserId: actor.userId,
              });
            }
            const manual = await createManualFallback(client, {
              cycle,
              reasonCode: policy.reasonCode!,
              reasonMessage: policy.reasonMessage!,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
              affectedAppointmentIds: policy.affectedAppointmentIds,
              policyMetadata,
            });
            manualCaseCount += 1;
            notificationWarningCount += manual.notificationWarningCount;
            addReasonCount(manualReasonCounts, policy.reasonCode!);
            preservedAppointmentCount += cycle.appointments.filter((appointment) =>
              !policy.affectedAppointmentIds.has(appointment.id)
              || appointment.status === "COMPLETED").length;
          } else {
            let planned: ReturnType<typeof allocateCycleRecovery>;
            try {
              planned = allocateCycleRecovery({
                cycle,
                bounds: recoveryBounds.get(cycle.scheduleCycleStart) ?? null,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                afterDate: cycleGroups.reduce(
                  (latest, item) => item.endDate > latest ? item.endDate : latest,
                  cycleGroups[0].endDate,
                ),
                blockedDates,
                blockedDatesByService: {
                  LABORATORY: new Set(serviceBlockedDates.laboratoryDates),
                  PHYSICAL_EXAM: new Set(serviceBlockedDates.physicalExamDates),
                },
                usedCapacity,
                capacity,
              });
            } catch (error) {
              if (!(error instanceof ClinicCalendarPlanningError)) throw error;
              const manual = await createManualFallback(client, {
                cycle,
                reasonCode: error.reasonCode,
                reasonMessage: error.message,
                group,
                unavailableDateIds,
                batchId,
                actorUserId: actor.userId,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                policyMetadata: { ...policyMetadata, fallbackReasonCode: error.reasonCode },
              });
              manualCaseCount += 1;
              capacityFallbackCount += ["NO_REPLACEMENT_CAPACITY", "NO_VALID_REPLACEMENT_WITHIN_CYCLE"].includes(error.reasonCode) ? 1 : 0;
              notificationWarningCount += manual.notificationWarningCount;
              addReasonCount(manualReasonCounts, error.reasonCode);
              preservedAppointmentCount += cycle.appointments.filter((appointment) =>
                !policy.affectedAppointmentIds.has(appointment.id)
                || appointment.status === "COMPLETED").length;
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            if (planned.classification.strategy === "PRESERVE_COMPLETION") {
              preservedAppointmentCount += cycle.appointments.length;
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            if (planned.classification.strategy === "MANUAL_RESOLUTION_REQUIRED") {
              const manual = await createManualFallback(client, {
                cycle,
                reasonCode: planned.classification.reasonCode,
                reasonMessage: planned.classification.reasonMessage,
                group,
                unavailableDateIds,
                batchId,
                actorUserId: actor.userId,
                affectedAppointmentIds: policy.affectedAppointmentIds,
                policyMetadata,
              });
              manualCaseCount += 1;
              notificationWarningCount += manual.notificationWarningCount;
              addReasonCount(manualReasonCounts, planned.classification.reasonCode);
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              continue;
            }
            const moved = await applyAutomaticMove(client, {
              cycle,
              classification: planned.classification,
              dates: planned.dates,
              group,
              unavailableDateIds,
              batchId,
              actorUserId: actor.userId,
              clinicIds,
              policyMetadata,
            });
            usedCapacity = planned.usedCapacity;
            movedStudentCount += 1;
            movedAppointmentCount += moved.movedAppointmentCount;
            notificationWarningCount += moved.notificationWarningCount;
            preservedAppointmentCount += cycle.appointments.length
              - moved.movedAppointmentCount;
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          if (!(error instanceof ClinicCalendarPlanningError)) throw error;
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          const manual = await createManualFallback(client, {
            cycle,
            reasonCode: error.reasonCode,
            reasonMessage: error.message,
            group,
            unavailableDateIds,
            batchId,
            actorUserId: actor.userId,
            affectedAppointmentIds: policy.affectedAppointmentIds,
            policyMetadata: { ...policyMetadata, fallbackReasonCode: error.reasonCode },
          });
          manualCaseCount += 1;
          capacityFallbackCount += ["NO_REPLACEMENT_CAPACITY", "NO_VALID_REPLACEMENT_WITHIN_CYCLE"].includes(error.reasonCode) ? 1 : 0;
          notificationWarningCount += manual.notificationWarningCount;
          addReasonCount(manualReasonCounts, error.reasonCode);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      }

      if (ovpsaPhysicalReservationsToRelease.size) {
        await client.query(
          `UPDATE ovpsa_first_year_service_reservations reservation
              SET status='RELEASED',released_at=clock_timestamp(),released_by=$2,
                  release_reason='Clinic closure recovery moved the assigned Physical Examination.'
            WHERE reservation.id=ANY($1::uuid[]) AND reservation.status IN ('ACTIVE','INVALIDATED')
              AND NOT EXISTS (
                SELECT 1 FROM appointments preserved
                 WHERE preserved.ovpsa_service_reservation_id=reservation.id
                   AND preserved.is_published=TRUE
                   AND preserved.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
              )`,
          [[...ovpsaPhysicalReservationsToRelease], actor.userId],
        );
      }

      const result: ClinicCalendarOperationResult = {
        requestId: request.requestId,
        batchId,
        activeUnavailableDates: await listActiveUnavailableDatesWithClient(client),
        blockedDateCount: blockChanges.length,
        reopenedDateCount: reopenChanges.length,
        autoRecoveredStudentCount: movedStudentCount,
        movedStudentCount,
        movedAppointmentCount,
        preservedAppointmentCount,
        manualCaseCount,
        capacityFallbackCount,
        manualReasonGroups: reasonGroups(manualReasonCounts),
        notificationWarningCount,
      };
      await client.query(
        `INSERT INTO clinic_calendar_requests (
           request_id,payload_hash,batch_id,result,created_by
         ) VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [request.requestId, hash, batchId, JSON.stringify(result), actor.userId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         VALUES ($1,'UNIFIED_CLINIC_CALENDAR_UPDATED','clinic_calendar_request',$2::text,
                 jsonb_build_object(
                   'requestId',$2::text,'batchId',$3::text,'blockedDateCount',$4::int,
                   'reopenedDateCount',$5::int,'movedStudentCount',$6::int,
                   'movedAppointmentCount',$7::int,'preservedAppointmentCount',$8::int,
                   'manualCaseCount',$9::int,'capacityFallbackCount',$10::int,
                   'notificationWarningCount',$11::int,'emergencyAcknowledged',$12::boolean,
                   'recoveryMode',$13::text,'manualReasonGroups',$14::jsonb
                 ))`,
        [
          actor.userId,
          request.requestId,
          batchId,
          result.blockedDateCount,
          result.reopenedDateCount,
          result.movedStudentCount,
          result.movedAppointmentCount,
          result.preservedAppointmentCount,
          result.manualCaseCount,
          result.capacityFallbackCount,
          result.notificationWarningCount,
          request.emergencyAcknowledged,
          recoveryMode,
          JSON.stringify(result.manualReasonGroups),
        ],
      );
      return result;
    });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "constraint" in error
      && error.constraint === "clinic_unavailable_dates_one_active_day_idx"
    ) {
      throw new AppError("CLINIC_CALENDAR_CONFLICT", "A selected date was blocked concurrently.", 409);
    }
    throw error;
  }
}

export {
  type AppointmentState,
  currentAssignmentBlock,
  listClinicClosureManualCases,
  loadAppointmentStates,
  assertAutomaticManualDateAvailable,
  resolveClinicClosureManualCase,
  resolveClinicClosureManualCaseWithClient,
} from "./clinic-calendar/manual-resolution";
export {
  previewOvpsaClinicClosureBatchRecovery,
  confirmOvpsaClinicClosureBatchRecovery,
} from "./clinic-calendar/ovpsa-recovery";
