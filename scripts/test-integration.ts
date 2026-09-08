import { runTestChild } from "./test-child";
import { withTestStorageCleanup } from "./test-storage";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
  await withTestStorageCleanup(storageRoot, async () => {
    await runTestChild(["--import", "tsx", "scripts/db-migrate.ts"], env);
    await runTestChild(["--import", "tsx", "scripts/db-seed.ts"], env);
    await runTestChild(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts", ...process.argv.slice(2), "--maxWorkers=1", "--no-file-parallelism"], env);
  });
});
