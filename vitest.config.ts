import path from "node:path";
import { defineConfig } from "vitest/config";
import { fixtureConsentFlags, syntheticTestEnvironment } from "./src/test/environment";

Object.assign(process.env, syntheticTestEnvironment);
for (const flag of fixtureConsentFlags) delete process.env[flag];
delete process.env.TEST_DATABASE_URL;
delete process.env.TEST_DATABASE_DISPOSABLE;

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "src/test/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/unit-database-guard.ts", "./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/browser-student-result-editing-fixture.test.ts"],
    exclude: ["**/*.integration.test.{ts,tsx}"],
    coverage: { reporter: ["text", "html"] },
  },
});
