import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parseCoordinatorScheduleCsv } from "./coordinator-schedule-csv";

const header = "Student ID,Name,College,Course,Year,Appointment Date,Appointment Type";

function fieldsFrom(csv: string) {
  try {
    parseCoordinatorScheduleCsv(csv);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).fields;
  }
  throw new Error("Expected CSV parsing to fail.");
}

describe("parseCoordinatorScheduleCsv", () => {
  it("parses the exact coordinator template and normalizes its values", () => {
    const csv = [
      "\uFEFFStudent ID,Name,College,Course,Year,Appointment Date,Appointment Type",
      '23-0001-01,"Juan, Jr. Dela Cruz",College of Computer Studies,BSIT,3,06-19-2026,Physical Examination',
      "23-0001-02,Maria Santos,College of Computer Studies,BSIT,4,06-20-2026,Laboratory",
      "23-0001-03,Jose Reyes,College of Computer Studies,BSIT,1,06-21-2026,Physical + Laboratory",
      "",
    ].join("\r\n");

    expect(parseCoordinatorScheduleCsv(csv)).toEqual([
      {
        rowNumber: 2,
        studentNumber: "23-0001-01",
        fullName: "Juan, Jr. Dela Cruz",
        firstName: "Juan,",
        lastName: "Jr. Dela Cruz",
        collegeName: "College of Computer Studies",
        courseCode: "BSIT",
        yearLevel: 3,
        targetDate: "2026-06-19",
        scheduleType: "PHYSICAL_EXAM",
      },
      {
        rowNumber: 3,
        studentNumber: "23-0001-02",
        fullName: "Maria Santos",
        firstName: "Maria",
        lastName: "Santos",
        collegeName: "College of Computer Studies",
        courseCode: "BSIT",
        yearLevel: 4,
        targetDate: "2026-06-20",
        scheduleType: "LABORATORY",
      },
      {
        rowNumber: 4,
        studentNumber: "23-0001-03",
        fullName: "Jose Reyes",
        firstName: "Jose",
        lastName: "Reyes",
        collegeName: "College of Computer Studies",
        courseCode: "BSIT",
        yearLevel: 1,
        targetDate: "2026-06-21",
        scheduleType: "BOTH",
      },
    ]);
  });

  it("rejects headers that do not exactly match the coordinator template", () => {
    const fields = fieldsFrom([
      "Name,Student ID,College,Course,Year,Appointment Date,Appointment Type",
      "Maria Santos,23-0001-02,College of Computer Studies,BSIT,3,06-19-2026,Laboratory",
    ].join("\n"));

    expect(fields).toEqual({
      file: [
        "CSV headers must exactly match: Student ID, Name, College, Course, Year, Appointment Date, Appointment Type.",
      ],
    });
  });

  it("returns row-and-column errors for invalid values", () => {
    const fields = fieldsFrom([
      header,
      "x,Prince,College of Computer Studies,BSIT,7,02-30-2026,Consultation",
    ].join("\n"));

    expect(fields).toEqual({
      "rows.2.Student ID": ["Student ID must contain 3 to 20 characters."],
      "rows.2.Name": ["Name must contain a first name and last name."],
      "rows.2.Year": ["Year must be a whole number from 1 to 6."],
      "rows.2.Appointment Date": ["Appointment Date must be a valid date in MM-DD-YYYY format."],
      "rows.2.Appointment Type": [
        "Appointment Type must be Physical Examination, Laboratory, or Physical + Laboratory.",
      ],
    });
  });

  it("rejects overlapping service requests for the same student", () => {
    const fields = fieldsFrom([
      header,
      "23-0001-02,Maria Santos,College of Computer Studies,BSIT,3,06-19-2026,Physical Examination",
      "23-0001-02,Maria Santos,College of Computer Studies,BSIT,3,06-20-2026,Physical + Laboratory",
    ].join("\n"));

    expect(fields).toEqual({
      "rows.3.Appointment Type": ["This student already has a physical examination request in row 2."],
    });
  });

  it("allows separate non-overlapping services for the same student", () => {
    const rows = parseCoordinatorScheduleCsv([
      header,
      "23-0001-02,Maria Santos,College of Computer Studies,BSIT,3,06-19-2026,Physical Examination",
      "23-0001-02,Maria Santos,College of Computer Studies,BSIT,3,06-20-2026,Laboratory",
    ].join("\n"));

    expect(rows.map((row) => row.scheduleType)).toEqual(["PHYSICAL_EXAM", "LABORATORY"]);
  });

  it("rejects files containing more than 500 data rows", () => {
    const dataRows = Array.from({ length: 501 }, (_, index) => (
      `23-${String(index).padStart(4, "0")},Student ${index},College of Computer Studies,BSIT,3,06-19-2026,Laboratory`
    ));

    expect(fieldsFrom([header, ...dataRows].join("\n"))).toEqual({
      file: ["CSV files may contain at most 500 data rows."],
    });
  });
});
