import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import {
  buildMonthGrid,
  expandUnavailableRanges,
  manilaToday,
  shiftMonth,
} from "./clinic-calendar";

describe("buildMonthGrid", () => {
  it("always returns a six-week grid", () => {
    expect(buildMonthGrid("2026-08")).toHaveLength(42);
  });

  it("includes the leading and trailing dates around the current month", () => {
    const days = buildMonthGrid("2026-08");

    expect(days.slice(0, 7).map((day) => day.date)).toEqual([
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
    ]);
    expect(days.at(-1)?.date).toBe("2026-09-05");
    expect(days[0].inCurrentMonth).toBe(false);
    expect(days[6].inCurrentMonth).toBe(true);
    expect(days.at(-1)?.inCurrentMonth).toBe(false);
  });

  it("includes February 29 in a leap year", () => {
    const currentMonthDays = buildMonthGrid("2024-02").filter((day) => day.inCurrentMonth);

    expect(currentMonthDays).toHaveLength(29);
    expect(currentMonthDays.at(-1)?.date).toBe("2024-02-29");
  });

  it("marks Saturdays and Sundays as weekends", () => {
    const daysByDate = new Map(buildMonthGrid("2026-08").map((day) => [day.date, day]));

    expect(daysByDate.get("2026-08-01")?.isWeekend).toBe(true);
    expect(daysByDate.get("2026-08-02")?.isWeekend).toBe(true);
    expect(daysByDate.get("2026-08-03")?.isWeekend).toBe(false);
  });

  it("rejects malformed or impossible month values", () => {
    expect(() => buildMonthGrid("2026-8")).toThrow(/YYYY-MM/);
    expect(() => buildMonthGrid("2026-13")).toThrow(/YYYY-MM/);
    expect(() => buildMonthGrid("2026-00")).toThrow(/YYYY-MM/);
  });
});

describe("expandUnavailableRanges", () => {
  it("maps every date in an inclusive range to the original record", () => {
    const record: ClinicUnavailableDateRecord = {
      id: "unavailable-1",
      clinicId: "clinic-1",
      clinicCode: "CPU_CLINIC",
      clinicName: "CPU Clinic",
      startDate: "2026-08-03",
      endDate: "2026-08-05",
      category: "CLOSURE",
      reason: "Planned maintenance",
      createdByName: "Clinic Admin",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const expanded = expandUnavailableRanges([record]);

    expect([...expanded.keys()]).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(expanded.get("2026-08-03")).toBe(record);
    expect(expanded.get("2026-08-04")).toBe(record);
    expect(expanded.get("2026-08-05")).toBe(record);
  });
});

describe("shiftMonth", () => {
  it("rolls December forward into January of the next year", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("rolls January backward into December of the previous year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("supports offsets spanning more than one year", () => {
    expect(shiftMonth("2026-11", 15)).toBe("2028-02");
  });

  it("rejects malformed or impossible month values", () => {
    expect(() => shiftMonth("26-01", 1)).toThrow(/YYYY-MM/);
    expect(() => shiftMonth("2026-13", 1)).toThrow(/YYYY-MM/);
  });
});

describe("manilaToday", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("changes dates at midnight in Manila instead of midnight UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T15:59:59.000Z"));
    expect(manilaToday()).toBe("2026-08-02");

    vi.setSystemTime(new Date("2026-08-02T16:00:00.000Z"));
    expect(manilaToday()).toBe("2026-08-03");
  });
});
