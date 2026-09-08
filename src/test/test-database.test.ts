// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateTestDatabase } from "../../scripts/test-database";

describe("disposable database target guard", () => {
  it.each([
    [undefined, "1"],
    ["postgresql://localhost/medclinic_test_guard", "1"],
    ["postgresql://test:secret@localhost:0/medclinic_test_guard", "1"],
    ["postgresql://test:secret@localhost/medclinic_test_guard", undefined],
    ["postgresql://test:secret@remote.example/medclinic_test_guard", "1"],
    ["postgresql://test:secret@localhost/medclinic", "1"],
    ["postgresql://test:secret@localhost/postgres", "1"],
    ["postgresql://test:secret@localhost/medclinic_test_guard?host=remote", "1"],
    ["postgresql://test:secret@localhost/medclinic_test_guard?options=-csearch_path=private", "1"],
    ["postgresql://test:secret@localhost/medclinic_test_guard?dbname=medclinic", "1"],
    ["https://test:secret@localhost/medclinic_test_guard", "1"],
  ])("rejects unsafe identity without exposing credentials (%#)", (url, consent) => {
    let failure: unknown;
    try { validateTestDatabase(url, consent); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("secret");
  });
  it("accepts an explicit loopback disposable identity", () => {
    expect(validateTestDatabase("postgresql://test:secret@127.0.0.1:5433/medclinic_test_guard", "1").database)
      .toBe("medclinic_test_guard");
  });
});
