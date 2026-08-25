import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import {
  assertSafeStaffAccountSecurityAcceptanceDatabase,
  staffAccountSecurityAcceptanceDatabaseIdentity,
  staffAccountSecurityAcceptanceSchemaUrl,
  type StaffAccountSecurityAcceptanceDatabaseIdentity,
} from "./browser-staff-account-security-fixture";

const ACCEPTANCE_SCHEMA = "staff_account_security_acceptance_20260825";
const EXCLUSIVE_FLAG = "STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE";
const STATE_FILE = resolve(process.cwd(), ".data", "browser-staff-account-security.json");

type AcceptanceState = {
  phase?: string;
  schemaName?: string;
  databaseIdentity?: StaffAccountSecurityAcceptanceDatabaseIdentity;
  appUrl?: string;
};

export function assertPreparedStaffAccountSecurityAcceptanceState(
  state: AcceptanceState,
  current: {
    databaseIdentity: StaffAccountSecurityAcceptanceDatabaseIdentity;
    appUrl: string;
  },
) {
  if (state.phase !== "PREPARED") {
    throw new Error("Run acceptance:staff-account-security:setup before starting the acceptance application.");
  }
  if (state.schemaName !== ACCEPTANCE_SCHEMA) {
    throw new Error("The prepared state does not target the isolated staff account security acceptance schema.");
  }
  if (JSON.stringify(state.databaseIdentity) !== JSON.stringify(current.databaseIdentity)) {
    throw new Error("The prepared staff account security state belongs to a different database. Run cleanup with the original DATABASE_URL, then set up again.");
  }
  if (state.appUrl !== current.appUrl) {
    throw new Error("APP_URL differs from the value used during staff account security acceptance setup. Restore that APP_URL or set up again.");
  }
  return {
    phase: "PREPARED" as const,
    schemaName: ACCEPTANCE_SCHEMA,
    databaseIdentity: current.databaseIdentity,
    appUrl: current.appUrl,
  };
}

export function assertNoStaffAccountSecurityAcceptanceAddressOverrides(arguments_: string[]) {
  if (arguments_.some((argument) => (
    ["--port", "-p", "--hostname", "-H"].includes(argument)
    || argument.startsWith("--port=")
    || argument.startsWith("--hostname=")
  ))) {
    throw new Error("The acceptance application host and port come from the APP_URL saved during setup.");
  }
  return arguments_;
}

async function main() {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  assertSafeStaffAccountSecurityAcceptanceDatabase(
    baseDatabaseUrl,
    process.env[EXCLUSIVE_FLAG],
  );
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required.");
  const current = {
    databaseIdentity: staffAccountSecurityAcceptanceDatabaseIdentity(baseDatabaseUrl),
    appUrl: new URL(process.env.APP_URL ?? "http://localhost:3000").origin,
  };
  const state = assertPreparedStaffAccountSecurityAcceptanceState(
    JSON.parse(await readFile(STATE_FILE, "utf8")) as AcceptanceState,
    current,
  );
  const applicationUrl = new URL(state.appUrl);
  if (applicationUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(applicationUrl.hostname)) {
    throw new Error("Staff account security Browser acceptance APP_URL must use HTTP on a loopback host.");
  }
  const additionalArguments = assertNoStaffAccountSecurityAcceptanceAddressOverrides(process.argv.slice(2));
  const schemaDatabaseUrl = staffAccountSecurityAcceptanceSchemaUrl(baseDatabaseUrl);
  const probePool = new Pool({ connectionString: schemaDatabaseUrl });
  try {
    const proof = await probePool.query<{ currentSchema: string | null }>(
      "SELECT current_schema() AS \"currentSchema\"",
    );
    if (proof.rows[0].currentSchema !== ACCEPTANCE_SCHEMA) {
      throw new Error("The isolated staff account security acceptance schema is missing from the configured database. Run setup again.");
    }
  } finally {
    await probePool.end();
  }
  const nextCli = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [
    nextCli,
    "dev",
    "--hostname",
    applicationUrl.hostname,
    "--port",
    applicationUrl.port || "80",
    ...additionalArguments,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: schemaDatabaseUrl,
    },
    stdio: "inherit",
  });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  if (exitCode !== 0) process.exitCode = exitCode;
  console.log(`Staff account security acceptance application stopped for schema ${state.schemaName}.`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) await main();
