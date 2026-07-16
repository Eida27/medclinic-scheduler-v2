import { sweepOverdueAppointments } from "@/server/services/appointment-no-show.service";

export const APPOINTMENT_NO_SHOW_INTERVAL_MS = 5 * 60 * 1000;

type WorkerDependencies = {
  sweep?: () => Promise<unknown>;
  schedule?: (
    callback: () => void,
    intervalMs: number,
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
  const reportError = dependencies.reportError ?? console.error;
  const run = () =>
    void sweep().catch((error) => {
      reportError("Automatic appointment no-show sweep failed.", error);
    });

  run();
  const timer = (dependencies.schedule ?? setInterval)(
    run,
    APPOINTMENT_NO_SHOW_INTERVAL_MS,
  );
  timer.unref?.();
  return true;
}
