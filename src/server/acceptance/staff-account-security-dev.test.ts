// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPreparedStaffAccountSecurityAcceptanceState } from "../../../scripts/browser-staff-account-security-dev";

describe("staff account security acceptance dev launcher", () => {
  it("requires the prepared isolated schema state", () => {
    expect(assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    }, {
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    })).toEqual({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    });
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARING",
      schemaName: "staff_account_security_acceptance_20260825",
    }, {
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    })).toThrow(/acceptance:staff-account-security:setup/);
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "public",
    }, {
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    })).toThrow(/isolated staff account security acceptance schema/);
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
      databaseIdentity: { hostname: "localhost", port: "5432", database: "different_database" },
      appUrl: "http://localhost:3012",
    }, {
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    })).toThrow(/different database/);
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3000",
    }, {
      databaseIdentity: { hostname: "localhost", port: "5432", database: "medclinic_test" },
      appUrl: "http://localhost:3012",
    })).toThrow(/APP_URL/);
  });
});
