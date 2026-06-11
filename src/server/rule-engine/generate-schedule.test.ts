import { describe, expect, it } from "vitest";
import { checkCapacity } from "./capacity-rules";
import { generateSchedule } from "./generate-schedule";
import type { ScheduleItemInput } from "./types";

const capacities = [
  { scheduleType: "PHYSICAL_EXAM" as const, safeDailyCapacity: 120, maxDailyCapacity: 150 },
  { scheduleType: "LABORATORY" as const, safeDailyCapacity: 120, maxDailyCapacity: 150 },
];

function item(overrides: Partial<ScheduleItemInput> = {}): ScheduleItemInput {
  return {
    id: "item-1",
    studentNumber: "23-0001-01",
    scheduleType: "PHYSICAL_EXAM",
    priorityRank: 4,
    targetDate: "2026-07-06",
    targetWeekStart: null,
    targetWeekEnd: null,
    ...overrides,
  };
}

describe("checkCapacity", () => {
  it.each([
    [120, "VALID"],
    [121, "WARNING"],
    [150, "WARNING"],
    [151, "CONFLICT"],
  ] as const)("classifies %i appointments as %s", (count, expected) => {
    expect(checkCapacity("2026-07-06", "PHYSICAL_EXAM", count, capacities[0]).status).toBe(expected);
  });
});

describe("generateSchedule", () => {
  it("keeps exact-date requests fixed", () => {
    const output = generateSchedule({ items: [item()], capacities, existingLoad: [] });

    expect(output.appointments).toEqual([
      expect.objectContaining({ studentNumber: "23-0001-01", appointmentDate: "2026-07-06" }),
    ]);
  });

  it("expands BOTH into independent physical and laboratory appointments", () => {
    const output = generateSchedule({ items: [item({ scheduleType: "BOTH" })], capacities, existingLoad: [] });

    expect(output.appointments.map((appointment) => appointment.scheduleType)).toEqual([
      "PHYSICAL_EXAM",
      "LABORATORY",
    ]);
  });

  it("uses weekdays only and balances ties toward the earliest date", () => {
    const items = Array.from({ length: 3 }, (_, index) =>
      item({
        id: `item-${index + 1}`,
        studentNumber: `23-000${index + 1}-01`,
        targetDate: null,
        targetWeekStart: "2026-07-04",
        targetWeekEnd: "2026-07-07",
      }),
    );

    const output = generateSchedule({ items, capacities, existingLoad: [] });

    expect(output.appointments.map((appointment) => appointment.appointmentDate)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-06",
    ]);
  });

  it("sorts week requests by priority rank then student number", () => {
    const output = generateSchedule({
      items: [
        item({ id: "regular", studentNumber: "23-0002-01", priorityRank: 4, targetDate: null, targetWeekStart: "2026-07-06", targetWeekEnd: "2026-07-06" }),
        item({ id: "graduating-b", studentNumber: "23-0003-01", priorityRank: 1, targetDate: null, targetWeekStart: "2026-07-06", targetWeekEnd: "2026-07-06" }),
        item({ id: "graduating-a", studentNumber: "23-0001-01", priorityRank: 1, targetDate: null, targetWeekStart: "2026-07-06", targetWeekEnd: "2026-07-06" }),
      ],
      capacities,
      existingLoad: [],
    });

    expect(output.appointments.map((appointment) => appointment.scheduleItemId)).toEqual([
      "graduating-a",
      "graduating-b",
      "regular",
    ]);
  });

  it("reports week requests as unscheduled when every eligible date is full", () => {
    const output = generateSchedule({
      items: [item({ targetDate: null, targetWeekStart: "2026-07-06", targetWeekEnd: "2026-07-06" })],
      capacities,
      existingLoad: [{ date: "2026-07-06", scheduleType: "PHYSICAL_EXAM", count: 150 }],
    });

    expect(output.appointments).toHaveLength(0);
    expect(output.unscheduledItems).toEqual([
      expect.objectContaining({ scheduleItemId: "item-1", code: "NO_CAPACITY" }),
    ]);
  });
});
