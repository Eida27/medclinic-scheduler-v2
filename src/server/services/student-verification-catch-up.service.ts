import "server-only";
import type { PoolClient } from "pg";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import {
  buildCurrentStateNotification,
  hasAuthoritativeScheduleState,
} from "@/server/schedule/schedule-notifications";
import { createStudentNotificationIsolated } from "./student-notifications.service";

export async function queueFirstVerificationCurrentStateCatchUp(
  client: PoolClient,
  studentNumber: string,
) {
  const state = await loadAuthoritativeScheduleState(client, studentNumber);
  if (!state || !hasAuthoritativeScheduleState(state)) return undefined;
  return createStudentNotificationIsolated(client, buildCurrentStateNotification(state));
}
