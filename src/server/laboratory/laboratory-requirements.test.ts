import { describe, expect, it } from "vitest";
import { requiredLaboratoryTests } from "./laboratory-requirements";

describe("required laboratory tests from immutable academic context", () => {
  it.each([
    [1, "REGULAR", ["CBC", "URINE", "STOOL", "XRAY"]],
    [1, "OJT", ["CBC", "URINE", "STOOL", "XRAY"]],
    [4, "OJT", ["CBC", "URINE", "STOOL", "XRAY"]],
    [2, "REGULAR", ["CBC", "URINE", "STOOL"]],
    [3, "TOUR", ["CBC", "URINE", "STOOL"]],
    [4, "REGULAR", ["CBC", "URINE", "STOOL"]],
    [4, "TOUR", ["CBC", "URINE", "STOOL"]],
  ])("requires the correct tests for year %s and %s", (yearLevel, schedulingCategory, expected) => {
    expect(requiredLaboratoryTests({ yearLevel: yearLevel as number, schedulingCategory: schedulingCategory as string })).toEqual(expected);
  });

  it.each([
    { yearLevel: null, schedulingCategory: "REGULAR" },
    { yearLevel: 4, schedulingCategory: null },
    { yearLevel: 0, schedulingCategory: "OJT" },
    { yearLevel: 5, schedulingCategory: "REGULAR" },
    { yearLevel: 1, schedulingCategory: "UNKNOWN" },
  ])("blocks missing or unsupported provenance %j", (context) => {
    expect(() => requiredLaboratoryTests(context)).toThrow();
  });
});
