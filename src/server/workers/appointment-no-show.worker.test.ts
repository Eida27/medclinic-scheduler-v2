import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPOINTMENT_NO_SHOW_RETRY_MS,
  startAppointmentNoShowWorker,
} from "./appointment-no-show.worker";

type WorkerGlobal = typeof globalThis & {
  __medclinicAppointmentNoShowWorkerStarted?: boolean;
};

describe("startAppointmentNoShowWorker", () => {
  beforeEach(() => {
    delete (globalThis as WorkerGlobal).__medclinicAppointmentNoShowWorkerStarted;
  });

  it("runs startup catch-up and schedules each configured midnight exactly once", async () => {
    const startup = new Date("2026-07-10T07:59:59.000Z");
    const firstMidnight = new Date("2026-07-10T16:00:00.000Z");
    const secondMidnight = new Date("2026-07-11T16:00:00.000Z");
    let currentTime = startup;
    const sweep = vi.fn().mockResolvedValue(undefined);
    const nextRunAt = vi
      .fn()
      .mockResolvedValueOnce(firstMidnight)
      .mockResolvedValueOnce(secondMidnight);
    const unref = vi.fn();
    const callbacks: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return { unref };
    });

    expect(startAppointmentNoShowWorker({
      sweep,
      nextRunAt,
      now: () => currentTime,
      schedule,
    })).toBe(true);

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(sweep).toHaveBeenNthCalledWith(1, startup);
    expect(nextRunAt).toHaveBeenNthCalledWith(1, startup);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      firstMidnight.getTime() - startup.getTime(),
    );
    expect(unref).toHaveBeenCalledOnce();

    expect(startAppointmentNoShowWorker({ sweep, nextRunAt, schedule })).toBe(false);
    expect(schedule).toHaveBeenCalledOnce();

    currentTime = firstMidnight;
    callbacks[0]();

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(sweep).toHaveBeenNthCalledWith(2, firstMidnight);
    expect(nextRunAt).toHaveBeenNthCalledWith(2, firstMidnight);
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      secondMidnight.getTime() - firstMidnight.getTime(),
    );
    expect(unref).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh clock when a midnight callback runs late", async () => {
    const startup = new Date("2026-07-10T07:00:00.000Z");
    const firstMidnight = new Date("2026-07-10T16:00:00.000Z");
    const lateRun = new Date("2026-07-10T16:03:00.000Z");
    const secondMidnight = new Date("2026-07-11T16:00:00.000Z");
    let currentTime = startup;
    const sweep = vi.fn().mockResolvedValue(undefined);
    const nextRunAt = vi
      .fn()
      .mockResolvedValueOnce(firstMidnight)
      .mockResolvedValueOnce(secondMidnight);
    const callbacks: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return {};
    });

    startAppointmentNoShowWorker({
      sweep,
      nextRunAt,
      now: () => currentTime,
      schedule,
    });
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());

    currentTime = lateRun;
    callbacks[0]();

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(sweep).toHaveBeenNthCalledWith(2, lateRun);
    expect(nextRunAt).toHaveBeenNthCalledWith(2, lateRun);
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      secondMidnight.getTime() - lateRun.getTime(),
    );
  });

  it("retries five minutes after a sweep failure and resumes midnight scheduling", async () => {
    const error = new Error("database unavailable");
    const now = new Date("2026-07-10T08:00:00.000Z");
    const nextMidnight = new Date("2026-07-10T16:00:00.000Z");
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const nextRunAt = vi.fn().mockResolvedValue(nextMidnight);
    const reportError = vi.fn();
    const callbacks: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return {};
    });

    startAppointmentNoShowWorker({
      sweep,
      nextRunAt,
      now: () => now,
      schedule,
      reportError,
    });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(reportError).toHaveBeenCalledWith(
      "Automatic appointment no-show sweep failed.",
      error,
    );
    expect(nextRunAt).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      APPOINTMENT_NO_SHOW_RETRY_MS,
    );
    expect(APPOINTMENT_NO_SHOW_RETRY_MS).toBe(300_000);

    callbacks[0]();

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(nextRunAt).toHaveBeenCalledWith(now);
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      nextMidnight.getTime() - now.getTime(),
    );
  });

  it("retries five minutes after the next-midnight lookup fails", async () => {
    const error = new Error("timezone lookup failed");
    const now = new Date("2026-07-10T08:00:00.000Z");
    const nextMidnight = new Date("2026-07-10T16:00:00.000Z");
    const sweep = vi.fn().mockResolvedValue(undefined);
    const nextRunAt = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(nextMidnight);
    const reportError = vi.fn();
    const callbacks: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return {};
    });

    startAppointmentNoShowWorker({
      sweep,
      nextRunAt,
      now: () => now,
      schedule,
      reportError,
    });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(reportError).toHaveBeenCalledWith(
      "Automatic appointment no-show sweep failed.",
      error,
    );
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      APPOINTMENT_NO_SHOW_RETRY_MS,
    );

    callbacks[0]();

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(nextRunAt).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      nextMidnight.getTime() - now.getTime(),
    );
  });
});
