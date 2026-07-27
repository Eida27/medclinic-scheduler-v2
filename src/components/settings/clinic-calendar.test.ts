import { describe, expect, it } from "vitest";
import { buildAnnualCalendar, buildMonthGrid, expandUnavailableRanges } from "./clinic-calendar";

describe("annual clinic calendar dates", () => {
  it("builds all twelve true-date grids without adjacent-month dates", () => {
    const annual = buildAnnualCalendar(2027);
    expect(annual.map((month) => month.name)).toEqual([
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ]);
    for (const month of annual) {
      const dates = month.cells.filter((cell) => cell.kind === "date");
      expect(new Set(dates.map((cell) => cell.date)).size).toBe(dates.length);
      expect(dates.every((cell) => cell.date.startsWith(month.month))).toBe(true);
      expect(month.cells.length % 7).toBe(0);
    }
  });

  it("uses 29 February only in leap years", () => {
    expect(buildMonthGrid("2028-02").filter((cell) => cell.kind === "date")).toHaveLength(29);
    expect(buildMonthGrid("2027-02").filter((cell) => cell.kind === "date")).toHaveLength(28);
  });

  it("indexes unified records directly by their date-only key", () => {
    const record = {
      id: "date-1",
      closureGroupId: "group-1",
      blockedDate: "2027-08-11",
      groupStartDate: "2027-08-11",
      groupEndDate: "2027-08-13",
      category: "CLOSURE" as const,
      reason: "Typhoon",
      createdByName: "Admin",
      createdAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2027-01-01T00:00:00.000000Z",
    };
    expect(expandUnavailableRanges([record])).toEqual(new Map([["2027-08-11", record]]));
  });
});
