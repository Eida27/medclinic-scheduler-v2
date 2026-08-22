import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  listAdminEmailDeliveryRows,
  lockAdminEmailDeliveryStudent,
  lockAdminEmailVerificationRequest,
  lockAdminEmailDeliveryRow,
  lockAdminScheduleStateRows,
  mapAdminEmailDeliveryRow,
  obsoleteAdminEmailDeliveryFailure,
  readAdminEmailDeliveryIdentity,
  resetAdminEmailDeliveryFailure,
  type EmailDeliveryState,
} from "@/server/repositories/admin-email-deliveries.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import { insertStudentNotifications } from "@/server/repositories/student-notifications.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import {
  buildCurrentStateNotification,
  fingerprintScheduleState,
  type AuthoritativeScheduleState,
} from "@/server/schedule/schedule-notifications";

const NEW_VERIFICATION_GUIDANCE = "Ask the student to request a new verification link.";

export type AdminEmailDeliveryFilters = {
  scope?: "actionable" | "history";
  state?: EmailDeliveryState;
};

export async function listAdminEmailDeliveries(filters: AdminEmailDeliveryFilters) {
  const scope = filters.scope ?? "actionable";
  const rows = await listAdminEmailDeliveryRows({ scope, state: filters.state });
  return { scope, items: rows.map(mapAdminEmailDeliveryRow) };
}

function safeCurrentState(state: AuthoritativeScheduleState | null) {
  if (!state) return null;
  const appointment = (value: AuthoritativeScheduleState["laboratory"]) => value
    ? {
        scheduleType: value.scheduleType,
        status: value.status,
        date: value.date,
        affectedDate: value.affectedDate,
        location: value.location,
      }
    : null;
  return {
    studentNumber: state.studentNumber,
    laboratory: appointment(state.laboratory),
    physicalExam: appointment(state.physicalExam),
    manualResolutionOpen: state.openManualResolutionIds.length > 0,
  };
}

function retryRejectedForVerification() {
  return new AppError(
    "EMAIL_VERIFICATION_RETRY_REJECTED",
    "This verification email is expired or superseded.",
    409,
    undefined,
    { guidance: NEW_VERIFICATION_GUIDANCE },
  );
}

function normalizeDestination(value: string) {
  return value.trim().toLowerCase();
}

async function lockDeliveryMutationContext(client: PoolClient, id: string) {
  const identity = await readAdminEmailDeliveryIdentity(client, id);
  if (!identity) throw new AppError("EMAIL_DELIVERY_NOT_FOUND", "Email delivery not found.", 404);

  let verifiedEmail: string | null = null;
  let verificationRetryEligible = false;
  if (identity.messageKind === "SCHEDULE" && identity.studentNumber) {
    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: identity.studentNumber, scheduleType: "LABORATORY" },
      { studentNumber: identity.studentNumber, scheduleType: "PHYSICAL_EXAM" },
    ]);
    const student = await lockAdminEmailDeliveryStudent(client, identity.studentNumber, "NO KEY UPDATE");
    verifiedEmail = student?.verifiedEmail ?? null;
    await lockAdminScheduleStateRows(client, identity.studentNumber);
  } else if (identity.messageKind === "VERIFICATION" && identity.studentNumber) {
    const student = await lockAdminEmailDeliveryStudent(client, identity.studentNumber, "UPDATE");
    const verification = await lockAdminEmailVerificationRequest(client, identity.sourceId);
    verificationRetryEligible = Boolean(student?.isActive && verification?.retryEligible);
  }

  const row = await lockAdminEmailDeliveryRow(client, id);
  if (!row) throw new AppError("EMAIL_DELIVERY_NOT_FOUND", "Email delivery not found.", 404);
  return { row, verifiedEmail, verificationRetryEligible };
}

export async function retryAdminEmailDelivery(id: string, actorUserId: string) {
  return transaction(async (client) => {
    const { row, verifiedEmail, verificationRetryEligible } = await lockDeliveryMutationContext(client, id);
    if (row.status !== "PERMANENT_FAILURE") {
      if (row.messageKind === "VERIFICATION") throw retryRejectedForVerification();
      throw new AppError(
        "EMAIL_DELIVERY_NOT_RETRYABLE",
        "Only current permanent delivery failures can be retried.",
        409,
      );
    }

    if (row.messageKind === "VERIFICATION") {
      if (!verificationRetryEligible) throw retryRejectedForVerification();
    } else {
      if (!row.studentNumber) {
        throw new AppError("STALE_SCHEDULE_EMAIL", "This schedule email is no longer current.", 409, undefined, {
          guidance: "Queue the student's current schedule instead.",
          currentState: null,
        });
      }
      const state = await loadAuthoritativeScheduleState(client, row.studentNumber);
      if (verifiedEmail !== normalizeDestination(row.toEmail)) {
        throw new AppError("STALE_SCHEDULE_EMAIL", "This schedule email targets a former address.", 409, undefined, {
          reason: "VERIFIED_ADDRESS_CHANGED",
          guidance: "Queue the student's current schedule to the verified address instead.",
          currentState: safeCurrentState(state),
        });
      }
      if (!state || row.scheduleFingerprint !== fingerprintScheduleState(state)) {
        throw new AppError("STALE_SCHEDULE_EMAIL", "This schedule email is no longer current.", 409, undefined, {
          guidance: "Queue the student's current schedule instead.",
          currentState: safeCurrentState(state),
        });
      }
    }

    const reset = await resetAdminEmailDeliveryFailure(client, id);
    if (!reset) {
      throw new AppError(
        "EMAIL_DELIVERY_NOT_RETRYABLE",
        "Only current permanent delivery failures can be retried.",
        409,
      );
    }
    await writeAudit(
      actorUserId,
      "EMAIL_DELIVERY_ADMIN_RETRY_QUEUED",
      "email_outbox",
      row.id,
      {
        studentNumber: row.studentNumber,
        messageKind: row.messageKind,
        notificationType: row.notificationType,
        previousAttempts: row.attempts,
      },
      client,
    );
    return mapAdminEmailDeliveryRow(reset);
  });
}

export async function queueCurrentAdminEmailDelivery(id: string, actorUserId: string) {
  return transaction(async (client) => {
    const { row, verifiedEmail } = await lockDeliveryMutationContext(client, id);
    if (
      row.messageKind !== "SCHEDULE"
      || !row.studentNumber
      || !verifiedEmail
      || (row.status !== "PERMANENT_FAILURE" && row.status !== "OBSOLETE")
    ) {
      throw new AppError(
        "EMAIL_DELIVERY_CURRENT_STATE_NOT_AVAILABLE",
        "Current-state queueing is available only for student schedule emails.",
        409,
      );
    }
    const state = await loadAuthoritativeScheduleState(client, row.studentNumber);
    if (!state) {
      throw new AppError(
        "EMAIL_DELIVERY_CURRENT_STATE_NOT_AVAILABLE",
        "No current schedule state is available for this student.",
        409,
      );
    }
    const insertedIds = await insertStudentNotifications(client, [buildCurrentStateNotification(state)]);
    await obsoleteAdminEmailDeliveryFailure(client, id);
    await writeAudit(
      actorUserId,
      "EMAIL_DELIVERY_ADMIN_CURRENT_STATE_QUEUED",
      "email_outbox",
      id,
      {
        studentNumber: row.studentNumber,
        queued: insertedIds.length > 0,
      },
      client,
    );
    return {
      queued: insertedIds.length > 0,
      currentState: safeCurrentState(state),
    };
  });
}
