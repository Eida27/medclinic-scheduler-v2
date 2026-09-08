// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { withDisposableTestDatabase } from "../../scripts/test-database";

// Model the external PostgreSQL connection failing immediately after CREATE succeeds.
vi.mock("pg", () => ({
  Client: class {
    created = false;
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (sql.startsWith("CREATE DATABASE")) { this.created = true; return {}; }
      if (this.created) throw new Error("connection lost after database creation");
      return { rows: [], rowCount: 0 };
    }
  },
}));

describe("disposable database partial setup failure", () => {
  it("reports possible residue when creation succeeded but ownership verification is unavailable", async () => {
    let failure: unknown;
    try {
      await withDisposableTestDatabase(async () => {
        throw new Error("fixtures must not run before live identity is verified");
      }, "postgresql://test:test@127.0.0.1/medclinic_test_partial_setup", "1");
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join(" ")).toMatch(/connection lost.*ownership.*residue/);
  });
});
