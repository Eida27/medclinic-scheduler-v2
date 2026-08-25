// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { ensureTestStaffFixtures, TEST_STAFF_ACCOUNTS } from "./staff-fixtures";

afterAll(async () => {
  await pool.end();
});

describe("staff test isolation", () => {
  it("does not ship human staff credentials in the reference seed", async () => {
    const seed = await readFile(join(process.cwd(), "database/seeds/001_reference_and_users.sql"), "utf8");
    expect(seed).not.toMatch(/INSERT\s+INTO\s+users/i);
    expect(seed).not.toContain("Admin123!");
    expect(seed).not.toContain("Staff123!");
    expect(seed).not.toContain("Coordinator123!");
  });

  it("explicitly creates fully onboarded staff only for tests", async () => {
    await ensureTestStaffFixtures();
    const result = await pool.query<{
      id: string;
      email_verified_at: Date | null;
      must_change_password: boolean;
      credential_version: number;
      deleted_at: Date | null;
    }>(
      `SELECT id,email_verified_at,must_change_password,credential_version,deleted_at
         FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [TEST_STAFF_ACCOUNTS.map((account) => account.id)],
    );
    expect(result.rows).toHaveLength(TEST_STAFF_ACCOUNTS.length);
    expect(result.rows.every((row) =>
      row.email_verified_at instanceof Date
      && row.must_change_password === false
      && row.credential_version === 1
      && row.deleted_at === null
    )).toBe(true);
  });
});
