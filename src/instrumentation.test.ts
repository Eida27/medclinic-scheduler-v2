import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startAppointmentNoShowWorker = vi.hoisted(() => vi.fn());
const startResultDraftCleanupWorker = vi.hoisted(() => vi.fn());
const startEmailOutboxWorker = vi.hoisted(() => vi.fn());

vi.mock("@/server/workers/appointment-no-show.worker", () => ({
  startAppointmentNoShowWorker,
}));
vi.mock("@/server/workers/result-draft-cleanup.worker", () => ({ startResultDraftCleanupWorker }));
vi.mock("@/server/workers/email-outbox.worker", () => ({ startEmailOutboxWorker }));

import { register } from "./instrumentation";

describe("register", () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    startAppointmentNoShowWorker.mockReset();
    startResultDraftCleanupWorker.mockReset();
    startEmailOutboxWorker.mockReset();
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
    expect(startResultDraftCleanupWorker).toHaveBeenCalledOnce();
    expect(startEmailOutboxWorker).toHaveBeenCalledOnce();
  });

  it("does not start the automatic no-show worker outside Node.js", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(startAppointmentNoShowWorker).not.toHaveBeenCalled();
    expect(startResultDraftCleanupWorker).not.toHaveBeenCalled();
    expect(startEmailOutboxWorker).not.toHaveBeenCalled();
  });
});
