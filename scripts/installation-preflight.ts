import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodemailer from "nodemailer";
import { Client } from "pg";
import { parseEmailOutboxEncryptionKey } from "../src/server/email/verification-body-encryption";

type Environment = Record<string, string | undefined>;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JWT_SECRET_PLACEHOLDERS = new Set([
  "replace-with-a-strong-random-secret-of-at-least-32-characters",
  "replace-with-at-least-32-random-characters",
]);

export type InstallationConfiguration = {
  databaseUrl: string;
  jwtSecret: string;
  emailOutboxEncryptionKey: string;
  appUrl: string;
  appTimezone: "Asia/Manila";
  resultUploadRoot: string;
  smtp: {
    host: string;
    port: number;
    from: string;
    user?: string;
    pass?: string;
  };
};

type PreflightDependencies = {
  verifyDatabase?: (configuration: InstallationConfiguration) => Promise<void>;
  verifyStorage?: (configuration: InstallationConfiguration) => Promise<void>;
  verifySmtp?: (configuration: InstallationConfiguration) => Promise<void>;
  log?: (message: string) => void;
};

export class InstallationPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationPreflightError";
  }
}

function required(value: string | undefined) {
  return value?.trim() ?? "";
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateInstallationConfiguration(
  environment: Environment,
): InstallationConfiguration {
  const issues: string[] = [];
  const databaseUrl = required(environment.DATABASE_URL);
  if (!databaseUrl) {
    issues.push("DATABASE_URL is required.");
  } else {
    try {
      const parsed = new URL(databaseUrl);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        issues.push("DATABASE_URL must use PostgreSQL.");
      }
    } catch {
      issues.push("DATABASE_URL must be a valid PostgreSQL URL.");
    }
  }

  const jwtSecret = required(environment.JWT_SECRET);
  if (jwtSecret.length < 32) issues.push("JWT_SECRET must contain at least 32 characters.");
  if (JWT_SECRET_PLACEHOLDERS.has(jwtSecret)) {
    issues.push("JWT_SECRET must replace the public placeholder with a generated secret.");
  }

  const emailOutboxEncryptionKey = required(environment.EMAIL_OUTBOX_ENCRYPTION_KEY);
  try {
    parseEmailOutboxEncryptionKey(emailOutboxEncryptionKey);
  } catch (error) {
    issues.push(error instanceof Error
      ? error.message
      : "EMAIL_OUTBOX_ENCRYPTION_KEY is invalid.");
  }
  if (emailOutboxEncryptionKey && emailOutboxEncryptionKey === jwtSecret) {
    issues.push("EMAIL_OUTBOX_ENCRYPTION_KEY must be different from JWT_SECRET.");
  }

  const appUrl = required(environment.APP_URL);
  if (!appUrl) {
    issues.push("APP_URL is required and must be the public application URL.");
  } else {
    try {
      const parsed = new URL(appUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        issues.push("APP_URL must use HTTP or HTTPS.");
      }
    } catch {
      issues.push("APP_URL must be a valid HTTP or HTTPS URL.");
    }
  }

  const appTimezone = required(environment.APP_TIMEZONE);
  if (appTimezone !== "Asia/Manila") {
    issues.push("APP_TIMEZONE must be Asia/Manila.");
  }

  const resultUploadRootValue = required(environment.RESULT_UPLOAD_ROOT);
  const resultUploadRoot = resultUploadRootValue
    ? path.resolve(resultUploadRootValue)
    : "";
  if (!resultUploadRootValue) {
    issues.push("RESULT_UPLOAD_ROOT is required.");
  } else if (!path.isAbsolute(resultUploadRootValue)) {
    issues.push("RESULT_UPLOAD_ROOT must be an absolute private storage path.");
  } else if (isWithin(REPOSITORY_ROOT, resultUploadRoot)) {
    issues.push("RESULT_UPLOAD_ROOT must be outside the repository on deployment-provided durable private storage.");
  }

  const smtpHost = required(environment.SMTP_HOST);
  const smtpFrom = required(environment.SMTP_FROM);
  if (!smtpHost) issues.push("SMTP_HOST is required before Administrator bootstrap.");
  if (!smtpFrom) issues.push("SMTP_FROM is required before Administrator bootstrap.");
  if (smtpFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtpFrom)) {
    issues.push("SMTP_FROM must be a valid email address.");
  }
  const smtpPortText = required(environment.SMTP_PORT) || "587";
  const smtpPort = Number(smtpPortText);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
    issues.push("SMTP_PORT must be an integer from 1 through 65535.");
  }
  const smtpUser = required(environment.SMTP_USER);
  const smtpPass = required(environment.SMTP_PASS);
  if (Boolean(smtpUser) !== Boolean(smtpPass)) {
    issues.push("SMTP_USER and SMTP_PASS must either both be set or both be omitted.");
  }

  if (issues.length) {
    throw new InstallationPreflightError(
      `Installation configuration is not ready:\n- ${issues.join("\n- ")}`,
    );
  }

  return {
    databaseUrl,
    jwtSecret,
    emailOutboxEncryptionKey,
    appUrl,
    appTimezone: "Asia/Manila",
    resultUploadRoot,
    smtp: {
      host: smtpHost,
      port: smtpPort,
      from: smtpFrom,
      ...(smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : {}),
    },
  };
}

