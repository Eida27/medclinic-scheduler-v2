import { describe, expect, it } from "vitest";
import { academicYearLabel, academicYearState, manilaCalendarDate } from "./academic-year";

describe("academic-year presentation", () => {
  it("derives the label with an en dash", () => {
    expect(academicYearLabel(2025)).toBe("2025–2026");
  });

  it("uses the Asia/Manila calendar date", () => {
    expect(manilaCalendarDate(new Date("2026-07-30T16:30:00.000Z"))).toBe("2026-07-31");
  });

  it.each([
    ["2026-07-16T15:59:59.000Z", "OPEN"],
    ["2026-07-16T16:00:00.000Z", "CLOSING_SOON"],
    ["2026-07-30T16:00:00.000Z", "CLOSING_SOON"],
    ["2026-07-31T16:00:00.000Z", "CLOSED"],
  ] as const)("classifies closing-date boundaries at %s as %s", (instant, state) => {
    expect(academicYearState("2026-07-31", new Date(instant))).toBe(state);
  });
});
