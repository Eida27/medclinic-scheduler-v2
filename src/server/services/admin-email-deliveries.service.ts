import "server-only";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  listAdminEmailDeliveryRows,
  lockAdminEmailDeliveryRow,
  mapAdminEmailDeliveryRow,
  obsoleteAdminEmailDeliveryFailure,
  resetAdminEmailDeliveryFailure,
  type EmailDeliveryState,
} from "@/server/repositories/admin-email-deliveries.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import { insertStudentNotifications } from "@/server/repositories/student-notifications.repository";
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

export async function retryAdminEmailDelivery(id: string, actorUserId: string) {
  return transaction(async (client) => {
    const row = await lockAdminEmailDeliveryRow(client, id);
    if (!row) throw new AppError("EMAIL_DELIVERY_NOT_FOUND", "Email delivery not found.", 404);
    if (row.status !== "PERMANENT_FAILURE") {
      if (row.messageKind === "VERIFICATION") throw retryRejectedForVerification();
      throw new AppError(
        "EMAIL_DELIVERY_NOT_RETRYABLE",
        "Only current permanent delivery failures can be retried.",
        409,
      );
    }

    if (row.messageKind === "VERIFICATION") {
      if (!row.verificationRetryEligible) throw retryRejectedForVerification();
    } else {
      if (!row.studentNumber) {
        throw new AppError("STALE_SCHEDULE_EMAIL", "This schedule email is no longer current.", 409, undefined, {
          guidance: "Queue the student's current schedule instead.",
          currentState: null,
        });
      }
      const state = await loadAuthoritativeScheduleState(client, row.studentNumber);
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
    const row = await lockAdminEmailDeliveryRow(client, id);
    if (!row) throw new AppError("EMAIL_DELIVERY_NOT_FOUND", "Email delivery not found.", 404);
    if (
      row.messageKind !== "SCHEDULE"
      || !row.studentNumber
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
