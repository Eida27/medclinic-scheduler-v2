import { describe, expect, it } from "vitest";
import { resolveSchedulingWindow } from "./scheduling-window";

describe("resolveSchedulingWindow", () => {
  it("starts a pre-August Regular batch on the first weekday in August", () => {
    expect(resolveSchedulingWindow({
      category: "REGULAR",
      academicYearStart: 2026,
      preferredMonth: null,
      acceptedAt: "2026-06-01T03:00:00.000Z",
      timeZone: "Asia/Manila",
    })).toBe("2026-08-03");
  });

  it("adds seven Manila calendar dates before advancing the weekend", () => {
    expect(resolveSchedulingWindow({
      category: "REGULAR",
      academicYearStart: 2026,
      preferredMonth: null,
      acceptedAt: "2026-07-31T17:00:00.000Z",
      timeZone: "Asia/Manila",
    })).toBe("2026-08-10");
  });

  it("resolves January inside the second half of the selected academic year", () => {
    expect(resolveSchedulingWindow({
      category: "OJT",
      academicYearStart: 2026,
      preferredMonth: 1,
      acceptedAt: "2026-08-01T00:00:00.000Z",
      timeZone: "Asia/Manila",
    })).toBe("2027-01-01");
  });

  it("uses the later preparation date when it has passed the preferred month", () => {
    expect(resolveSchedulingWindow({
      category: "TOUR",
      academicYearStart: 2026,
      preferredMonth: 9,
      acceptedAt: "2026-09-29T04:00:00.000Z",
      timeZone: "Asia/Manila",
    })).toBe("2026-10-06");
  });
});
