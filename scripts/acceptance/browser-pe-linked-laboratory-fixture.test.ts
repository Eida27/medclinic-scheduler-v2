// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertSafePeLinkedBrowserDatabase, assertMatchingPeLinkedBrowserDatabase } from "./browser-pe-linked-laboratory-fixture";
describe("PE-linked Browser fixture guards", () => {
  const url = "postgresql://fixture@127.0.0.1:55440/medclinic_test_pe_browser";
  it("requires explicit consent for a named loopback test database", () => {
    expect(() => assertSafePeLinkedBrowserDatabase(url, undefined)).toThrow("BROWSER_PE_LINKED_ACCEPTANCE_LOCAL_TEST_DB=1");
    expect(assertSafePeLinkedBrowserDatabase(url, "1").database).toBe("medclinic_test_pe_browser");
  });
  it.each([
    "postgresql://fixture@remote.example/medclinic_test_pe_browser",
    "postgresql://fixture@127.0.0.1/medclinic_development",
    "postgresql://fixture@127.0.0.1/postgres",
    "postgresql://fixture@127.0.0.1/medclinic_test_pe_browser?host=remote.example",
  ])("rejects an unsafe destination: %s", (destination) => {
    expect(() => assertSafePeLinkedBrowserDatabase(destination, "1")).toThrow();
  });
  it("requires the saved live database identity, including OID, before cleanup", () => {
    const saved = { database: "medclinic_test_pe_browser", address: "127.0.0.1", port: 55440, oid: 123, role: "fixture" };
    expect(() => assertMatchingPeLinkedBrowserDatabase(saved, { ...saved, oid: 124 })).toThrow("identity");
    expect(() => assertMatchingPeLinkedBrowserDatabase(saved, { ...saved, role: "another" })).toThrow("identity");
    expect(() => assertMatchingPeLinkedBrowserDatabase(saved, saved)).not.toThrow();
  });
});
