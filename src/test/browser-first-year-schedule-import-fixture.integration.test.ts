// @vitest-environment node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";

const stateFile = resolve(".data/browser-first-year-ovpsa/state.json");

async function stateExists() {
  try { await access(stateFile); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function operation(mode: "setup" | "cleanup") {
  return await new Promise<{ code: number | null; output: string }>((success, failure) => {
    const child = spawn(process.execPath, ["--import", "tsx",
      "scripts/browser-first-year-ovpsa-fixture.ts", mode], {
      env: { ...process.env, OVPSA_FIRST_YEAR_ACCEPTANCE_EXCLUSIVE_DATABASE: "1" },
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", failure);
    child.once("exit", code => success({ code, output }));
  });
}

it("prepares the explicit 150 fixture and restores its captured 100 baseline with zero clinical residue", async () => {
  expect(await stateExists(), "Another fixture owns the state file").toBe(false);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let ownsYear = false;
  try {
    const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
      VALUES (2026,'2027-07-31','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001')
      ON CONFLICT (start_year) DO NOTHING RETURNING start_year`);
    ownsYear = year.rowCount === 1;
    const maximum = async () => (await pool.query(`SELECT max_daily_capacity FROM clinic_capacity_settings
      WHERE clinic_id='60000000-0000-4000-8000-000000000002' AND schedule_type='PHYSICAL_EXAM'`)).rows[0].max_daily_capacity;
    expect(await maximum()).toBe(100);
    const prepared = await operation("setup");
    expect(prepared.code, prepared.code === 0 ? undefined : prepared.output).toBe(0);
    expect(JSON.parse(await readFile(stateFile, "utf8")).originalCapacity.maximum).toBe(100);
    expect(await maximum()).toBe(150);
    const provenance = (await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number LIKE '86-9%') AS snapshots,
      (SELECT COUNT(*)::int FROM laboratory_checklists WHERE student_number LIKE '86-9%') AS checklists`)).rows[0];
    expect(provenance).toEqual({ snapshots: 4, checklists: 4 });
    const cleaned = await operation("cleanup");
    expect(cleaned.code, cleaned.code === 0 ? undefined : cleaned.output).toBe(0);
    expect(await maximum()).toBe(100);
    expect(await stateExists()).toBe(false);
    expect(Object.values(JSON.parse(cleaned.output).residue).every(value => value === 0)).toBe(true);
    expect((await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number LIKE '86-9%') AS snapshots,
      (SELECT COUNT(*)::int FROM laboratory_checklists WHERE student_number LIKE '86-9%') AS checklists`)).rows[0])
      .toEqual({ snapshots: 0, checklists: 0 });
    expect((await pool.query(`SELECT COUNT(*)::int AS disabled FROM pg_trigger
      WHERE tgname IN ('laboratory_checklist_events_immutable','laboratory_checklist_links_immutable',
                       'laboratory_checklist_identity_immutable') AND tgenabled<>'O'`)).rows[0].disabled).toBe(0);
  } finally {
    try {
      if (await stateExists()) {
        const cleaned = await operation("cleanup");
        if (cleaned.code !== 0) throw new Error(cleaned.output);
      }
      if (ownsYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
    } finally { await pool.end(); }
  }
}, 60_000);
