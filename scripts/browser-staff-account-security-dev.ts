import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  assertSafeStaffAccountSecurityAcceptanceDatabase,
  staffAccountSecurityAcceptanceSchemaUrl,
} from "./browser-staff-account-security-fixture";

const ACCEPTANCE_SCHEMA = "staff_account_security_acceptance_20260825";
const EXCLUSIVE_FLAG = "STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE";
const STATE_FILE = resolve(process.cwd(), ".data", "browser-staff-account-security.json");

type AcceptanceState = {
  phase?: string;
  schemaName?: string;
};

export function assertPreparedStaffAccountSecurityAcceptanceState(state: AcceptanceState) {
  if (state.phase !== "PREPARED") {
    throw new Error("Run acceptance:staff-account-security:setup before starting the acceptance application.");
  }
  if (state.schemaName !== ACCEPTANCE_SCHEMA) {
    throw new Error("The prepared state does not target the isolated staff account security acceptance schema.");
  }
  return { phase: "PREPARED" as const, schemaName: ACCEPTANCE_SCHEMA };
}

async function main() {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  assertSafeStaffAccountSecurityAcceptanceDatabase(
    baseDatabaseUrl,
    process.env[EXCLUSIVE_FLAG],
  );
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required.");
  const state = assertPreparedStaffAccountSecurityAcceptanceState(
    JSON.parse(await readFile(STATE_FILE, "utf8")) as AcceptanceState,
  );
  const nextCli = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: staffAccountSecurityAcceptanceSchemaUrl(baseDatabaseUrl),
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
