// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { syntheticTestEnvironment } from "../src/test/environment";
import { sqlFiles } from "./db-common";
import { withDisposableTestDatabase } from "./test-database";

const root = process.cwd();
const unreachableUrl = "postgresql://synthetic:synthetic@127.0.0.1:1/medclinic_test_reset";

async function runCommand(args: string[], cwd: string, overrides: Partial<NodeJS.ProcessEnv>) {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const env = { ...process.env, ...syntheticTestEnvironment, DATABASE_URL: unreachableUrl,
      DB_RESET_DATABASE_URL: undefined, ALLOW_DB_RESET: undefined, ...overrides };
    const child = spawn(process.execPath, args, { cwd, env });
    let output = "";
    child.stdout.on("data", data => { output += data.toString(); });
    child.stderr.on("data", data => { output += data.toString(); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
}

async function runReset(databaseUrl?: string, consent?: string, cwd = root, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return await runCommand(["--import", "tsx", path.join(root, "scripts/db-reset.ts")], cwd, {
    DB_RESET_DATABASE_URL: databaseUrl, ALLOW_DB_RESET: consent, ...overrides,
  });
}
async function withResetDatabase(callback: (client: Client, databaseUrl: string) => Promise<void>) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/medclinic_test_reset_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await withDisposableTestDatabase(async target => {
    const client = new Client({ connectionString: target.targetUrl });
    await client.connect();
    try { await callback(client, target.targetUrl); } finally { await client.end(); }
  }, url.toString(), "1");
}

describe("explicit developer reset CLI", () => {
  it.each([
    { url: unreachableUrl, consent: undefined, message: "Set ALLOW_DB_RESET=true" },
    { url: unreachableUrl, consent: "1", message: "Set ALLOW_DB_RESET=true" },
    { url: undefined, consent: "true", message: "DB_RESET_DATABASE_URL is required" },
    { url: "not a URL", consent: "true", message: "PostgreSQL URL" },
    { url: unreachableUrl.replace("postgresql:", "https:"), consent: "true", message: "PostgreSQL URL" },
    { url: unreachableUrl.replace("127.0.0.1", "remote.example"), consent: "true", message: "loopback" },
    { url: unreachableUrl.replace("synthetic:synthetic@", ""), consent: "true", message: "explicit PostgreSQL role" },
    { url: unreachableUrl.replace(":1/", ":0/"), consent: "true", message: "port must be" },
    { url: unreachableUrl + "?host=remote.example", consent: "true", message: "query parameters and fragments" },
    { url: unreachableUrl + "#", consent: "true", message: "query parameters and fragments" },
    ...["postgres", "template0", "template1", "medclinic_development"].map(database => ({
      url: unreachableUrl.replace("medclinic_test_reset", database), consent: "true", message: "medclinic_test_*",
    })),
  ])("rejects $url with consent $consent before connecting", async ({ url, consent, message }) => {
    const result = await runReset(url, consent);
    expect(result.code).toBe(1);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain("ECONNREFUSED");
  });

  it("rejects an inherited PostgreSQL session override before connecting", async () => {
    const result = await runReset(unreachableUrl, "true", root, { PGOPTIONS: "-c search_path=public" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("PGOPTIONS");
    expect(result.output).not.toContain("ECONNREFUSED");
  });

  it("ignores reset consent and targets in .env.local at the npm entry point", async () => {
    const fixture = path.join(root, ".data", `reset-env-${randomUUID()}`);
    await mkdir(path.join(fixture, "scripts"), { recursive: true });
    try {
      const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({
        type: "module", scripts: { "db:reset": scripts["db:reset"] },
      }));
      await writeFile(path.join(fixture, "scripts/db-reset.ts"), `import "${pathToFileURL(path.join(root, "scripts/db-reset.ts"))}";`);
      await writeFile(path.join(fixture, ".env.local"), `ALLOW_DB_RESET=true\nDB_RESET_DATABASE_URL=${unreachableUrl}\n`);
      const npm = process.env.npm_execpath;
      if (!npm) throw new Error("Run this integration test with npm run test:integration");
      const result = await runCommand([npm, "run", "db:reset"], fixture, {});
      expect(result.code).toBe(1);
      expect(result.output).toContain("Set ALLOW_DB_RESET=true");
      expect(result.output).not.toContain("ECONNREFUSED");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves the schema when the live PostgreSQL port differs from the URL", async () => {
    await withResetDatabase(async (client, databaseUrl) => {
      const url = new URL(databaseUrl);
      await client.query("CREATE TABLE public.reset_identity_sentinel (id integer)");
      const proxy = createServer(socket => {
        const upstream = createConnection({ host: "127.0.0.1", port: Number(url.port) });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP proxy address");
        const proxyUrl = new URL(url);
        proxyUrl.port = String(address.port);
        const result = await runReset(proxyUrl.href, "true", root, { DATABASE_URL: proxyUrl.href });
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain("Live port mismatch");
        expect((await client.query("SELECT to_regclass('public.reset_identity_sentinel') AS sentinel")).rows).toEqual([{ sentinel: "reset_identity_sentinel" }]);
      } finally {
        await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      }
    });
  }, 60_000);

  it("resets a separately owned target twice with the full ledger and canonical reference seed", async () => {
    await withResetDatabase(async (client, databaseUrl) => {
      const expectedLedger = (await sqlFiles(path.join(root, "database/migrations"))).map(file => file.name);
      expect(expectedLedger).toHaveLength(32);
      const snapshot = async () => ({
        ledger: (await client.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map(row => row.name),
        colleges: (await client.query("SELECT id,code,name FROM colleges ORDER BY id")).rows,
        programs: (await client.query("SELECT id,college_id,code,name FROM programs ORDER BY id")).rows,
        clinics: (await client.query("SELECT id,code,name FROM clinics ORDER BY id")).rows,
        counts: (await client.query("SELECT (SELECT COUNT(*)::int FROM users) AS users,(SELECT COUNT(*)::int FROM students) AS students,(SELECT COUNT(*)::int FROM appointments) AS appointments,(SELECT COUNT(*)::int FROM schedule_import_groups) AS imports")).rows[0],
      });
      const first = await runReset(databaseUrl, "true");
      expect(first.code, first.output).toBe(0);
      const before = await snapshot();
      expect(before.ledger).toEqual(expectedLedger);
      expect(before.colleges).toHaveLength(13);
      expect(before.programs).toHaveLength(48);
      expect(before.clinics).toHaveLength(2);
      expect(before.counts).toEqual({ users: 0, students: 0, appointments: 0, imports: 0 });
      await client.query("INSERT INTO students (student_number,first_name,last_name,college_id,program_id) SELECT '99-3107-01','Reset','Sentinel',college_id,id FROM programs LIMIT 1");
      const second = await runReset(databaseUrl, "true");
      expect(second.code, second.output).toBe(0);
      expect(await snapshot()).toEqual(before);
    });
  }, 60_000);

  it("rolls back a failing migration and its ledger entry through the canonical executor", async () => {
    const fixture = path.join(root, ".data", `reset-migrations-${randomUUID()}`);
    await mkdir(path.join(fixture, "database/migrations"), { recursive: true });
    await mkdir(path.join(fixture, "database/seeds"));
    try {
      await writeFile(path.join(fixture, "database/migrations/001_before.sql"), "CREATE TABLE reset_before (id integer);");
      await writeFile(path.join(fixture, "database/migrations/002_failure.sql"), "CREATE TABLE reset_partial (id integer); SELECT 1;");
      // Separate round trips are required to expose a nontransactional ledger failure.
      await withResetDatabase(async (client, databaseUrl) => {
        // The fixture's first migration installs a ledger trigger that rejects the second name.
        await writeFile(path.join(fixture, "database/migrations/001_before.sql"), `CREATE TABLE reset_before (id integer);
          CREATE FUNCTION reject_reset_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.name='002_failure.sql' THEN RAISE EXCEPTION 'SYNTHETIC_RESET_LEDGER_FAILURE'; END IF;
            RETURN NEW; END; $$;
          CREATE TRIGGER reset_ledger_guard BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_reset_ledger();`);
        const result = await runReset(databaseUrl, "true", fixture);
        expect(result.code).toBe(1);
        expect(result.output).toContain("SYNTHETIC_RESET_LEDGER_FAILURE");
        expect((await client.query("SELECT to_regclass('reset_partial') AS partial")).rows[0].partial).toBeNull();
        expect((await client.query("SELECT name FROM schema_migrations ORDER BY name")).rows).toEqual([{ name: "001_before.sql" }]);
        await expect(client.query("SELECT 1 AS reusable")).resolves.toMatchObject({ rows: [{ reusable: 1 }] });
      });
    } finally { await rm(fixture, { recursive: true, force: true }); }
  }, 60_000);
});
