import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const { assertImportAcademicYear } = vi.hoisted(() => ({ assertImportAcademicYear: vi.fn() }));
vi.mock("./academic-years.service", () => ({ assertImportAcademicYear }));
import { acceptAndScheduleImport, preflightScheduleImport } from "./schedule-imports.service";

const admin = {
  userId: "admin-user",
  fullName: "System Admin",
  email: "admin@example.test",
  role: "ADMIN" as const,
};

describe("schedule import request boundary", () => {
  it("rejects a valid CSV when its academic year was never configured", async () => {
    assertImportAcademicYear.mockRejectedValueOnce(new AppError("ACADEMIC_YEAR_NOT_CONFIGURED",
      "Select a configured academic year.", 409,
      { academicYearStart: ["Select a configured academic year."] }));
    const contents = [
      "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
      "23-1212-97,Abad,Aaron,Abella,,College of Computer Studies,BSIT,3,2004-08-04",
    ].join("\n");
    await expect(preflightScheduleImport({
      fileName: "students.csv", fileSize: Buffer.byteLength(contents), contents,
      importMode: "STANDARD", studentCategory: "REGULAR", academicYearStart: 2099,
      preferredMonth: null,
    }, admin)).rejects.toMatchObject({
      code: "ACADEMIC_YEAR_NOT_CONFIGURED",
      fields: { academicYearStart: expect.any(Array) },
    });
  });
  it("keeps XLSX uploads outside the CSV import contract", async () => {
    await expect(acceptAndScheduleImport({
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
