import { describe, expect, it } from "vitest";
import { projectPath, sqlFiles } from "../../../scripts/db-common";

const transactionControl = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;\s*(?:--.*)?$/gim;

describe("migration transaction ownership", () => {
  it("keeps migration transaction ownership in the TypeScript runner", async () => {
    const migrations = await sqlFiles(projectPath("database", "migrations"));
    expect(migrations).toHaveLength(31);
    expect(migrations[0]?.name.startsWith("001_")).toBe(true);
    expect(migrations.at(-1)?.name).toBe("031_retire_manual_schedule_metadata.sql");

    const violations = migrations.flatMap((migration) =>
      [...migration.sql.matchAll(transactionControl)].map((match) => ({
        migration: migration.name,
        statement: match[0].trim(),
      })),
    );

    expect(violations).toEqual([]);
  });
});
