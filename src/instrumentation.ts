export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAppointmentNoShowWorker } = await import(
      "@/server/workers/appointment-no-show.worker"
    );
    startAppointmentNoShowWorker();
  }
}
