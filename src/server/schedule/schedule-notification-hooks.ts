import "server-only";
import type { PoolClient } from "pg";
import { loadAuthoritativeScheduleState } from "@/server/repositories/schedule-state.repository";
import type { StudentNotificationInput } from "@/server/repositories/student-notifications.repository";
import type { AuthoritativeScheduleState } from "@/server/schedule/schedule-notifications";
import { createStudentNotificationIsolated } from "@/server/services/student-notifications.service";

export async function queueAuthoritativeScheduleNotification(
  client: PoolClient,
  studentNumber: string,
  build: (state: AuthoritativeScheduleState) => StudentNotificationInput,
) {
  const state = await loadAuthoritativeScheduleState(client, studentNumber);
  if (!state) return { id: null, warnings: [] };
  return createStudentNotificationIsolated(client, build(state));
}
