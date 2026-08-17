import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  validateScheduleImportYearCategory,
  type ScheduleImportYearCategoryInput,
} from "./schedule-import-year-category-policy";

function input(
  yearLevels: number[],
  overrides: Partial<Omit<ScheduleImportYearCategoryInput, "rows">> = {},
): ScheduleImportYearCategoryInput {
  return {
    rows: yearLevels.map((yearLevel) => ({ yearLevel })),
    importMode: "STANDARD",
    studentCategory: "REGULAR",
    ...overrides,
  };
}

function expectPolicyError(
  value: ScheduleImportYearCategoryInput,
  field: "file" | "studentCategory",
  message: string,
) {
  try {
    validateScheduleImportYearCategory(value);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "CSV_IMPORT_INVALID",
      message: "Please correct the CSV import errors.",
      status: 422,
      fields: { [field]: [message] },
    });
    return;
  }
  throw new Error("Expected year/category validation to fail.");
}

describe("validateScheduleImportYearCategory", () => {
  it.each([
    { yearLevel: 1, importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR" },
    { yearLevel: 2, importMode: "STANDARD", studentCategory: "REGULAR" },
    { yearLevel: 3, importMode: "STANDARD", studentCategory: "REGULAR" },
    { yearLevel: 3, importMode: "STANDARD", studentCategory: "TOUR" },
    { yearLevel: 4, importMode: "STANDARD", studentCategory: "OJT" },
  ] as const)(
    "allows Year $yearLevel with $importMode/$studentCategory intent",
    ({ yearLevel, importMode, studentCategory }) => {
      expect(validateScheduleImportYearCategory(input(
        [yearLevel, yearLevel],
        { importMode, studentCategory },
      ))).toEqual({ yearLevel });
    },
  );

  it.each([
    { yearLevel: 1, importMode: "STANDARD", studentCategory: "REGULAR" },
    { yearLevel: 1, importMode: "STANDARD", studentCategory: "OJT" },
    { yearLevel: 1, importMode: "STANDARD", studentCategory: "TOUR" },
  ] as const)("rejects Year 1 outside First Year mode", ({ yearLevel, ...intent }) => {
    expectPolicyError(
      input([yearLevel], intent),
      "studentCategory",
      "This CSV contains Year 1 students. Select First Year in Student category before continuing.",
    );
  });

  it.each([
    { importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR" },
    { importMode: "STANDARD", studentCategory: "OJT" },
    { importMode: "STANDARD", studentCategory: "TOUR" },
  ] as const)("rejects invalid Year 2 intent $importMode/$studentCategory", (intent) => {
    expectPolicyError(
      input([2], intent),
      "studentCategory",
      "This CSV contains Year 2 students. Year 2 students can only be imported as Regular.",
    );
  });

  it.each([
    { importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR" },
    { importMode: "STANDARD", studentCategory: "OJT" },
  ] as const)("rejects invalid Year 3 intent $importMode/$studentCategory", (intent) => {
    expectPolicyError(
      input([3], intent),
      "studentCategory",
      "This CSV contains Year 3 students. Select Regular or Tour before continuing.",
    );
  });

  it.each([
    { importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR" },
    { importMode: "STANDARD", studentCategory: "REGULAR" },
    { importMode: "STANDARD", studentCategory: "TOUR" },
  ] as const)("rejects invalid Year 4 intent $importMode/$studentCategory", (intent) => {
    expectPolicyError(
      input([4], intent),
      "studentCategory",
      "This CSV contains Year 4 students. Year 4 students can only be imported as OJT.",
    );
  });

  it.each([0, 5, 6, -1])("rejects unsupported Year %s before other policy errors", (yearLevel) => {
    expectPolicyError(
      input([2, yearLevel], { studentCategory: "OJT" }),
      "file",
      "Invalid year level detected. Schedule imports only support Year 1, Year 2, Year 3, and Year 4 students. Please correct the CSV before continuing.",
    );
  });

  it("reports only mixed years before a category mismatch", () => {
    expectPolicyError(
      input([2, 4]),
      "file",
      "Mixed year levels detected. Each CSV import must contain students from only one year level. Please separate the students into different CSV files before importing.",
    );
  });
});
