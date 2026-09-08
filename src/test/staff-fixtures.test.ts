import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
describe("staff test isolation", () => {
  it("does not ship human staff credentials in the reference seed", async () => {
    const seed = await readFile(join(process.cwd(), "database/seeds/001_reference_and_users.sql"), "utf8");
    expect(seed).not.toMatch(/INSERT\s+INTO\s+users/i);
    expect(seed).not.toContain("Admin123!");
    expect(seed).not.toContain("Staff123!");
    expect(seed).not.toContain("Coordinator123!");
  });

});
