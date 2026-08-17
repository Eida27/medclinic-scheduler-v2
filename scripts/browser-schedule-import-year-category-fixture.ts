import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const HEADERS = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";

export const scheduleImportYearCategoryStudentNumbers = [
  "96-8501-05",
  "96-8201-02",
  "96-8401-04",
  "96-8402-04",
  "96-8301-03",
  "96-8302-03",
] as const;

export const scheduleImportYearCategoryCsvFiles = {
  "year-5-unsupported.csv": `${HEADERS}\r\n96-8501-05,Unsupported,Year,Five,,College of Computer Studies,BSIT,5,2004-01-05\r\n`,
  "mixed-year-2-4.csv": `${HEADERS}\r\n96-8201-02,Mixed,Year,Two,,College of Computer Studies,BSIT,2,2005-01-02\r\n96-8401-04,Mixed,Year,Four,,College of Computer Studies,BSIT,4,2003-01-04\r\n`,
  "year-4-ojt.csv": `${HEADERS}\r\n96-8402-04,Valid,Ojt,Four,,College of Computer Studies,BSIT,4,2003-02-04\r\n`,
  "year-3-regular.csv": `${HEADERS}\r\n96-8301-03,Valid,Regular,Three,,College of Computer Studies,BSIT,3,2004-03-03\r\n`,
  "year-3-tour.csv": `${HEADERS}\r\n96-8302-03,Valid,Tour,Three,,College of Computer Studies,BSIT,3,2004-04-03\r\n`,
} as const;

export const scheduleImportYearCategoryFixtureDirectory = resolve(
  process.cwd(),
  ".data",
  "browser-schedule-import-year-category",
);

const STATE_FILE = resolve(scheduleImportYearCategoryFixtureDirectory, "state.json");

type State = {
  databaseIdentity: string;
  startedAt: string;
};

function databaseIdentity(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Schedule import year/category acceptance requires loopback PostgreSQL.");
  }
  if (process.env.SCHEDULE_IMPORT_VALIDATION_ACCEPTANCE_EXCLUSIVE_DATABASE !== "1") {
    throw new Error(
      "Set SCHEDULE_IMPORT_VALIDATION_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a dedicated local acceptance database.",
    );
  }
  return `${parsed.protocol}//${host}:${parsed.port || "5432"}/${decodeURI(parsed.pathname.slice(1))}`;
}

async function readState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fixtureDirectoryExists() {
  try {
    await stat(scheduleImportYearCategoryFixtureDirectory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function residue(client: pg.Client) {
  const filenames = Object.keys(scheduleImportYearCategoryCsvFiles);
  const result = await client.query<{
    imports: number;
    students: number;
    snapshots: number;
    appointments: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=ANY($1::text[])) AS imports,
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($2::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number=ANY($2::varchar[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($2::varchar[])) AS appointments`,
    [filenames, scheduleImportYearCategoryStudentNumbers],
  );
  return result.rows[0];
}

function assertZero(value: Awaited<ReturnType<typeof residue>>) {
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`Schedule import year/category fixture residue remains: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function setup(client: pg.Client, identity: string) {
  if (await readState()) throw new Error("Run cleanup before preparing this Browser fixture again.");
  if (await fixtureDirectoryExists()) {
    throw new Error("Untracked schedule import fixture files exist; remove them before setup.");
  }
  const zeroResidue = assertZero(await residue(client));
  await mkdir(scheduleImportYearCategoryFixtureDirectory, { recursive: true });
  for (const [filename, csv] of Object.entries(scheduleImportYearCategoryCsvFiles)) {
    await writeFile(resolve(scheduleImportYearCategoryFixtureDirectory, filename), csv, "utf8");
  }
  const state = { databaseIdentity: identity, startedAt: new Date().toISOString() };
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    mode: "setup",
    directory: scheduleImportYearCategoryFixtureDirectory,
    files: Object.fromEntries(
      Object.keys(scheduleImportYearCategoryCsvFiles).map((filename) => [
        filename,
        resolve(scheduleImportYearCategoryFixtureDirectory, filename),
      ]),
    ),
    residue: zeroResidue,
  };
}

async function status(client: pg.Client) {
  const state = await readState();
  if (!state) throw new Error("Fixture state is missing; run setup first.");
  const files = (await readdir(scheduleImportYearCategoryFixtureDirectory))
    .filter((filename) => filename.endsWith(".csv"))
    .sort();
  const expectedFiles = Object.keys(scheduleImportYearCategoryCsvFiles).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Schedule import fixture files differ: ${JSON.stringify(files)}.`);
  }
  return { mode: "status", files, residue: assertZero(await residue(client)) };
}

async function cleanup(client: pg.Client) {
  const state = await readState();
  if (!state) throw new Error("Fixture state is missing; refusing untracked cleanup.");
  const zeroResidue = assertZero(await residue(client));
  await rm(scheduleImportYearCategoryFixtureDirectory, { recursive: true });
  return { mode: "cleanup", residue: zeroResidue };
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error("Use setup, status, or cleanup for the schedule import year/category Browser fixture.");
  }
  const identity = databaseIdentity(process.env.DATABASE_URL);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const state = await readState();
    if (state && state.databaseIdentity !== identity) {
      throw new Error("The fixture state belongs to a different database.");
    }
    const result = mode === "setup"
      ? await setup(client, identity)
      : mode === "status"
        ? await status(client)
        : await cleanup(client);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

const directRunPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (directRunPath === fileURLToPath(import.meta.url)) await main();
