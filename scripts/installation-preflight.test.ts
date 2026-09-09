// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInstallationPreflight } from "./installation-preflight";

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function validateInChild(environment: Record<string, string | undefined>, cwd: string) {
  const moduleUrl = pathToFileURL(path.join(repositoryRoot, "scripts", "installation-preflight.ts")).href;
  const loaderUrl = pathToFileURL(path.join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const source = `
    import { validateInstallationConfiguration } from ${JSON.stringify(moduleUrl)};
    try {
      validateInstallationConfiguration(JSON.parse(process.env.PREFLIGHT_TEST_ENV));
      console.log("accepted");
    } catch (error) {
      console.error(error instanceof Error ? error.message : "unknown preflight failure");
      process.exitCode = 1;
    }
  `;
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loaderUrl, "--input-type=module", "-e", source], {
      cwd,
      env: { ...process.env, PREFLIGHT_TEST_ENV: JSON.stringify(environment) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function validEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), "medclinic-preflight-"));
  temporaryDirectories.push(root);
  return {
    DATABASE_URL: "postgresql://installer:private@127.0.0.1:5432/medclinic_install",
    JWT_SECRET: "installation-jwt-secret-at-least-32-characters",
    EMAIL_OUTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
    APP_URL: "https://clinic.example.test",
    APP_TIMEZONE: "Asia/Manila",
    RESULT_UPLOAD_ROOT: root,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "2525",
    SMTP_FROM: "clinic@example.test",
    SMTP_USER: "",
    SMTP_PASS: "",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("installation preflight", () => {
  it("rejects the public JWT placeholder shipped in .env.example before I/O", async () => {
    const environment = await validEnvironment();
    environment.JWT_SECRET = "replace-with-a-strong-random-secret-of-at-least-32-characters";
    const verifyDatabase = vi.fn();

    await expect(runInstallationPreflight(environment, {
      verifyDatabase,
      verifyStorage: vi.fn(),
      verifySmtp: vi.fn(),
    })).rejects.toThrow(/JWT_SECRET.*placeholder/);

    expect(verifyDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ["repository root", repositoryRoot],
    ["src descendant", path.join(repositoryRoot, "src", "private-results")],
    [".next descendant", path.join(repositoryRoot, ".next", "private-results")],
  ])("rejects absolute storage inside the %s even when run elsewhere", async (_label, storageRoot) => {
    const environment = await validEnvironment();
    const unrelatedWorkingDirectory = await mkdtemp(path.join(tmpdir(), "medclinic-preflight-cwd-"));
    temporaryDirectories.push(unrelatedWorkingDirectory);
    environment.RESULT_UPLOAD_ROOT = storageRoot;

    const result = await validateInChild(environment, unrelatedWorkingDirectory);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/RESULT_UPLOAD_ROOT.*outside the repository/s);
    expect(result.output).not.toContain("accepted");
  });

  it("reports missing SMTP prerequisites before running operational checks", async () => {
    const environment = { ...(await validEnvironment()), SMTP_HOST: "", SMTP_FROM: "" };
    const verifyDatabase = vi.fn();
    const verifyStorage = vi.fn();
    const verifySmtp = vi.fn();

    await expect(runInstallationPreflight(environment, {
      verifyDatabase,
      verifyStorage,
      verifySmtp,
    })).rejects.toThrow(/SMTP_HOST.*SMTP_FROM/s);

    expect(verifyDatabase).not.toHaveBeenCalled();
    expect(verifyStorage).not.toHaveBeenCalled();
    expect(verifySmtp).not.toHaveBeenCalled();
  });

  it("rejects reused secrets, the wrong timezone, an implicit URL, relative storage, and partial SMTP auth", async () => {
    const environment = await validEnvironment();
    environment.EMAIL_OUTBOX_ENCRYPTION_KEY = environment.JWT_SECRET;
    environment.APP_URL = "";
    environment.APP_TIMEZONE = "UTC";
    environment.RESULT_UPLOAD_ROOT = ".data/private-result-uploads";
    environment.SMTP_USER = "smtp-user";

    await expect(runInstallationPreflight(environment, {
      verifyDatabase: vi.fn(),
      verifyStorage: vi.fn(),
      verifySmtp: vi.fn(),
    })).rejects.toThrow(/different from JWT_SECRET.*APP_URL.*Asia\/Manila.*absolute.*SMTP_USER and SMTP_PASS/s);
  });

  it("checks the database, private storage, and SMTP transport without exposing secrets", async () => {
    const environment = await validEnvironment();
    const events: string[] = [];
    const log = vi.fn();

    await expect(runInstallationPreflight(environment, {
      verifyDatabase: async () => { events.push("database"); },
      verifyStorage: async () => { events.push("storage"); },
      verifySmtp: async () => { events.push("smtp"); },
      log,
    })).resolves.toEqual({ database: "reachable", storage: "writable", smtp: "reachable" });

    expect(events).toEqual(["database", "storage", "smtp"]);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain(environment.DATABASE_URL);
    expect(output).not.toContain(environment.JWT_SECRET);
    expect(output).not.toContain(environment.EMAIL_OUTBOX_ENCRYPTION_KEY);
    expect(output).toContain("writable");
    expect(output).not.toMatch(/durable storage ready/i);
  });
});
