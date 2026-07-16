import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPOINTMENT_NO_SHOW_INTERVAL_MS,
  startAppointmentNoShowWorker,
} from "./appointment-no-show.worker";

type WorkerGlobal = typeof globalThis & {
  __medclinicAppointmentNoShowWorkerStarted?: boolean;
};

describe("startAppointmentNoShowWorker", () => {
  beforeEach(() => {
    delete (globalThis as WorkerGlobal).__medclinicAppointmentNoShowWorkerStarted;
  });

  it("runs immediately and schedules one unrefed five-minute worker per process", () => {
    const sweep = vi.fn().mockResolvedValue(undefined);
    const unref = vi.fn();
    let intervalCallback: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, _intervalMs: number) => {
      intervalCallback = callback;
      return { unref };
    });

    expect(startAppointmentNoShowWorker({ sweep, schedule })).toBe(true);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      APPOINTMENT_NO_SHOW_INTERVAL_MS,
    );
    expect(APPOINTMENT_NO_SHOW_INTERVAL_MS).toBe(300_000);
    expect(unref).toHaveBeenCalledOnce();

    expect(startAppointmentNoShowWorker({ sweep, schedule })).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledOnce();

    expect(intervalCallback).toBeTypeOf("function");
    intervalCallback?.();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected sweep and remains usable on the next interval", async () => {
    const error = new Error("database unavailable");
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const reportError = vi.fn();
    let intervalCallback: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, _intervalMs: number) => {
      intervalCallback = callback;
      return {};
    });

    startAppointmentNoShowWorker({ sweep, schedule, reportError });

    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(
        "Automatic appointment no-show sweep failed.",
        error,
      );
    });

    intervalCallback?.();
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledOnce();
  });
});
