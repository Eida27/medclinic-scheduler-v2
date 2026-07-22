import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseStudentImportCsv } from "../server/services/student-import-csv";
import {
  baselineRowsMatch,
  createWindows1252Variant,
  countCleanupResidue,
  differenceIds,
  EXPECTED_APPROVED_BYTE_LENGTH,
  EXPECTED_APPROVED_SHA256,
  inspectApprovedCsv,
  requiredProgramReferences,
  resultStorageDirectories,
  runPersistedCleanup,
  assertZeroCleanupResidue,
  validatePublishedImport,
  type CleanupManifest,
  type CleanupProgress,
  type CleanupResidue,
} from "../../scripts/browser-clinic-scheduler-ux-fixture";

const csv = [
  "\uFEFFStudent ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth,,",
  "23-8200-01,Abad,Aaron Miguel,A.,,College of Computer Studies,BSCS,3,08-04-2004,,",
  "23-8300-01,Abalos,Alicia Mae,A.,,College of Computer Studies,BSDMIA,3,10-03-2005,,",
].join("\r\n");

const emptyManifest: CleanupManifest = {
  imports: ["import-id"],
  batches: ["batch-id"],
  coordinatorItems: ["item-id"],
  createdStudents: ["23-8200-01"],
  appointments: ["appointment-id"],
  closures: [],
  submissions: ["submission-id"],
  resultFiles: [{ id: "file-id", storageKey: "submission-id/lab.pdf" }],
  laboratoryResults: ["lab-result-id"],
  examResults: ["exam-result-id"],
  statusLogs: ["status-log-id"],
  events: [],
  notifications: [],
  audits: [],
  verificationTokens: [],
  loginAttempts: [],
  outbox: [],
  referencePrograms: ["program-id"],
};

const zeroResidue = (): CleanupResidue => ({
  imports: 0,
  batches: 0,
  coordinatorItems: 0,
  students: 0,
  appointments: 0,
  closures: 0,
  submissions: 0,
  resultFiles: 0,
  laboratoryResults: 0,
  examResults: 0,
  statusLogs: 0,
  events: 0,
  notifications: 0,
  audits: 0,
  verificationTokens: 0,
  loginAttempts: 0,
  outbox: 0,
  referencePrograms: 0,
  privateStorageDirectories: 0,
});

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

  it("requires the exact approved source byte length and SHA-256", () => {
    const bytes = Buffer.from(csv, "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    expect(EXPECTED_APPROVED_BYTE_LENGTH).toBe(23_834);
    expect(EXPECTED_APPROVED_SHA256)
      .toBe("fa01469d107bd0401444b9f95f555ffaf68a4c116b4600af8142c15dca5d3c17");
    expect(inspectApprovedCsv(bytes, {
      expectedRows: 2,
      expectedByteLength: bytes.byteLength,
      expectedSha256,
    })).toMatchObject({ byteLength: bytes.byteLength, sha256: expectedSha256 });
    expect(() => inspectApprovedCsv(bytes, {
      expectedRows: 2,
      expectedByteLength: bytes.byteLength + 1,
      expectedSha256,
    })).toThrow(/byte length/i);
    expect(() => inspectApprovedCsv(bytes, {
      expectedRows: 2,
      expectedByteLength: bytes.byteLength,
      expectedSha256: "0".repeat(64),
    })).toThrow(/SHA-256/i);
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

  it("requires the complete 280-student import to be fully published before staging", () => {
    const complete = {
      importId: "import-id",
      importStatus: "PUBLISHED",
      totalRows: 280,
      processedStudentCount: 280,
      batchCount: 2,
      batchStatuses: ["PUBLISHED", "PUBLISHED"],
      coordinatorItemCount: 560,
      laboratoryItemCount: 280,
      physicalExamItemCount: 280,
      appointmentCount: 560,
      publishedAppointmentCount: 560,
      pendingAppointmentCount: 560,
      laboratoryAppointmentCount: 280,
      physicalExamAppointmentCount: 280,
      pairedStudentCount: 280,
    };

    expect(validatePublishedImport(complete)).toEqual(complete);
    expect(() => validatePublishedImport({
      ...complete,
      importStatus: "NEEDS_REVIEW",
      batchStatuses: ["PUBLISHED", "GENERATED"],
    })).toThrow(/fully published/i);
    expect(() => validatePublishedImport({
      ...complete,
      appointmentCount: 559,
      publishedAppointmentCount: 559,
      pairedStudentCount: 279,
    })).toThrow(/560 appointments/i);
  });

  it("retries private-file cleanup from persisted paths after database rows are gone", async () => {
    let persisted: CleanupProgress | undefined;
    let captureCalls = 0;
    let databaseDeleteCalls = 0;
    let fileDeleteCalls = 0;
    let failFileDeletion = true;
    const actions = {
      captureManifest: async () => {
        captureCalls += 1;
        return emptyManifest;
      },
      persist: async (progress: CleanupProgress) => {
        persisted = structuredClone(progress);
      },
      deleteDatabase: async () => {
        databaseDeleteCalls += 1;
      },
      deletePrivateFiles: async (directories: string[]) => {
        fileDeleteCalls += 1;
        expect(directories).toEqual(["submission-id"]);
        if (failFileDeletion) throw new Error("injected file deletion failure");
      },
      prove: async () => zeroResidue(),
    };

    await expect(runPersistedCleanup(undefined, actions))
      .rejects.toThrow("injected file deletion failure");
    expect(persisted).toMatchObject({
      phase: "DATABASE_DELETED",
      privateResultStorageKeys: ["submission-id/lab.pdf"],
      privateResultDirectories: ["submission-id"],
    });

    failFileDeletion = false;
    await expect(runPersistedCleanup(persisted, {
      ...actions,
      captureManifest: async () => {
        throw new Error("retry must use the persisted manifest");
      },
    })).resolves.toEqual(zeroResidue());
    expect(captureCalls).toBe(1);
    expect(databaseDeleteCalls).toBe(2);
    expect(fileDeleteCalls).toBe(2);
  });

  it("detects an orphan child by exact manifest ID after its roots are gone", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [{ count: sql.includes("coordinator_schedule_items") ? 1 : 0 }],
    }));
    const residue = await countCleanupResidue(
      { query } as never,
      emptyManifest,
      [],
    );

    expect(residue).toMatchObject({ imports: 0, batches: 0, coordinatorItems: 1 });
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining("coordinator_schedule_items"),
      [emptyManifest.coordinatorItems],
    ]);
    expect(() => assertZeroCleanupResidue(residue)).toThrow(/coordinatorItems.*1/);
  });
});
