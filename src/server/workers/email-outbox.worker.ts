import "server-only";
import { deliverEmailOutboxBatch } from "@/server/services/email-outbox.service";

export const EMAIL_OUTBOX_INTERVAL_MS = 60 * 1000;

type WorkerDependencies = {
  deliver?: () => Promise<unknown>;
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void };
  reportError?: (message: string, error: unknown) => void;
};

declare global {
  var __medclinicEmailOutboxWorkerStarted: boolean | undefined;
}

export function startEmailOutboxWorker(dependencies: WorkerDependencies = {}) {
  if (globalThis.__medclinicEmailOutboxWorkerStarted) return false;
  globalThis.__medclinicEmailOutboxWorkerStarted = true;
  const deliver = dependencies.deliver ?? (() => deliverEmailOutboxBatch());
  const schedule = dependencies.schedule ?? setTimeout;
  const reportError = dependencies.reportError ?? console.error;
  const run = async () => {
    try {
      await deliver();
    } catch (error) {
      reportError("Email outbox delivery failed.", error);
    } finally {
      const timer = schedule(() => void run(), EMAIL_OUTBOX_INTERVAL_MS);
      timer.unref?.();
    }
  };
  void run();
  return true;
}
