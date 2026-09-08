// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInstallationPreflight } from "./installation-preflight";

const temporaryDirectories: string[] = [];

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
    })).resolves.toEqual({ database: "ready", storage: "ready", smtp: "ready" });

    expect(events).toEqual(["database", "storage", "smtp"]);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain(environment.DATABASE_URL);
    expect(output).not.toContain(environment.JWT_SECRET);
    expect(output).not.toContain(environment.EMAIL_OUTBOX_ENCRYPTION_KEY);
  });
});
