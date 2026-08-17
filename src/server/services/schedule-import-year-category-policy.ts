import { AppError } from "@/lib/errors";

export type ScheduleImportMode = "STANDARD" | "FIRST_YEAR_OVPSA";
export type ScheduleImportStudentCategory = "REGULAR" | "OJT" | "TOUR";
export type SupportedScheduleImportYearLevel = 1 | 2 | 3 | 4;

export type ScheduleImportYearCategoryInput = {
  rows: Array<{ yearLevel: number }>;
  importMode: ScheduleImportMode;
  studentCategory: ScheduleImportStudentCategory;
};

const unsupportedYearMessage =
  "Invalid year level detected. Schedule imports only support Year 1, Year 2, Year 3, and Year 4 students. Please correct the CSV before continuing.";
const mixedYearMessage =
  "Mixed year levels detected. Each CSV import must contain students from only one year level. Please separate the students into different CSV files before importing.";

function policyError(field: "file" | "studentCategory", message: string): never {
  throw new AppError(
    "CSV_IMPORT_INVALID",
    "Please correct the CSV import errors.",
    422,
    { [field]: [message] },
  );
}

export function validateScheduleImportYearCategory(
  input: ScheduleImportYearCategoryInput,
): { yearLevel: SupportedScheduleImportYearLevel } {
  const yearLevels = input.rows.map((row) => row.yearLevel);
  if (yearLevels.some((yearLevel) => !Number.isInteger(yearLevel) || yearLevel < 1 || yearLevel > 4)) {
    policyError("file", unsupportedYearMessage);
  }

  const distinctYearLevels = new Set(yearLevels as SupportedScheduleImportYearLevel[]);
  if (distinctYearLevels.size !== 1) {
    policyError("file", mixedYearMessage);
  }

  const yearLevel = [...distinctYearLevels][0];
  const firstYearIntent = input.importMode === "FIRST_YEAR_OVPSA";
  const allowed = firstYearIntent
    ? yearLevel === 1
    : (yearLevel === 2 && input.studentCategory === "REGULAR")
      || (yearLevel === 3 && ["REGULAR", "TOUR"].includes(input.studentCategory))
      || (yearLevel === 4 && input.studentCategory === "OJT");

  if (!allowed) {
    const message = yearLevel === 1
      ? "This CSV contains Year 1 students. Select First Year in Student category before continuing."
      : yearLevel === 2
        ? "This CSV contains Year 2 students. Year 2 students can only be imported as Regular."
        : yearLevel === 3
          ? "This CSV contains Year 3 students. Select Regular or Tour before continuing."
          : "This CSV contains Year 4 students. Year 4 students can only be imported as OJT.";
    policyError("studentCategory", message);
  }

  return { yearLevel };
}
