import { describe, expect, it } from "vitest";
import { applyMigration, type MigrationClient } from "../../../scripts/db-migration-runner";

type FakeClientOptions = {
  applied?: Set<string>;
  rejectSql?: string;
};

function fakeMigrationClient(options: FakeClientOptions = {}) {
  const queries: string[] = [];
  const applied = options.applied ?? new Set<string>();
  const client: MigrationClient & { sql: () => string[] } = {
    async query(text, values) {
      const normalized = text.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized === "SELECT 1 FROM schema_migrations WHERE name = $1") {
        return { rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (options.rejectSql && normalized === options.rejectSql) {
        throw new Error("forced migration failure");
      }
      return { rowCount: 0 };
    },
    sql: () => queries,
  };
  return client;
}

describe("migration runner", () => {
  it("commits migration SQL and its migration-history row in one runner-owned transaction", async () => {
    const client = fakeMigrationClient();

    await expect(applyMigration(client, {
      name: "999_test.sql",
      sql: "CREATE TABLE runner_probe (id integer);",
    })).resolves.toBe(true);

    expect(client.sql()).toEqual([
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      "BEGIN",
      "CREATE TABLE runner_probe (id integer);",
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      "COMMIT",
    ]);
  });

  it("rolls back when migration SQL fails and never records the migration", async () => {
    const client = fakeMigrationClient({
      rejectSql: "SELECT forced_migration_failure()",
    });

    await expect(applyMigration(client, {
      name: "999_failure.sql",
      sql: "SELECT forced_migration_failure()",
    })).rejects.toThrow("forced migration failure");

    expect(client.sql()).toEqual([
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      "BEGIN",
      "SELECT forced_migration_failure()",
      "ROLLBACK",
    ]);
    expect(client.sql()).not.toContain("INSERT INTO schema_migrations (name) VALUES ($1)");
    expect(client.sql()).not.toContain("COMMIT");
  });

  it("skips a migration already present in schema_migrations", async () => {
    const client = fakeMigrationClient({ applied: new Set(["001_existing.sql"]) });

    await expect(applyMigration(client, {
      name: "001_existing.sql",
      sql: "SELECT 1",
    })).resolves.toBe(false);

    expect(client.sql()).toEqual([
      "SELECT 1 FROM schema_migrations WHERE name = $1",
    ]);
  });
});
