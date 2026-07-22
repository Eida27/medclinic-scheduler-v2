import { TextDecoder } from "node:util";
import { describe, expect, it } from "vitest";
import { parseStudentImportCsv } from "../server/services/student-import-csv";
import {
  baselineRowsMatch,
  createWindows1252Variant,
  differenceIds,
  inspectApprovedCsv,
  requiredProgramReferences,
  resultStorageDirectories,
} from "../../scripts/browser-clinic-scheduler-ux-fixture";

const csv = [
  "\uFEFFStudent ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth,,",
  "23-8200-01,Abad,Aaron Miguel,A.,,College of Computer Studies,BSCS,3,08-04-2004,,",
  "23-8300-01,Abalos,Alicia Mae,A.,,College of Computer Studies,BSDMIA,3,10-03-2005,,",
].join("\r\n");

describe("browser clinic scheduler UX fixture helpers", () => {
  it("requires the approved UTF-8 BOM and expected accepted-row count", () => {
    const bytes = Buffer.from(csv, "utf8");

    expect(inspectApprovedCsv(bytes, 2)).toMatchObject({
      bomHex: "efbbbf",
      acceptedRows: 2,
      studentNumbers: ["23-8200-01", "23-8300-01"],
    });
    expect(() => inspectApprovedCsv(bytes.subarray(3), 2)).toThrow(/UTF-8 BOM/);
    expect(() => inspectApprovedCsv(bytes, 3)).toThrow(/3 accepted rows/);
  });

  it("creates a nine-column Windows-1252 variant with exactly one Peña value", () => {
    const variant = createWindows1252Variant(Buffer.from(csv, "utf8"), 2);

    expect(variant.peñaCount).toBe(1);
    expect(variant.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect([...variant.bytes].filter((byte) => byte === 0xf1)).toHaveLength(1);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(variant.bytes)).toThrow();
    expect(parseStudentImportCsv(variant.bytes)).toHaveLength(2);
    expect(parseStudentImportCsv(variant.bytes)[0].surname).toBe("Peña");
    expect(new TextDecoder("windows-1252").decode(variant.bytes).split("\r\n")[0].split(",")).toHaveLength(9);
  });

  it("subtracts baseline IDs before cleanup targets are selected", () => {
    expect(differenceIds(["existing", "created-a", "created-b"], ["existing"]))
      .toEqual(["created-a", "created-b"]);
  });

  it("derives only unique top-level private-storage directories from result files", () => {
    expect(resultStorageDirectories([
      { id: "one", storageKey: "submission-a/lab.pdf" },
      { id: "two", storageKey: "submission-a/exam.pdf" },
      { id: "three", storageKey: "submission-b/result.png" },
    ])).toEqual(["submission-a", "submission-b"]);
  });

  it("deduplicates the college and course references required by the approved rows", () => {
    const rows = parseStudentImportCsv(Buffer.from(csv, "utf8"));
    rows[1].courseCode = rows[0].courseCode;

    expect(requiredProgramReferences(rows)).toEqual([
      { collegeName: "College of Computer Studies", courseCode: "BSCS" },
    ]);
  });

  it("compares captured baseline rows independent of query order", () => {
    expect(baselineRowsMatch(
      [{ id: "b", value: 2 }, { id: "a", value: 1 }],
      [{ id: "a", value: 1 }, { id: "b", value: 2 }],
      "id",
    )).toBe(true);
    expect(baselineRowsMatch([{ id: "a", value: 1 }], [{ id: "a", value: 2 }], "id"))
      .toBe(false);
  });
});
