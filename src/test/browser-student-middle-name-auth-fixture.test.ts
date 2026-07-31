import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parseStudentImportCsv } from "@/server/services/student-import-csv";
import {
  assertSafeStudentAuthAcceptanceDatabase,
  assertZeroStudentAuthAcceptanceResidue,
  createMissingMiddleNameCsv,
  normalizeStudentAuthAcceptanceDatabaseIdentity,
} from "../../scripts/browser-student-middle-name-auth-fixture";

describe("student middle-name Browser acceptance fixture", () => {
  it("rejects remote databases and requires an explicit exclusive-database opt-in", () => {
    expect(() => assertSafeStudentAuthAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.com:5432/student_auth",
      "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeStudentAuthAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_auth",
      undefined,
    )).toThrow(/STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE=1/);
  });

  it("returns a credential-free identity and rejects destination overrides", () => {
    expect(normalizeStudentAuthAcceptanceDatabaseIdentity(
      "postgresql://secret-user:secret-password@LOCALHOST:5433/student%5Fauth?sslmode=disable",
    )).toEqual({
      scheme: "postgresql",
      host: "localhost",
      port: "5433",
      database: "student_auth",
    });
    expect(() => assertSafeStudentAuthAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_auth?host=remote.example",
      "1",
    )).toThrow(/host or port query parameters/i);
  });

  it("generates a CSV that fails the real parser with the Middle Name row error", () => {
    try {
      parseStudentImportCsv(createMissingMiddleNameCsv());
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "CSV_IMPORT_INVALID",
        status: 422,
        fields: {
          "rows.2.Middle Name": ["Middle Name is required."],
        },
      });
      return;
    }
    throw new Error("Expected the generated missing-middle-name CSV to fail parsing.");
  });

  it("accepts only zero cleanup residue", () => {
    expect(assertZeroStudentAuthAcceptanceResidue({
      students: 0,
      loginAttempts: 0,
      imports: 0,
    })).toEqual({ students: 0, loginAttempts: 0, imports: 0 });
    expect(() => assertZeroStudentAuthAcceptanceResidue({
      students: 0,
      loginAttempts: 1,
      imports: 0,
    })).toThrow(/cleanup residue/i);
  });
});
