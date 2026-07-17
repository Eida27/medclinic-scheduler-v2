import {
  nextNoShowSweepAt,
  sweepOverdueAppointments,
} from "@/server/services/appointment-no-show.service";

export const APPOINTMENT_NO_SHOW_RETRY_MS = 5 * 60 * 1000;

type WorkerDependencies = {
  sweep?: (now?: Date) => Promise<unknown>;
  nextRunAt?: (now?: Date) => Promise<Date>;
  now?: () => Date;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => { unref?: () => void };
  reportError?: (message: string, error: unknown) => void;
};

declare global {
  var __medclinicAppointmentNoShowWorkerStarted: boolean | undefined;
}

export function startAppointmentNoShowWorker(
  dependencies: WorkerDependencies = {},
) {
  if (globalThis.__medclinicAppointmentNoShowWorkerStarted) return false;
  globalThis.__medclinicAppointmentNoShowWorkerStarted = true;

  const sweep = dependencies.sweep ?? sweepOverdueAppointments;
  const nextRunAt = dependencies.nextRunAt ?? nextNoShowSweepAt;
  const now = dependencies.now ?? (() => new Date());
  const schedule = dependencies.schedule ?? setTimeout;
  const reportError = dependencies.reportError ?? console.error;
  const scheduleRun = (delayMs: number) => {
    const timer = schedule(() => void run(), Math.max(0, delayMs));
    timer.unref?.();
  };
  const run = async () => {
    try {
      await sweep(now());
      const boundary = await nextRunAt(now());
      scheduleRun(boundary.getTime() - now().getTime());
    } catch (error) {
      reportError("Automatic appointment no-show sweep failed.", error);
      scheduleRun(APPOINTMENT_NO_SHOW_RETRY_MS);
    }
  };

  void run();
  return true;
}
