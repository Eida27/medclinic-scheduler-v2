import { describe, expect, it } from "vitest";

import { resolveAutomaticReplacementBounds } from "./automatic-replacement-bounds";

describe("resolveAutomaticReplacementBounds", () => {
  it("keeps pair replacement after Manila today when the persisted window is historical", () => {
    expect(resolveAutomaticReplacementBounds({
      replacementType: "PAIR",
      originalWindowStart: "2026-08-01",
      manilaToday: "2026-08-20",
      cycleClosingDate: "2027-07-31",
    })).toEqual({
      lowerBound: "2026-08-21",
      upperBound: "2027-07-31",
    });
  });

  it("keeps pair replacement inside a later persisted scheduling window", () => {
    expect(resolveAutomaticReplacementBounds({
      replacementType: "PAIR",
      originalWindowStart: "2026-09-01",
      manilaToday: "2026-08-20",
      cycleClosingDate: "2027-07-31",
    })).toEqual({
      lowerBound: "2026-09-01",
      upperBound: "2027-07-31",
    });
  });

  it("keeps a Physical Examination-only replacement strictly after Laboratory", () => {
    expect(resolveAutomaticReplacementBounds({
      replacementType: "PHYSICAL_EXAM_ONLY",
      originalWindowStart: "2026-08-01",
      manilaToday: "2026-08-20",
      laboratoryDate: "2026-08-25",
      cycleClosingDate: "2027-07-31",
    })).toEqual({
      lowerBound: "2026-08-26",
      upperBound: "2027-07-31",
    });
  });
});
