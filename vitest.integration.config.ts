import path from "node:path";
import { defineConfig } from "vitest/config";
import { validateTestDatabase } from "./scripts/test-database";

const target = validateTestDatabase(process.env.TEST_DATABASE_URL, process.env.TEST_DATABASE_DISPOSABLE);
if (process.env.DATABASE_URL !== target.targetUrl || !process.env.MEDCLINIC_TEST_RUNNER) {
  throw new Error("Run integration tests through npm run test:integration so the disposable runner owns setup and teardown.");
}
export default defineConfig({
  envDir: false,
  resolve: { alias: {
    "@": path.resolve(import.meta.dirname, "src"),
    "server-only": path.resolve(import.meta.dirname, "src/test/server-only.ts"),
  } },
  test: {
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.integration.test.{ts,tsx}", "scripts/**/*.integration.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
