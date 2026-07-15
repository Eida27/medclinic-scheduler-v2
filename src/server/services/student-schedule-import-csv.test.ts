import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parseStudentScheduleCsv } from "./student-schedule-import-csv";

const header = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
].join(",");

type CsvInput = Parameters<typeof parseStudentScheduleCsv>[0];

function fieldsFrom(input: CsvInput) {
  try {
    parseStudentScheduleCsv(input);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "CSV_IMPORT_INVALID", status: 422 });
    return (error as AppError).fields;
  }
  throw new Error("Expected CSV parsing to fail.");
}

describe("parseStudentScheduleCsv", () => {
  it("parses the exact seven-column template and canonicalizes a quoted name and both dates", () => {
    const csv = [
      header,
      'S-001,"Abad, Aaron Miguel A.",College of Computing,BSIT,3,06-19-2026,06-20-2026',
    ].join("\n");

    expect(parseStudentScheduleCsv(csv)).toEqual([
      {
        rowNumber: 2,
        studentNumber: "S-001",
        rawName: "Abad, Aaron Miguel A.",
        firstName: "Aaron",
        middleName: "Miguel A.",
        lastName: "Abad",
        suffix: null,
        collegeName: "College of Computing",
        courseCode: "BSIT",
        yearLevel: 3,
        laboratoryDate: "2026-06-19",
        physicalExaminationDate: "2026-06-20",
      },
    ]);
  });

  it("accepts BOM, CRLF, surrounding whitespace, punctuation, repeated name whitespace, and byte inputs", () => {
    const csv = [
      `\uFEFF ${header.split(",").join(" , ")} `,
      ` S-002 , "O'Neil-Santos,   Ana-Maria    L." , College of Computing , BSIT , 2 , , 07-01-2026 `,
      "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(csv);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const expected = [
      {
        rowNumber: 2,
        studentNumber: "S-002",
        rawName: "O'Neil-Santos, Ana-Maria L.",
        firstName: "Ana-Maria",
        middleName: "L.",
        lastName: "O'Neil-Santos",
        suffix: null,
        collegeName: "College of Computing",
        courseCode: "BSIT",
        yearLevel: 2,
        laboratoryDate: null,
        physicalExaminationDate: "2026-07-01",
      },
    ];

    expect(parseStudentScheduleCsv(bytes)).toEqual(expected);
    expect(parseStudentScheduleCsv(arrayBuffer)).toEqual(expected);
  });

  it("allows either schedule date to be blank while preserving the other date", () => {
    const csv = [
      header,
      'S-003,"Santos, Bea",College of Computing,BSIT,1,,07-02-2026',
      'S-004,"Reyes, Carlo",College of Computing,BSIT,4,07-03-2026,',
    ].join("\n");

    expect(parseStudentScheduleCsv(csv).map(({ laboratoryDate, physicalExaminationDate }) => ({
      laboratoryDate,
      physicalExaminationDate,
    }))).toEqual([
      { laboratoryDate: null, physicalExaminationDate: "2026-07-02" },
      { laboratoryDate: "2026-07-03", physicalExaminationDate: null },
    ]);
  });

  it("reports both schedule fields when both dates are blank", () => {
    expect(fieldsFrom([
      header,
      'S-005,"Cruz, Dana",College of Computing,BSIT,2,,',
    ].join("\n"))).toEqual({
      "rows.2.Laboratory Schedule": ["At least one schedule date is required."],
      "rows.2.Physical Examination Schedule": ["At least one schedule date is required."],
    });
  });

  it("rejects names missing the comma, surname, or given name", () => {
    expect(fieldsFrom([
      header,
      "S-006,Aaron Abad,College of Computing,BSIT,2,07-04-2026,",
      'S-007,", Aaron",College of Computing,BSIT,2,07-04-2026,',
      'S-008,"Abad,",College of Computing,BSIT,2,07-04-2026,',
    ].join("\n"))).toEqual({
      "rows.2.Name": ['Name must use "Last, First Middle" format with a surname and given name.'],
      "rows.3.Name": ['Name must use "Last, First Middle" format with a surname and given name.'],
      "rows.4.Name": ['Name must use "Last, First Middle" format with a surname and given name.'],
    });
  });

  it("reports malformed and impossible dates for each schedule column", () => {
    expect(fieldsFrom([
      header,
      'S-009,"Dela Rosa, Eli",College of Computing,BSIT,2,7-05-2026,07-06-2026',
      'S-010,"Flores, Faye",College of Computing,BSIT,2,02-30-2026,07-06-2026',
      'S-011,"Garcia, Gio",College of Computing,BSIT,2,07-05-2026,7-06-2026',
      'S-012,"Hernandez, Hope",College of Computing,BSIT,2,07-05-2026,02-30-2026',
    ].join("\n"))).toEqual({
      "rows.2.Laboratory Schedule": [
        "Laboratory Schedule must be a valid date in MM-DD-YYYY format.",
      ],
      "rows.3.Laboratory Schedule": [
        "Laboratory Schedule must be a valid date in MM-DD-YYYY format.",
      ],
      "rows.4.Physical Examination Schedule": [
        "Physical Examination Schedule must be a valid date in MM-DD-YYYY format.",
      ],
      "rows.5.Physical Examination Schedule": [
        "Physical Examination Schedule must be a valid date in MM-DD-YYYY format.",
      ],
    });
  });

  it("accepts possible four-digit dates before year 100", () => {
    const rows = parseStudentScheduleCsv([
      header,
      'S-012A,"Historic, Hope",College of Computing,BSIT,2,01-02-0099,',
    ].join("\n"));

    expect(rows[0].laboratoryDate).toBe("0099-01-02");
  });

  it("requires the exact logical headers in order", () => {
    expect(fieldsFrom([
      "Name,Student ID,College,Course,Year,Laboratory Schedule,Physical Examination Schedule",
      '"Abad, Aaron",S-013,College of Computing,BSIT,2,07-05-2026,',
    ].join("\n"))).toEqual({
      file: [
        "CSV headers must exactly match: Student ID, Name, College, Course, Year, Laboratory Schedule, Physical Examination Schedule.",
      ],
    });
  });

  it("rejects a data row with a missing logical column", () => {
    expect(fieldsFrom([
      header,
      'S-014,"Ibarra, Ian",College of Computing,BSIT,2,07-05-2026',
    ].join("\n"))).toEqual({
      "rows.2": ["Row must contain exactly 7 columns."],
    });
  });

  it("accepts rightmost blank extra cells on headers and data rows without dropping the seventh cell", () => {
    const rows = parseStudentScheduleCsv([
      `${header},,,`,
      'S-015,"Jacinto, Jules",College of Computing,BSIT,2,07-05-2026,,,,',
    ].join("\n"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      laboratoryDate: "2026-07-05",
      physicalExaminationDate: null,
    });
  });

  it("rejects a non-empty extra cell", () => {
    expect(fieldsFrom([
      header,
      'S-016,"Katipunan, Kai",College of Computing,BSIT,2,07-05-2026,,unexpected,',
    ].join("\n"))).toEqual({
      "rows.2": ["Row must contain exactly 7 columns."],
    });
  });

  it("rejects malformed CSV", () => {
    expect(fieldsFrom(`${header}\nS-017,"Unclosed name,College of Computing,BSIT,2,07-05-2026,`)).toEqual({
      file: ["The file is not valid CSV."],
    });
  });

  it("rejects malformed UTF-8 bytes", () => {
    expect(fieldsFrom(new Uint8Array([0xc3, 0x28]))).toEqual({
      file: ["The file must be valid UTF-8."],
    });
  });

  it("collects student ID, reference, and year validation errors", () => {
    const longCollege = "C".repeat(151);
    const longCourse = "P".repeat(51);
    const longStudentId = "S".repeat(21);

    expect(fieldsFrom([
      header,
      `x,"Luna, Luz",,${longCourse},0,07-05-2026,`,
      `${longStudentId},"Mabini, Mara",${longCollege},,7,07-05-2026,`,
      'S-019,"Narra, Nico",College of Computing,BSIT,2.5,07-05-2026,',
    ].join("\n"))).toEqual({
      "rows.2.Student ID": ["Student ID must contain 3 to 20 characters."],
      "rows.2.College": ["College is required."],
      "rows.2.Course": ["Course must contain at most 50 characters."],
      "rows.2.Year": ["Year must be a whole number from 1 to 6."],
      "rows.3.Student ID": ["Student ID must contain 3 to 20 characters."],
      "rows.3.College": ["College must contain at most 150 characters."],
      "rows.3.Course": ["Course is required."],
      "rows.3.Year": ["Year must be a whole number from 1 to 6."],
      "rows.4.Year": ["Year must be a whole number from 1 to 6."],
    });
  });

  it("enforces database-aligned limits for every canonical name component", () => {
    const tooLong = "N".repeat(101);

    expect(fieldsFrom([
      header,
      `S-020,"Family, ${tooLong}",College of Computing,BSIT,2,07-05-2026,`,
      `S-021,"Family, Given ${tooLong}",College of Computing,BSIT,2,07-05-2026,`,
      `S-022,"${tooLong}, Given",College of Computing,BSIT,2,07-05-2026,`,
    ].join("\n"))).toEqual({
      "rows.2.Name": ["First name must contain at most 100 characters."],
      "rows.3.Name": ["Middle name must contain at most 100 characters."],
      "rows.4.Name": ["Last name must contain at most 100 characters."],
    });
  });

  it("counts non-BMP text by database characters at exact field limits", () => {
    const character = "😀";
    const studentNumber = character.repeat(20);
    const firstName = character.repeat(100);
    const middleName = character.repeat(100);
    const lastName = character.repeat(100);
    const collegeName = character.repeat(150);
    const courseCode = character.repeat(50);
    const csv = [
      header,
      `${studentNumber},"${lastName}, ${firstName} ${middleName}",${collegeName},${courseCode},2,07-05-2026,`,
    ].join("\n");

    expect(parseStudentScheduleCsv(csv)[0]).toMatchObject({
      studentNumber,
      firstName,
      middleName,
      lastName,
      collegeName,
      courseCode,
    });
  });

  it("rejects repeated student IDs case-insensitively even when rows have complementary dates", () => {
    expect(fieldsFrom([
      header,
      'Case-023,"Osmena, Opal",College of Computing,BSIT,2,07-05-2026,',
      'case-023,"Osmena, Opal",College of Computing,BSIT,2,,07-06-2026',
    ].join("\n"))).toEqual({
      "rows.3.Student ID": ["This student ID already appears in row 2."],
    });
  });

  it("rejects Unicode upper/lowercase variants of the same student ID", () => {
    const lowercaseSharpS = "A\u00df1";
    const uppercaseSharpS = "A\u1e9e1";

    expect(fieldsFrom([
      header,
      `${lowercaseSharpS},"Rivera, Ria",College of Computing,BSIT,2,07-05-2026,`,
      `${uppercaseSharpS},"Rivera, Ria",College of Computing,BSIT,2,,07-06-2026`,
    ].join("\n"))).toEqual({
      "rows.3.Student ID": ["This student ID already appears in row 2."],
    });
  });

  it("keeps distinct Unicode student IDs separate when uppercase mapping is lossy", () => {
    const latinI = "Ai1";
    const dotlessI = "A\u01311";
    const rows = parseStudentScheduleCsv([
      header,
      `${latinI},"Salazar, Sol",College of Computing,BSIT,2,07-05-2026,`,
      `${dotlessI},"Torres, Tala",College of Computing,BSIT,2,07-06-2026,`,
    ].join("\n"));

    expect(rows.map((row) => row.studentNumber)).toEqual([latinI, dotlessI]);
  });

  it("reports repeated student IDs even when either occurrence has an invalid column count", () => {
    expect(fieldsFrom([
      header,
      'Width-A,"Panganiban, Pia",College of Computing,BSIT,2,07-05-2026,,unexpected',
      'width-a,"Panganiban, Pia",College of Computing,BSIT,2,,07-06-2026',
      'Width-B,"Quirino, Quin",College of Computing,BSIT,2,07-05-2026,',
      'WIDTH-B,"Quirino, Quin",College of Computing,BSIT,2,07-06-2026',
    ].join("\n"))).toEqual({
      "rows.2": ["Row must contain exactly 7 columns."],
      "rows.3.Student ID": ["This student ID already appears in row 2."],
      "rows.5.Student ID": ["This student ID already appears in row 4."],
      "rows.5": ["Row must contain exactly 7 columns."],
    });
  });

  it("accepts exactly 3,000 data rows", () => {
    const dataRows = Array.from({ length: 3_000 }, (_, index) => (
      `ID-${String(index).padStart(4, "0")},"Student${index}, Given",College of Computing,BSIT,3,07-05-2026,`
    ));

    expect(parseStudentScheduleCsv([header, ...dataRows].join("\n"))).toHaveLength(3_000);
  });

  it("rejects 3,001 data rows", () => {
    const dataRows = Array.from({ length: 3_001 }, (_, index) => (
      `ID-${String(index).padStart(4, "0")},"Student${index}, Given",College of Computing,BSIT,3,07-05-2026,`
    ));

    expect(fieldsFrom([header, ...dataRows].join("\n"))).toEqual({
      file: ["CSV files may contain at most 3,000 data rows."],
    });
  });

  it("requires at least one data row", () => {
    expect(fieldsFrom(`${header}\n\n`)).toEqual({
      file: ["CSV file must include the header and at least one data row."],
    });
  });
});
