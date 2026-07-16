import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startAppointmentNoShowWorker = vi.hoisted(() => vi.fn());

vi.mock("@/server/workers/appointment-no-show.worker", () => ({
  startAppointmentNoShowWorker,
}));

import { register } from "./instrumentation";

describe("register", () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    startAppointmentNoShowWorker.mockReset();
  });

  afterEach(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }
  });

  it("starts the automatic no-show worker in the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(startAppointmentNoShowWorker).toHaveBeenCalledOnce();
  });

  it("does not start the automatic no-show worker outside Node.js", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(startAppointmentNoShowWorker).not.toHaveBeenCalled();
  });
});
