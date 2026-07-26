import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import {
  buildMonthGrid,
  expandUnavailableRanges,
  manilaToday,
  shiftMonth,
} from "./clinic-calendar";

describe("buildMonthGrid", () => {
  it("uses blank alignment cells without neighboring-month dates", () => {
    const august = buildMonthGrid("2026-08");

    expect(august).toHaveLength(42);
    expect(august.slice(0, 6)).toEqual([
      { kind: "blank", key: "2026-08-leading-0" },
      { kind: "blank", key: "2026-08-leading-1" },
      { kind: "blank", key: "2026-08-leading-2" },
      { kind: "blank", key: "2026-08-leading-3" },
      { kind: "blank", key: "2026-08-leading-4" },
      { kind: "blank", key: "2026-08-leading-5" },
    ]);
    expect(august.filter((cell) => cell.kind === "date").map((cell) => cell.dayOfMonth))
      .toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
    expect(august.some((cell) => cell.kind === "date" && !cell.inCurrentMonth)).toBe(false);
  });

  it.each([
    ["2026-01", 35], ["2026-02", 28], ["2026-03", 35], ["2026-04", 35],
    ["2026-05", 42], ["2026-06", 35], ["2026-07", 35], ["2026-08", 42],
    ["2026-09", 35], ["2026-10", 35], ["2026-11", 35], ["2026-12", 35],
  ])("returns the smallest complete week grid for %s", (month, expectedCellCount) => {
    expect(buildMonthGrid(month)).toHaveLength(expectedCellCount);
  });

  it("includes February 29 in a leap year", () => {
    const currentMonthDays = buildMonthGrid("2024-02").filter((day) => day.kind === "date");

    expect(currentMonthDays).toHaveLength(29);
    expect(currentMonthDays.at(-1)?.date).toBe("2024-02-29");
  });

  it("marks Saturdays and Sundays as weekends", () => {
    const daysByDate = new Map(buildMonthGrid("2026-08")
      .filter((day) => day.kind === "date")
      .map((day) => [day.date, day]));

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
      updatedAt: "2026-07-01T00:00:00.000000Z",
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
    expect(shiftMonth("2026-01", -1) < "2026-01").toBe(true);
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
