import { projectPath, sqlFiles, withClient } from "./db-common";
import { runMigrations } from "./db-migration-runner";

await withClient(async (client) => {
  const migrations = await sqlFiles(projectPath("database", "migrations"));
  await runMigrations(client, migrations);
});
