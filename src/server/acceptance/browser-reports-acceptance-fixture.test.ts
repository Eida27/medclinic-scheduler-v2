// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getHistoricalComplianceReport } from "@/server/services/historical-compliance-report.service";
import {
  REPORTS_ACCEPTANCE_FIXTURE,
  assertMatchingReportsAcceptanceDatabaseIdentity,
  assertSafeReportsAcceptanceDatabase,
  assertZeroReportsAcceptanceResidue,
  cleanupReportsAcceptanceFixture,
  getReportsAcceptanceFixtureStatus,
  isReportsAcceptanceFixtureOwned,
  normalizeReportsAcceptanceDatabaseIdentity,
  setupReportsAcceptanceFixture,
} from "../../../scripts/browser-reports-acceptance-fixture";

describe("reports Browser acceptance fixture guards", () => {
  it("requires an explicitly opted-in loopback PostgreSQL database without leaking credentials", () => {
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@db.example.test/reports", "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@localhost/reports", undefined,
    )).toThrow("REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
    for (const databaseUrl of [
      "postgresql://fixture:secret-password@localhost/reports?host=remote.example",
      "postgresql://fixture:secret-password@localhost/reports?port=9999",
    ]) {
      try {
        assertSafeReportsAcceptanceDatabase(databaseUrl, "1");
      } catch (error) {
        expect(String(error)).not.toContain("secret-password");
        expect(String(error)).not.toContain(databaseUrl);
      }
    }
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

  it("recognizes ownership only from state or the exact setup marker", () => {
    expect(isReportsAcceptanceFixtureOwned(false, 0)).toBe(false);
    expect(isReportsAcceptanceFixtureOwned(true, 0)).toBe(true);
    expect(isReportsAcceptanceFixtureOwned(false, 1)).toBe(true);
    expect(() => isReportsAcceptanceFixtureOwned(false, 2)).toThrow(/marker/i);
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
  });

  it("requires every fixture-owned database and state count to be zero", () => {
    const zero = {
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    };
    expect(assertZeroReportsAcceptanceResidue(zero)).toBe(zero);
    expect(() => assertZeroReportsAcceptanceResidue({ ...zero, snapshots: 1 }))
      .toThrow(/residue remains/i);
  });
});

const exclusive = process.env.REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE === "1";
describe.runIf(exclusive)("reports Browser acceptance fixture lifecycle", () => {
  let pool: Pool;
  let identity: ReturnType<typeof assertSafeReportsAcceptanceDatabase>;

  beforeAll(async () => {
    identity = assertSafeReportsAcceptanceDatabase(process.env.DATABASE_URL, "1");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanupReportsAcceptanceFixture(pool, identity);
  });

  afterAll(async () => {
    if (pool) {
      await cleanupReportsAcceptanceFixture(pool, identity);
      await pool.end();
    }
  });

  it("sets up idempotently and exposes exact status without secrets", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await setupReportsAcceptanceFixture(pool, identity);
    const status = await getReportsAcceptanceFixtureStatus(pool, identity);

    expect(status).toMatchObject({
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      years: {
        closed: { startYear: 2020, label: "2020–2021", state: "CLOSED" },
        open: { startYear: 2098, label: "2098–2099", state: "OPEN" },
      },
      paginationCount: 153,
      counts: { students: 153, snapshots: 157, appointments: 165, academicYears: 2 },
      expected: {
        replacement: {
          studentNumber: "B-RPT-0001", classification: "COMPLIED",
          laboratoryStatus: "COMPLETED", dataQuality: "VERIFIED_HISTORICAL",
        },
        historicalDivergence: {
          studentNumber: "B-RPT-0002",
          currentCollege: "College of Computer Studies",
          currentProgram: "Bachelor of Science in Information Technology",
          historicalCollege: "Archived College of Health Sciences",
          historicalProgram: "Archived Clinical Sciences",
          classification: "DID_NOT_COMPLY_BOTH",
          dataQuality: "RECOVERED_HISTORICAL",
        },
        migratedIncomplete: {
          studentNumber: "B-RPT-0003",
          classification: "DID_NOT_COMPLY_PHYSICAL_EXAM",
          dataQuality: "MIGRATED_INCOMPLETE",
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(status)).not.toContain("password");
  });

  it("drives exact report classifications, replacement precedence, and pagination", async () => {
    const first = await getHistoricalComplianceReport({
      academicYearStart: "2020", search: "B-RPT-", page: "1", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    const second = await getHistoricalComplianceReport({
      academicYearStart: "2020", search: "B-RPT-", page: "2", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    expect(first.total).toBe(153);
    expect(first.items).toHaveLength(150);
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((row) => row.studentNumber)).size).toBe(153);

    const byNumber = Object.fromEntries([...first.items, ...second.items]
      .map((row) => [row.studentNumber, row]));
    expect(byNumber["B-RPT-0001"]).toMatchObject({
      laboratoryStatus: "COMPLETED", physicalExamStatus: "COMPLETED",
      overallStatus: "COMPLIED", dataQuality: "VERIFIED_HISTORICAL",
    });
    expect(byNumber["B-RPT-0002"]).toMatchObject({
      collegeName: "Archived College of Health Sciences",
      programName: "Archived Clinical Sciences",
      laboratoryStatus: "PENDING", physicalExamStatus: "UNSCHEDULED",
      overallStatus: "DID_NOT_COMPLY_BOTH", dataQuality: "RECOVERED_HISTORICAL",
    });
    expect(byNumber["B-RPT-0003"]).toMatchObject({
      laboratoryStatus: "COMPLETED", physicalExamStatus: "NO_SHOW",
      overallStatus: "DID_NOT_COMPLY_PHYSICAL_EXAM", dataQuality: "MIGRATED_INCOMPLETE",
    });
    expect(byNumber["B-RPT-0004"]).toMatchObject({
      laboratoryStatus: "PENDING", physicalExamStatus: "COMPLETED",
      overallStatus: "DID_NOT_COMPLY_LABORATORY",
    });

    const open = await getHistoricalComplianceReport({
      academicYearStart: "2098", search: "B-RPT-", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    expect(open.total).toBe(4);
    expect(Object.fromEntries(open.items.map((row) => [row.studentNumber, row.overallStatus])))
      .toEqual({
        "B-RPT-0001": "COMPLIED",
        "B-RPT-0002": "PENDING_COMPLIANCE",
        "B-RPT-0003": "PENDING_COMPLIANCE",
        "B-RPT-0004": "PENDING_COMPLIANCE",
      });
  });

  it("cleans partial and complete setups repeatedly with no residue", async () => {
    await pool.query("DELETE FROM appointments WHERE id=$1", [REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.at(-1)]);
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
    await setupReportsAcceptanceFixture(pool, identity);
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
  });
});
