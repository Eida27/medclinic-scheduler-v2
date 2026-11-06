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
    setupFiles: ["./src/test/unit-database-guard.ts"],
    exclude: ["**/*.integration.test.{ts,tsx}"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
    coverage: { reporter: ["text", "html"] },
  },
});
