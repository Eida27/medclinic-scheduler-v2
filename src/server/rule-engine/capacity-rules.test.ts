import { describe, expect, it } from "vitest";
import { checkCapacity } from "./capacity-rules";

const setting = {
  clinicId: "60000000-0000-4000-8000-000000000002",
  scheduleType: "PHYSICAL_EXAM" as const,
  maxDailyCapacity: 150,
};

describe("checkCapacity", () => {
  it.each([149, 150])("classifies %i appointments at or below the maximum as valid", (count) => {
    expect(
      checkCapacity(setting.clinicId, "2026-07-06", setting.scheduleType, count, setting),
    ).toEqual({
      status: "VALID",
      clinicId: setting.clinicId,
      date: "2026-07-06",
      scheduleType: setting.scheduleType,
      count,
      maxCapacity: setting.maxDailyCapacity,
      message: "This date is within the maximum daily capacity.",
    });
  });

  it("classifies appointments above the maximum as a conflict", () => {
    expect(
      checkCapacity(setting.clinicId, "2026-07-06", setting.scheduleType, 151, setting),
    ).toEqual({
      status: "CONFLICT",
      clinicId: setting.clinicId,
      date: "2026-07-06",
      scheduleType: setting.scheduleType,
      count: 151,
      maxCapacity: setting.maxDailyCapacity,
      message: "151 appointments exceed the maximum capacity of 150.",
    });
  });

  it("does not return a warning or recommended-capacity message", () => {
    const results = [149, 150, 151].map((count) =>
      checkCapacity(setting.clinicId, "2026-07-06", setting.scheduleType, count, setting),
    );

    expect(results.map((result) => result.status)).toEqual(["VALID", "VALID", "CONFLICT"]);
    expect(results.map((result) => result.message).join(" ")).not.toContain("recommended capacity");
  });
});
