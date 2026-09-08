// @vitest-environment node
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runBootstrapWithoutSmtp() {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--conditions=react-server",
      "--import",
      "tsx",
      path.resolve("scripts/admin-bootstrap.ts"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://installer:private@127.0.0.1:1/medclinic_unreachable",
        JWT_SECRET: "bootstrap-jwt-secret-at-least-32-characters",
        EMAIL_OUTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString("base64"),
        APP_URL: "http://127.0.0.1:3000",
        APP_TIMEZONE: "Asia/Manila",
        RESULT_UPLOAD_ROOT: path.resolve(".data", "bootstrap-preflight-test"),
        SMTP_HOST: "",
        SMTP_FROM: "",
        BOOTSTRAP_ADMIN_FULL_NAME: "Test Bootstrap Administrator",
        BOOTSTRAP_ADMIN_EMAIL: "administrator@bootstrap.test",
        BOOTSTRAP_ADMIN_TEMPORARY_PASSWORD: "BootstrapPass123!",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

describe("Administrator bootstrap prerequisites", () => {
  it("refuses missing SMTP before attempting the bootstrap database transaction", async () => {
    const result = await runBootstrapWithoutSmtp();

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/SMTP_HOST.*SMTP_FROM/s);
    expect(result.output).not.toMatch(/ECONNREFUSED|connect ECONN/);
    expect(result.output).not.toContain("BootstrapPass123!");
  });
});
