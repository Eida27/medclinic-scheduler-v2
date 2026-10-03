import { describe, expect, it } from "vitest";
import { AUTOMATIC_NO_SHOW_NOTE, isAutomaticNoShowLog } from "./automatic-no-show";

describe("automatic no-show correction eligibility", () => {
  const current = { oldStatus: "PENDING", newStatus: "NO_SHOW", notes: AUTOMATIC_NO_SHOW_NOTE, changedById: null };
  it("recognizes the current automatic transition", () => {
    expect(isAutomaticNoShowLog(current)).toBe(true);
  });
  it("refuses the obsolete 24-hour note", () => {
    expect(isAutomaticNoShowLog({ ...current, notes: "Automatically marked no-show after the 24-hour appointment completion window." })).toBe(false);
  });
  it("refuses missing logs and manual or unrelated transitions", () => {
    expect(isAutomaticNoShowLog(null)).toBe(false);
    expect(isAutomaticNoShowLog(undefined)).toBe(false);
    expect(isAutomaticNoShowLog({ ...current, changedById: "staff" })).toBe(false);
    expect(isAutomaticNoShowLog({ ...current, oldStatus: "DRAFT" })).toBe(false);
    expect(isAutomaticNoShowLog({ ...current, newStatus: "COMPLETED" })).toBe(false);
  });
});
