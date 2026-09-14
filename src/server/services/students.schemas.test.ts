import { describe, expect, it } from "vitest";
import { studentInputSchema } from "./students.service";

const validStudent = {
  studentNumber: " 24-1000-01 ",
  firstName: " Ana ",
  middleName: " Maria Angela ",
  lastName: " Santos ",
  suffix: " ",
  collegeId: "10000000-0000-4000-8000-000000000003",
  programId: "20000000-0000-4000-8000-000000000003",
  yearLevel: 2,
  section: " B ",
  dateOfBirth: "2004-08-04",
};

describe("studentInputSchema", () => {
  it("normalizes identifiers, names, and optional blank values", () => {
    expect(studentInputSchema.parse(validStudent)).toMatchObject({
      studentNumber: "24-1000-01",
      firstName: "Ana",
      middleName: "Maria Angela",
      lastName: "Santos",
      suffix: null,
      section: "B",
      dateOfBirth: "2004-08-04",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("rejects a %s middle name with a field-specific error", (_label, middleName) => {
    const input = { ...validStudent } as Record<string, unknown>;
    if (middleName === undefined) delete input.middleName;
    else input.middleName = middleName;

    const result = studentInputSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.middleName).toBeDefined();
    }
  });

  it("counts Unicode code points consistently with CSV and PostgreSQL limits", () => {
    expect(studentInputSchema.parse({
      ...validStudent,
      middleName: ` ${"😀".repeat(100)} `,
    }).middleName).toBe("😀".repeat(100));

    const result = studentInputSchema.safeParse({
      ...validStudent,
      middleName: "😀".repeat(101),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.middleName).toEqual([
        "Middle name must contain at most 100 characters.",
      ]);
    }
  });

  it("rejects a year level outside the supported range", () => {
    expect(() => studentInputSchema.parse({ ...validStudent, yearLevel: 7 })).toThrow();
  });

  it("rejects a future date of birth", () => {
    expect(() => studentInputSchema.parse({ ...validStudent, dateOfBirth: "9999-12-31" })).toThrow();
  });
});
