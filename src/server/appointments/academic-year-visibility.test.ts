import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertOpenAppointmentCycle } from "./academic-year-visibility";

describe("appointment cycle mutation boundary", () => {
  function clientFor(closingDate?: string) {
    return { query: vi.fn().mockResolvedValue({ rows: closingDate ? [{ closingDate }] : [] }) } as unknown as PoolClient;
  }

  it("allows the last second of the configured closing date in Manila", async () => {
    await expect(assertOpenAppointmentCycle(clientFor("2027-05-10"), 2026, new Date("2027-05-10T15:59:59Z"))).resolves.toBeUndefined();
  });

  it("blocks the first instant after the closing date in Manila", async () => {
    await expect(assertOpenAppointmentCycle(clientFor("2027-05-10"), 2026, new Date("2027-05-10T16:00:00Z"))).rejects.toMatchObject({ code: "ACADEMIC_YEAR_ENDED", status: 409 });
  });

  it("blocks a missing academic year instead of treating it as current", async () => {
    await expect(assertOpenAppointmentCycle(clientFor(), 2026, new Date("2026-09-23T00:00:00Z"))).rejects.toMatchObject({ code: "ACADEMIC_YEAR_MISSING", status: 409 });
  });

  it("blocks a missing cycle instead of querying a guessed year", async () => {
    await expect(assertOpenAppointmentCycle(clientFor("2027-05-10"), null, new Date("2026-09-23T00:00:00Z"))).rejects.toMatchObject({ code: "ACADEMIC_YEAR_MISSING" });
  });
});
