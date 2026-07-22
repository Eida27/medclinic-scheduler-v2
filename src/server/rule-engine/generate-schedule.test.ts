import { describe, expect, it } from "vitest";
import { checkCapacity } from "./capacity-rules";
import { generateSchedule } from "./generate-schedule";
import type { ScheduleItemInput } from "./types";

const capacities = [
  { clinicId: "60000000-0000-4000-8000-000000000002", scheduleType: "PHYSICAL_EXAM" as const, maxDailyCapacity: 150 },
  { clinicId: "60000000-0000-4000-8000-000000000001", scheduleType: "LABORATORY" as const, maxDailyCapacity: 150 },
];

function item(overrides: Partial<ScheduleItemInput> = {}): ScheduleItemInput {
  return {
    id: "item-1",
    clinicId: "60000000-0000-4000-8000-000000000002",
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
    [121, "VALID"],
    [150, "VALID"],
    [151, "CONFLICT"],
  ] as const)("classifies %i appointments as %s", (count, expected) => {
    expect(checkCapacity("60000000-0000-4000-8000-000000000002", "2026-07-06", "PHYSICAL_EXAM", count, capacities[0]).status).toBe(expected);
  });
});

describe("generateSchedule", () => {
  it("keeps exact-date requests fixed", () => {
    const output = generateSchedule({ items: [item()], capacities, existingLoad: [] });

    expect(output.appointments).toEqual([
      expect.objectContaining({ studentNumber: "23-0001-01", appointmentDate: "2026-07-06" }),
    ]);
  });

  it("schedules independent physical and laboratory items through the same engine", () => {
    const output = generateSchedule({
      items: [
        item({ id: "physical", clinicId: "60000000-0000-4000-8000-000000000002", scheduleType: "PHYSICAL_EXAM" }),
        item({ id: "laboratory", clinicId: "60000000-0000-4000-8000-000000000001", scheduleType: "LABORATORY" }),
      ],
      capacities,
      existingLoad: [],
    });

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
      existingLoad: [{ clinicId: "60000000-0000-4000-8000-000000000002", date: "2026-07-06", scheduleType: "PHYSICAL_EXAM", count: 150 }],
    });

    expect(output.appointments).toHaveLength(0);
    expect(output.unscheduledItems).toEqual([
      expect.objectContaining({ scheduleItemId: "item-1", code: "NO_CAPACITY" }),
    ]);
  });

  it("keeps daily load separate for clinics that share a schedule type", () => {
    const output = generateSchedule({
      items: [
        item({
          clinicId: "cpu",
          targetDate: null,
          targetWeekStart: "2026-07-06",
          targetWeekEnd: "2026-07-06",
        }),
      ],
      capacities: [
        { clinicId: "cpu", scheduleType: "PHYSICAL_EXAM", maxDailyCapacity: 1 },
        { clinicId: "other-clinic", scheduleType: "PHYSICAL_EXAM", maxDailyCapacity: 1 },
      ],
      existingLoad: [
        { clinicId: "other-clinic", date: "2026-07-06", scheduleType: "PHYSICAL_EXAM", count: 1 },
      ],
    });

    expect(output.unscheduledItems).toHaveLength(0);
    expect(output.appointments).toEqual([
      expect.objectContaining({
        clinicId: "cpu",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2026-07-06",
      }),
    ]);
  });
});
