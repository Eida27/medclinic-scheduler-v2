import { describe, expect, it } from "vitest";
import { resolveLaboratoryCompletionPolicy } from "./laboratory-completion-policy";

describe("immutable Laboratory completion ownership", () => {
  it("reserves all valid First-Year OVPSA tests for PE confirmation", () => {
    expect(resolveLaboratoryCompletionPolicy({ yearLevel: 1, schedulingCategory: "REGULAR", isOvpsaFirstYear: true })).toEqual({
      mode: "FIRST_YEAR_EXTERNAL", manualTestCodes: [], peConfirmedTestCodes: ["CBC", "URINE", "STOOL", "XRAY"],
      externalProvider: "Iloilo Mission Hospital",
    });
  });

  it("keeps fourth-year OJT manual tests and reserves only X-ray", () => {
    expect(resolveLaboratoryCompletionPolicy({ yearLevel: 4, schedulingCategory: "OJT", isOvpsaFirstYear: false })).toEqual({
      mode: "FOURTH_YEAR_OJT", manualTestCodes: ["CBC", "URINE", "STOOL"], peConfirmedTestCodes: ["XRAY"],
      externalProvider: "Iloilo Mission Hospital",
    });
  });

  it.each([[4, "REGULAR"], [4, "TOUR"], [2, "REGULAR"], [2, "OJT"], [3, "TOUR"]])(
    "keeps the ordinary required checklist for year %s category %s", (yearLevel, schedulingCategory) => {
      expect(resolveLaboratoryCompletionPolicy({ yearLevel: Number(yearLevel), schedulingCategory: String(schedulingCategory), isOvpsaFirstYear: false })).toEqual({
        mode: "STANDARD", manualTestCodes: ["CBC", "URINE", "STOOL"], peConfirmedTestCodes: [], externalProvider: null,
      });
    },
  );

  it.each([
    { yearLevel: 1, schedulingCategory: "REGULAR", isOvpsaFirstYear: false },
    { yearLevel: 4, schedulingCategory: "OJT", isOvpsaFirstYear: true },
    { yearLevel: null, schedulingCategory: "REGULAR", isOvpsaFirstYear: false },
    { yearLevel: 5, schedulingCategory: "REGULAR", isOvpsaFirstYear: false },
    { yearLevel: 2, schedulingCategory: null, isOvpsaFirstYear: false },
    { yearLevel: 3, schedulingCategory: "UNKNOWN", isOvpsaFirstYear: false },
  ])("fails closed for missing or inconsistent immutable provenance: %j", (context) => {
    expect(() => resolveLaboratoryCompletionPolicy(context)).toThrow(expect.objectContaining({ code: "LABORATORY_PROVENANCE_MISSING", status: 409 }));
  });
});
