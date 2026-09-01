export type MigrationFile = {
  name: string;
  sql: string;
};

export type MigrationClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
};

export async function ensureSchemaMigrations(client: MigrationClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function applyMigration(
  client: MigrationClient,
  migration: MigrationFile,
): Promise<boolean> {
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE name = $1",
    [migration.name],
  );
  if (applied.rowCount) return false;

  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [migration.name],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(
  client: MigrationClient,
  migrations: MigrationFile[],
  log: (message: string) => void = console.log,
): Promise<string[]> {
  await ensureSchemaMigrations(client);
  const appliedNames: string[] = [];
  for (const migration of migrations) {
    if (await applyMigration(client, migration)) {
      appliedNames.push(migration.name);
      log(`Applied ${migration.name}`);
    }
  }
  return appliedNames;
}
