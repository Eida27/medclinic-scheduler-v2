import { databaseUrl, projectPath, sqlFiles, withClient } from "./db-common";

if (process.env.ALLOW_DB_RESET !== "true") {
  throw new Error("Set ALLOW_DB_RESET=true to reset a disposable database");
}

const database = new URL(databaseUrl()).pathname.slice(1);
if (["postgres", "template0", "template1"].includes(database)) {
  throw new Error(`Refusing to reset protected database: ${database}`);
}

await withClient(async (client) => {
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const migration of await sqlFiles(projectPath("database", "migrations"))) {
    await client.query(migration.sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
    console.log(`Applied ${migration.name}`);
  }

  for (const seed of await sqlFiles(projectPath("database", "seeds"))) {
    await client.query(seed.sql);
    console.log(`Applied ${seed.name}`);
  }
});
