export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAppointmentNoShowWorker } = await import(
      "@/server/workers/appointment-no-show.worker"
    );
    const { startResultDraftCleanupWorker } = await import(
      "@/server/workers/result-draft-cleanup.worker"
    );
    const { startEmailOutboxWorker } = await import(
      "@/server/workers/email-outbox.worker"
    );
    startAppointmentNoShowWorker();
    startResultDraftCleanupWorker();
    startEmailOutboxWorker();
  }
}
