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
  const notification = buildCurrentStateNotification(state);
  const result = await createStudentNotificationIsolated(client, notification);
  for (const warning of result.warnings) {
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES (
         NULL,'STUDENT_SCHEDULE_CATCH_UP_NOTIFICATION_WARNING','student',$1,
         jsonb_build_object(
           'studentNumber',$1::text,
           'channel',$2::text,
           'scheduleFingerprint',$3::text
         )
       )`,
      [studentNumber, warning.channel, notification.scheduleFingerprint],
    );
  }
  return result;
}
