// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPreparedStaffAccountSecurityAcceptanceState } from "../../../scripts/browser-staff-account-security-dev";

describe("staff account security acceptance dev launcher", () => {
  it("requires the prepared isolated schema state", () => {
    expect(assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
    })).toEqual({
      phase: "PREPARED",
      schemaName: "staff_account_security_acceptance_20260825",
    });
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARING",
      schemaName: "staff_account_security_acceptance_20260825",
    })).toThrow(/acceptance:staff-account-security:setup/);
    expect(() => assertPreparedStaffAccountSecurityAcceptanceState({
      phase: "PREPARED",
      schemaName: "public",
    })).toThrow(/isolated staff account security acceptance schema/);
  });
});
