import { describe, expect, it } from "vitest";
import { studentInputSchema } from "./students.service";

const validStudent = {
  studentNumber: " 24-1000-01 ",
  firstName: " Ana ",
  middleName: " ",
  lastName: " Santos ",
  suffix: " ",
  collegeId: "10000000-0000-4000-8000-000000000003",
  programId: "20000000-0000-4000-8000-000000000003",
  yearLevel: 2,
  section: " B ",
};

describe("studentInputSchema", () => {
  it("normalizes identifiers, names, and optional blank values", () => {
    expect(studentInputSchema.parse(validStudent)).toMatchObject({
      studentNumber: "24-1000-01",
      firstName: "Ana",
      middleName: null,
      lastName: "Santos",
      suffix: null,
      section: "B",
    });
  });

  it("rejects a year level outside the supported range", () => {
    expect(() => studentInputSchema.parse({ ...validStudent, yearLevel: 7 })).toThrow();
  });
});
