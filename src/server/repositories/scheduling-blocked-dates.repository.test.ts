import { describe, expect, it, vi } from "vitest";

import { loadSchedulingBlockedDates } from "./scheduling-blocked-dates.repository";

describe("loadSchedulingBlockedDates", () => {
  it("combines global closures with service-specific active OVPSA reservations", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { schedule_type: "LABORATORY", date: "2026-09-01" },
      { schedule_type: "PHYSICAL_EXAM", date: "2026-09-01" },
      { schedule_type: "LABORATORY", date: "2026-09-02" },
      { schedule_type: "PHYSICAL_EXAM", date: "2026-09-03" },
    ] });

    const result = await loadSchedulingBlockedDates(
      { query } as never,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/ovpsa_first_year_service_reservations[\s\S]+reservation_kind='EXCLUSIVE'/),
      ["2026-09-01", "2026-09-30", null],
    );
    expect(result).toEqual({
      laboratoryDates: ["2026-09-01", "2026-09-02"],
      physicalExamDates: ["2026-09-01", "2026-09-03"],
    });
  });

  it("can exclude the batch being atomically revised", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await loadSchedulingBlockedDates(
      { query } as never,
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        excludeOvpsaBatchId: "batch-id",
      },
    );

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      "2026-09-01",
      "2026-09-30",
      "batch-id",
    ]);
  });
});
