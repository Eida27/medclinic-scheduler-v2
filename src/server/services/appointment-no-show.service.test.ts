import { describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  getNextNoShowSweepAt: vi.fn(),
  markOverdueAppointmentsNoShow: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_TIMEZONE: "Asia/Manila" }),
}));

vi.mock("@/server/repositories/appointment-no-show.repository", () => repository);

import {
  nextNoShowSweepAt,
  sweepOverdueAppointments,
} from "./appointment-no-show.service";

describe("appointment no-show service", () => {
  it("passes the configured timezone to sweep and boundary calculations", async () => {
    const now = new Date("2026-07-10T07:59:59.000Z");
    const nextMidnight = new Date("2026-07-10T16:00:00.000Z");
    repository.markOverdueAppointmentsNoShow.mockResolvedValue({
      count: 0,
      appointmentIds: [],
    });
    repository.getNextNoShowSweepAt.mockResolvedValue(nextMidnight);

    await expect(sweepOverdueAppointments(now)).resolves.toEqual({
      count: 0,
      appointmentIds: [],
    });
    await expect(nextNoShowSweepAt(now)).resolves.toEqual(nextMidnight);

    expect(repository.markOverdueAppointmentsNoShow).toHaveBeenCalledWith(
      now,
      "Asia/Manila",
    );
    expect(repository.getNextNoShowSweepAt).toHaveBeenCalledWith(
      now,
      "Asia/Manila",
    );
  });
});
