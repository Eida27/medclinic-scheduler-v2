// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runTestChild } from "../../scripts/test-child";

describe("test child process boundary", () => {
  it("passes only the explicit target configuration into the child", async () => {
    await expect(runTestChild(["-e", "process.exit(process.env.DATABASE_URL === 'postgresql://test@127.0.0.1/medclinic_test_child' && process.env.JWT_SECRET === 'synthetic' ? 0 : 7)"], {
      NODE_ENV: "test", DATABASE_URL: "postgresql://test@127.0.0.1/medclinic_test_child", JWT_SECRET: "synthetic",
    })).resolves.toBeUndefined();
  });
  it("propagates an unsuccessful child exit instead of reporting success", async () => {
    await expect(runTestChild(["-e", "process.exit(17)"], { NODE_ENV: "test" })).rejects.toThrow(/exit=17/);
  });
});
