import { serverEnv } from "@/lib/env";
import { markOverdueAppointmentsNoShow } from "@/server/repositories/appointment-no-show.repository";

export function sweepOverdueAppointments(now = new Date()) {
  return markOverdueAppointmentsNoShow(now, serverEnv().APP_TIMEZONE);
}