async function verifyDatabase(configuration: InstallationConfiguration) {
  const client = new Client({
    connectionString: configuration.databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.query("SELECT current_database(), current_user");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyStorage(configuration: InstallationConfiguration) {
  await mkdir(configuration.resultUploadRoot, { recursive: true, mode: 0o700 });
  const storage = await stat(configuration.resultUploadRoot);
  if (!storage.isDirectory()) {
    throw new Error("Configured result storage is not a directory.");
  }
  const probe = path.join(
    configuration.resultUploadRoot,
    `.medclinic-installation-preflight-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(probe, "private storage write probe", { flag: "wx", mode: 0o600 });
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

async function verifySmtp(configuration: InstallationConfiguration) {
  const transport = nodemailer.createTransport({
    host: configuration.smtp.host,
    port: configuration.smtp.port,
    secure: configuration.smtp.port === 465,
    ...(configuration.smtp.user && configuration.smtp.pass
      ? { auth: { user: configuration.smtp.user, pass: configuration.smtp.pass } }
      : {}),
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

async function runCheck(
  label: "database" | "storage" | "smtp",
  action: () => Promise<void>,
) {
  try {
    await action();
  } catch {
    const guidance = label === "database"
      ? "Check DATABASE_URL, PostgreSQL availability, credentials, and network access."
      : label === "storage"
        ? "Check RESULT_UPLOAD_ROOT, private-directory permissions, and durable volume availability."
        : "Check SMTP_HOST, SMTP_PORT, optional paired credentials, TLS policy, and provider availability.";
    throw new InstallationPreflightError(
      `Installation ${label} check failed. ${guidance}`,
    );
  }
}

export async function runInstallationPreflight(
  environment: Environment = process.env,
  dependencies: PreflightDependencies = {},
) {
  const configuration = validateInstallationConfiguration(environment);
  const log = dependencies.log ?? console.log;
  await runCheck("database", () => (
    (dependencies.verifyDatabase ?? verifyDatabase)(configuration)
  ));
  log("Installation preflight: database is reachable.");
  await runCheck("storage", () => (
    (dependencies.verifyStorage ?? verifyStorage)(configuration)
  ));
  log("Installation preflight: configured result storage path is writable; verify deployment durability and access controls separately.");
  await runCheck("smtp", () => (
    (dependencies.verifySmtp ?? verifySmtp)(configuration)
  ));
  log("Installation preflight: SMTP is reachable.");
  return { database: "reachable", storage: "writable", smtp: "reachable" } as const;
}

function isDirectExecution() {
  return Boolean(process.argv[1])
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    await runInstallationPreflight();
    console.log("Installation preflight completed successfully.");
  } catch (error) {
    console.error(error instanceof InstallationPreflightError
      ? error.message
      : "Installation preflight failed unexpectedly.");
    process.exitCode = 1;
  }
}
