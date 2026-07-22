import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parseStudentImportCsv } from "./student-import-csv";

const header = [
  "Student ID",
  "Surname",
  "First Name",
  "MI",
  "Suffix",
  "College",
  "Course",
  "Year",
  "Date of Birth",
].join(",");

function fieldsFrom(input: string | Uint8Array) {
  try {
    parseStudentImportCsv(input);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "CSV_IMPORT_INVALID", status: 422 });
    return (error as AppError).fields;
  }
  throw new Error("Expected CSV parsing to fail.");
}

describe("parseStudentImportCsv", () => {
  const validRow = "23-1212-97,Abad,Aaron,,,College of Computer Studies,BSIT,3,08-04-2004";

  it("parses the exact nine-column workbook export and nullable MI and suffix", () => {
    const input = [
      header,
      "23-1212-97,Abad,Aaron Miguel,A.,,College of Computer Studies,BSIT,3,08-04-2004",
      "24-0001-01,Santos,Ana,,Jr.,College of Nursing,BSN,2,01-31-2005",
    ].join("\n");

    expect(parseStudentImportCsv(input)).toEqual([
      {
        rowNumber: 2,
        studentNumber: "23-1212-97",
        surname: "Abad",
        firstName: "Aaron Miguel",
        middleInitial: "A.",
        suffix: null,
        collegeName: "College of Computer Studies",
        courseCode: "BSIT",
        yearLevel: 3,
        dateOfBirth: "2004-08-04",
      },
      {
        rowNumber: 3,
        studentNumber: "24-0001-01",
        surname: "Santos",
        firstName: "Ana",
        middleInitial: null,
        suffix: "Jr.",
        collegeName: "College of Nursing",
        courseCode: "BSN",
        yearLevel: 2,
        dateOfBirth: "2005-01-31",
      },
    ]);
  });

  it("requires the approved exact header order", () => {
    expect(fieldsFrom([
      header.replace("Surname,First Name", "First Name,Surname"),
      "23-1212-97,Aaron,Abad,,,College of Computer Studies,BSIT,3,08-04-2004",
    ].join("\n"))).toEqual({
      file: [`CSV headers must exactly match: ${header}.`],
    });
  });

  it("rejects malformed CSV", () => {
    expect(fieldsFrom([
      header,
      '23-1212-97,"Abad,Aaron,,,College of Computer Studies,BSIT,3,08-04-2004',
    ].join("\n"))).toEqual({
      file: ["The file is not valid CSV."],
    });
  });

  it("parses UTF-8 bytes without a BOM", () => {
    const bytes = new TextEncoder().encode([header, validRow].join("\n"));

    expect(parseStudentImportCsv(bytes)).toHaveLength(1);
  });

  it("parses UTF-8 bytes with a BOM", () => {
    const contents = new TextEncoder().encode([header, validRow].join("\n"));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...contents]);

    expect(parseStudentImportCsv(bytes)).toHaveLength(1);
  });

  it("falls back to Windows-1252 for standard Excel CSV bytes", () => {
    const contents = [
      header,
      "23-1212-97,Peña,Aaron,,,College of Computer Studies,BSIT,3,08-04-2004",
    ].join("\n");
    const bytes = Uint8Array.from(contents, (character) => character.charCodeAt(0));

    expect(parseStudentImportCsv(bytes)[0].surname).toBe("Peña");
  });

  it("rejects malformed IDs and impossible or future birth dates", () => {
    expect(fieldsFrom([
      header,
      "S-1,Abad,Aaron,,,College of Computer Studies,BSIT,3,02-29-2023",
      "23-1212-98,Cruz,Bea,,,College of Computer Studies,BSIT,3,12-31-9999",
    ].join("\n"))).toEqual({
      "rows.2.Student ID": ["Student ID must use the NN-NNNN-NN format."],
      "rows.2.Date of Birth": ["Date of Birth must be a valid past or present date in MM-DD-YYYY format."],
      "rows.3.Date of Birth": ["Date of Birth must be a valid past or present date in MM-DD-YYYY format."],
    });
  });

  it("reports every duplicate Student ID row", () => {
    expect(fieldsFrom([
      header,
      "23-1212-97,Abad,Aaron,,,College of Computer Studies,BSIT,3,08-04-2004",
      "23-1212-97,Abad,Aaron,,,College of Computer Studies,BSIT,3,08-04-2004",
    ].join("\n"))).toEqual({
      "rows.2.Student ID": ["This student ID also appears in row 3."],
      "rows.3.Student ID": ["This student ID also appears in row 2."],
    });
  });

  it("keeps the 3,000-row limit and accepts UTF-8 byte input", () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => {
      const middle = String(Math.floor(index / 100) % 100).padStart(2, "0");
      const tail = String(index % 100).padStart(2, "0");
      return `23-${middle}${tail}-${tail},Surname${index},First${index},,,College of Computer Studies,BSIT,3,08-04-2004`;
    });
    const bytes = new TextEncoder().encode([header, ...rows].join("\n"));
    expect(parseStudentImportCsv(bytes)).toHaveLength(3_000);

    expect(fieldsFrom(new TextEncoder().encode([header, ...rows, rows[0].replace("23-", "24-")].join("\n"))))
      .toEqual({ file: ["CSV files may contain at most 3,000 data rows."] });
  });
});
