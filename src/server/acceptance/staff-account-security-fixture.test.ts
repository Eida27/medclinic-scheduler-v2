// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertSafeStaffAccountSecurityAcceptanceDatabase,
  assertZeroStaffAccountSecurityResidue,
  staffAccountSecurityAcceptanceDatabaseIdentity,
  staffAccountSecurityAcceptanceSchemaUrl,
  type StaffAccountSecurityResidue,
} from "../../../scripts/browser-staff-account-security-fixture";

const zero: StaffAccountSecurityResidue = {
  users: 0,
  emailVerifications: 0,
  passwordResets: 0,
  outbox: 0,
  audits: 0,
  historicalAppointments: 0,
  historicalStatusLogs: 0,
  historicalStudents: 0,
  stateFiles: 0,
};

describe("staff account security Browser acceptance fixture safety", () => {
  it("requires an explicit exclusive disposable database opt-in", () => {
    expect(() => assertSafeStaffAccountSecurityAcceptanceDatabase(
      "postgres://postgres:postgres@127.0.0.1:5432/medclinic_test",
      undefined,
    )).toThrow(/STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE=1/);
  });

  it("rejects non-loopback databases even with the opt-in", () => {
    expect(() => assertSafeStaffAccountSecurityAcceptanceDatabase(
      "postgres://postgres:postgres@db.example.com:5432/medclinic_test",
      "1",
    )).toThrow(/loopback PostgreSQL/);
  });

  it("accepts an explicitly exclusive loopback database", () => {
    expect(assertSafeStaffAccountSecurityAcceptanceDatabase(
      "postgres://postgres:postgres@localhost:5432/medclinic_test",
      "1",
    )).toMatchObject({ database: "medclinic_test", hostname: "localhost" });
  });

  it("targets a dedicated schema while preserving the configured database", () => {
    const value = new URL(staffAccountSecurityAcceptanceSchemaUrl(
      "postgres://postgres:postgres@localhost:5432/medclinic_test",
    ));
    expect(value.pathname).toBe("/medclinic_test");
    expect(value.searchParams.get("options")).toBe(
      "-csearch_path=staff_account_security_acceptance_20260825,public",
    );
  });

  it("derives a credential-free database identity for acceptance state binding", () => {
    expect(staffAccountSecurityAcceptanceDatabaseIdentity(
      "postgres://staff_user:secret@localhost:5433/medclinic_test",
    )).toEqual({ hostname: "localhost", port: "5433", database: "medclinic_test" });
  });

  it("proves complete cleanup across every fixture-owned surface", () => {
    expect(assertZeroStaffAccountSecurityResidue(zero)).toEqual(zero);
    expect(() => assertZeroStaffAccountSecurityResidue({ ...zero, outbox: 1 }))
      .toThrow(/cleanup residue/i);
  });
});
