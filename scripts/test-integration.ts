import { runTestChild } from "./test-child";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { withDisposableTestDatabase } from "./test-database";
import { fixtureConsentFlags, syntheticTestEnvironment } from "../src/test/environment";

await withDisposableTestDatabase(async (target) => {
  const storageRoot = path.resolve(".data", `test-run-${randomUUID()}`);
  await mkdir(storageRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...syntheticTestEnvironment,
    DATABASE_URL: target.targetUrl, TEST_DATABASE_URL: target.targetUrl,
    TEST_DATABASE_DISPOSABLE: "1", MEDCLINIC_TEST_RUNNER: "1", RESULT_UPLOAD_ROOT: storageRoot,
  };
  for (const flag of fixtureConsentFlags) env[flag] = "1";
  try {
    await runTestChild(["--import", "tsx", "scripts/db-migrate.ts"], env);
    await runTestChild(["--import", "tsx", "scripts/db-seed.ts"], env);
    await runTestChild(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts", ...process.argv.slice(2), "--maxWorkers=1", "--no-file-parallelism"], env);
  } finally {
    const residue = await readdir(storageRoot, { recursive: true });
    console.log(`Disposable test storage residue before removal: ${residue.length} entries.`);
    await rm(storageRoot, { recursive: true, force: true });
  }
});
