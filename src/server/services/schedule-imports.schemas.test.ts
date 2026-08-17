import { describe, expect, it } from "vitest";
import {
  importNameFromFileName,
  importStudentScheduleCsv,
  preflightScheduleImport,
} from "./schedule-imports.service";

const admin = {
  userId: "admin-user",
  fullName: "System Admin",
  email: "admin@example.test",
  role: "ADMIN" as const,
};

describe("importNameFromFileName", () => {
  it("derives a normalized name from the CSV filename", () => {
    expect(importNameFromFileName("  First   Semester Schedules.csv  ")).toBe("First Semester Schedules");
  });

  it("uses a stable fallback for filename stems shorter than three characters", () => {
    expect(importNameFromFileName("a.csv")).toBe("Schedule import");
    expect(importNameFromFileName(".csv")).toBe("Schedule import");
  });

  it("truncates names to the database limit by Unicode character", () => {
    const name = importNameFromFileName(`${"😀".repeat(160)}.csv`);

    expect(Array.from(name)).toHaveLength(150);
  });

  it("keeps XLSX uploads outside the CSV import contract", async () => {
    await expect(importStudentScheduleCsv({
      fileName: "student-schedule-import-template.xlsx",
      fileSize: 4,
      contents: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      studentCategory: "REGULAR",
      academicYearStart: 2026,
      preferredMonth: null,
    }, admin)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      status: 422,
      fields: { file: ["Choose a file with a .csv extension."] },
    });
  });

  it("rejects the retired Specialized category before policy evaluation", async () => {
    const contents = [
      "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
      "23-1212-97,Abad,Aaron,Abella,,College of Computer Studies,BSIT,3,2004-08-04",
    ].join("\n");

    await expect(preflightScheduleImport({
      fileName: "students.csv",
      fileSize: Buffer.byteLength(contents),
      contents,
      importMode: "STANDARD",
      studentCategory: "SPECIALIZED",
      academicYearStart: 2026,
      preferredMonth: 9,
    }, admin)).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
