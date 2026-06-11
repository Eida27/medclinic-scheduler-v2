import { projectPath, sqlFiles, withClient } from "./db-common";

await withClient(async (client) => {
  const seeds = await sqlFiles(projectPath("database", "seeds"));
  await client.query("BEGIN");
  try {
    for (const seed of seeds) {
      await client.query(seed.sql);
      console.log(`Applied ${seed.name}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
});
