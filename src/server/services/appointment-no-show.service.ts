import { serverEnv } from "@/lib/env";
import {
  getNextNoShowSweepAt,
  markOverdueAppointmentsNoShow,
} from "@/server/repositories/appointment-no-show.repository";

export function sweepOverdueAppointments(now = new Date()) {
  return markOverdueAppointmentsNoShow(now, serverEnv().APP_TIMEZONE);
}

export function nextNoShowSweepAt(now = new Date()) {
  return getNextNoShowSweepAt(now, serverEnv().APP_TIMEZONE);
}
