// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  REPORTS_ACCEPTANCE_FIXTURE,
  assertMatchingReportsAcceptanceDatabaseIdentity,
  assertSafeReportsAcceptanceDatabase,
  assertZeroReportsAcceptanceResidue,
  normalizeReportsAcceptanceDatabaseIdentity,
} from "../../../scripts/browser-reports-acceptance-fixture";
describe("reports Browser acceptance fixture guards", () => {
  it("requires an explicitly opted-in loopback PostgreSQL database without leaking credentials", () => {
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@db.example.test/reports", "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@localhost/reports", undefined,
    )).toThrow("REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
  });

  it.each([
      "postgresql://fixture:secret-password@localhost/reports?host=remote.example",
      "postgresql://fixture:secret-password@localhost/reports?port=9999",
  ])("rejects the unsafe effective URL %s", (databaseUrl) => {
    expect(() => assertSafeReportsAcceptanceDatabase(databaseUrl, "1"))
      .toThrow(/host or port query/i);
  });

  it.each([
    "postgresql://fixture:secret-password@localhost/reports?host=remote.example",
    "postgresql://fixture:secret-password@localhost/reports?port=9999",
  ])("does not leak credentials while rejecting %s", (databaseUrl) => {
    let thrown: unknown;
      try {
        assertSafeReportsAcceptanceDatabase(databaseUrl, "1");
      } catch (error) {
      thrown = error;
      }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("secret-password");
    expect(String(thrown)).not.toContain(databaseUrl);
  });

  it.each([
    ["postgresql://fixture:secret@localhost/reports", "localhost", "5432", "reports"],
    ["postgres://fixture:secret@127.0.0.1:5544/reports", "127.0.0.1", "5544", "reports"],
    ["postgresql://fixture:secret@[::1]:5433/reports", "::1", "5433", "reports"],
  ])("normalizes a credential-free loopback identity", (url, host, port, database) => {
    expect(assertSafeReportsAcceptanceDatabase(url, "1"))
      .toEqual({ scheme: "postgresql", host, port, database });
  });

  it("refuses destructive work when the persisted database identity differs", () => {
    const prepared = normalizeReportsAcceptanceDatabaseIdentity(
      "postgresql://fixture:secret@localhost/reports_a",
    );
    const current = normalizeReportsAcceptanceDatabaseIdentity(
      "postgresql://fixture:secret@localhost/reports_b",
    );
    expect(() => assertMatchingReportsAcceptanceDatabaseIdentity(current, prepared))
      .toThrow(/does not match/i);
  });

  it("reserves exact disjoint identifiers and deterministic Browser expectations", () => {
    expect(REPORTS_ACCEPTANCE_FIXTURE).toMatchObject({
      marker: "BROWSER-REPORTS-ACCEPTANCE-V1",
      studentPrefix: "B-RPT-",
      paginationCount: 153,
      years: {
        closed: { startYear: 2020, label: "2020–2021", closingDate: "2021-07-31" },
        open: { startYear: 2098, label: "2098–2099", closingDate: "2099-07-31" },
      },
      crudScratch: { startYear: 2097, closingDate: "2098-07-31" },
    });
    expect(new Set(REPORTS_ACCEPTANCE_FIXTURE.studentNumbers).size).toBe(153);
    expect(new Set(REPORTS_ACCEPTANCE_FIXTURE.appointmentIds).size)
      .toBe(REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.length);
    expect(REPORTS_ACCEPTANCE_FIXTURE.importGroups).toEqual([
      expect.objectContaining({
        academicYearStart: 2020,
        importMode: "STANDARD",
      }),
      expect.objectContaining({
        academicYearStart: 2020,
        importMode: "FIRST_YEAR_OVPSA",
      }),
      expect.objectContaining({
        academicYearStart: 2098,
        importMode: "STANDARD",
      }),
      expect.objectContaining({
        academicYearStart: 2098,
        importMode: "FIRST_YEAR_OVPSA",
      }),
    ]);
  });

  it("requires every fixture-owned database and state count to be zero", () => {
    const zero = {
      students: 0, snapshots: 0, appointments: 0, importGroups: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    };
    expect(assertZeroReportsAcceptanceResidue(zero)).toBe(zero);
    expect(() => assertZeroReportsAcceptanceResidue({ ...zero, snapshots: 1 }))
      .toThrow(/residue remains/i);
  });
});
