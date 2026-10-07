// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { syntheticTestEnvironment } from "../src/test/environment";
import { sqlFiles } from "./db-common";
import { withDisposableTestDatabase } from "./test-database";

const root = process.cwd();
async function runReset(databaseUrl: string, consent?: string, cwd = root) {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const env = { ...process.env, ...syntheticTestEnvironment, DATABASE_URL: databaseUrl, ALLOW_DB_RESET: consent };
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts/db-reset.ts")], { cwd, env });
    let output = "";
    child.stdout.on("data", data => { output += data.toString(); });
    child.stderr.on("data", data => { output += data.toString(); });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, output }));
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
    { database: "medclinic_test_no_consent", consent: undefined, message: "Set ALLOW_DB_RESET=true" },
    ...["postgres", "template0", "template1"].map(database => ({ database, consent: "true", message: `Refusing to reset protected database: ${database}` })),
  ])("rejects $database before an unreachable connection", async ({ database, consent, message }) => {
    const result = await runReset(`postgresql://synthetic:synthetic@127.0.0.1:1/${database}`, consent);
    expect(result.code).toBe(1);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain("ECONNREFUSED");
  });

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
