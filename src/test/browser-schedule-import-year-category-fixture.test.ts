import { describe, expect, it } from "vitest";
import {
  scheduleImportYearCategoryCsvFiles,
  scheduleImportYearCategoryStudentNumbers,
} from "../../scripts/browser-schedule-import-year-category-fixture";

const headers = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";

describe("schedule import year/category Browser fixture", () => {
  it("provides the unsupported, mixed, and valid active-category CSVs", () => {
    expect(Object.keys(scheduleImportYearCategoryCsvFiles)).toEqual([
      "year-5-unsupported.csv",
      "mixed-year-2-4.csv",
      "year-4-ojt.csv",
      "year-3-regular.csv",
      "year-3-tour.csv",
    ]);
    expect(Object.values(scheduleImportYearCategoryCsvFiles).every((csv) => csv.startsWith(`${headers}\r\n`))).toBe(true);
    expect(scheduleImportYearCategoryCsvFiles["year-5-unsupported.csv"]).toContain(",5,");
    expect(scheduleImportYearCategoryCsvFiles["mixed-year-2-4.csv"]).toContain(",2,");
    expect(scheduleImportYearCategoryCsvFiles["mixed-year-2-4.csv"]).toContain(",4,");
    expect(scheduleImportYearCategoryCsvFiles["year-4-ojt.csv"]).toContain(",4,");
    expect(scheduleImportYearCategoryCsvFiles["year-3-regular.csv"]).toContain(",3,");
    expect(scheduleImportYearCategoryCsvFiles["year-3-tour.csv"]).toContain(",3,");
  });

  it("uses unique collegiate fixture identities without the retired category", () => {
    expect(new Set(scheduleImportYearCategoryStudentNumbers).size).toBe(
      scheduleImportYearCategoryStudentNumbers.length,
    );
    expect(scheduleImportYearCategoryStudentNumbers.every((studentNumber) => (
      /^\d{2}-\d{4}-\d{2}$/.test(studentNumber)
    ))).toBe(true);
    expect(Object.values(scheduleImportYearCategoryCsvFiles).join("\n")).not.toMatch(/specialized/i);
  });
});
