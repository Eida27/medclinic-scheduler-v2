import { projectPath, sqlFiles, withClient } from "./db-common";

await withClient(async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrations = await sqlFiles(projectPath("database", "migrations"));
  for (const migration of migrations) {
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [migration.name]);
    if (applied.rowCount) continue;

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      await client.query("COMMIT");
      console.log(`Applied ${migration.name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
});
