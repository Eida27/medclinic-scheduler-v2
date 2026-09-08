// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertMatchingStudentResultEditingDatabaseIdentity,
  assertSafeStudentResultEditingAcceptanceDatabase,
  assertStudentResultEditingStorageTarget,
  assertZeroStudentResultEditingResidue,
  normalizeStudentResultEditingDatabaseIdentity,
} from "./browser-student-result-editing-fixture";
const STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
describe("student result editing Browser acceptance fixture guards", () => {
  const loopback = "postgresql://fixture:secret-password@localhost/result_editing";

  it.each(["prepare", "cleanup"] as const)(
    "requires the exact exclusive flag for the %s mutation",
    (mode) => {
      expect(() => assertSafeStudentResultEditingAcceptanceDatabase(loopback, undefined, mode))
        .toThrow("STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
      expect(() => assertSafeStudentResultEditingAcceptanceDatabase(loopback, "true", mode))
        .toThrow("STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
    },
  );

  it.each(["prepare", "cleanup"] as const)(
    "rejects a non-loopback database for the %s mutation without leaking credentials",
    (mode) => {
      let thrown: unknown;
      try {
        assertSafeStudentResultEditingAcceptanceDatabase(
          "postgresql://fixture:secret-password@db.example.test/result_editing",
          "1",
          mode,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/loopback/i);
      expect(String(thrown)).not.toContain("secret-password");
    },
  );

  it("allows read-only status without the exclusive flag but still requires loopback", () => {
    expect(assertSafeStudentResultEditingAcceptanceDatabase(loopback, undefined, "status"))
      .toEqual({ scheme: "postgresql", host: "localhost", port: "5432", database: "result_editing" });
    expect(() => assertSafeStudentResultEditingAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.test/result_editing",
      undefined,
      "status",
    )).toThrow(/loopback/i);
  });

  it.each([
    "postgresql://fixture:secret@localhost/result_editing?host=remote.example",
    "postgresql://fixture:secret@localhost/result_editing?port=6432",
  ])("rejects unsafe destination overrides in %s", (databaseUrl) => {
    expect(() => assertSafeStudentResultEditingAcceptanceDatabase(databaseUrl, "1", "prepare"))
      .toThrow(/host or port query/i);
  });

  it("normalizes credential-free database identity and refuses identity drift", () => {
    expect(normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@LOCALHOST:5544/result%5Fediting?sslmode=disable",
    )).toEqual({ scheme: "postgresql", host: "localhost", port: "5544", database: "result_editing" });
    const prepared = normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@localhost/result_editing_a",
    );
    const current = normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@localhost/result_editing_b",
    );
    expect(() => assertMatchingStudentResultEditingDatabaseIdentity(current, prepared))
      .toThrow(/does not match/i);
  });

  it("confines private storage targets to the configured root", () => {
    expect(assertStudentResultEditingStorageTarget(STORAGE_ROOT, "submission/file.pdf"))
      .toBe(resolve(STORAGE_ROOT, "submission/file.pdf"));
    expect(() => assertStudentResultEditingStorageTarget(STORAGE_ROOT, "../outside.pdf"))
      .toThrow(/storage key/i);
    expect(() => assertStudentResultEditingStorageTarget(STORAGE_ROOT, resolve("outside.pdf")))
      .toThrow(/storage key/i);
  });

  it("requires every scoped database, storage, chooser, and state count to be zero", () => {
    const zero = {
      students: 0,
      appointments: 0,
      submissions: 0,
      files: 0,
      legacyExamResults: 0,
      legacyLaboratoryResults: 0,
      appointmentStatusLogs: 0,
      storageCleanupIntents: 0,
      notifications: 0,
      outbox: 0,
      auditLogs: 0,
      loginAttempts: 0,
      emailVerifications: 0,
      storageObjects: 0,
      chooserArtifacts: 0,
      stateFiles: 0,
    };
    expect(assertZeroStudentResultEditingResidue(zero)).toBe(zero);
    expect(() => assertZeroStudentResultEditingResidue({ ...zero, storageCleanupIntents: 1 }))
      .toThrow(/residue remains/i);
  });
});
