import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("database-free unit boundary", () => {
  it("fails immediately if an unmocked pool query reaches the database boundary", () => {
    expect(() => new Pool().query("SELECT 1")).toThrow(/database access is forbidden in unit tests/i);
  });
  it("fails immediately if an unmocked client connects", () => {
    expect(() => new Client().connect()).toThrow(/database access is forbidden in unit tests/i);
  });
});
