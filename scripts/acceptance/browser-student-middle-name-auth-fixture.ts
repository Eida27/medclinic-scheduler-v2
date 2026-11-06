import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const FIXTURE_DIRECTORY = resolve(".data/browser-student-middle-name-auth");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const MISSING_MIDDLE_NAME_CSV = resolve(FIXTURE_DIRECTORY, "STUDENT-AUTH-MISSING-MIDDLE.csv");
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REFERENCE_COLLEGE_ID = "10000000-0000-4000-8000-000000000003";
const REFERENCE_PROGRAM_ID = "20000000-0000-4000-8000-000000000003";

export const STUDENT_AUTH_ACCEPTANCE_FIXTURE = {
  studentNumber: "99-9701-01",
  dateOfBirth: "2004-08-04",
  middleName: "Maria Angela",
  missingMiddleNameStudentNumber: "99-9702-02",
  missingMiddleNameFilename: "STUDENT-AUTH-MISSING-MIDDLE.csv",
} as const;

export type StudentAuthAcceptanceDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

export type StudentAuthAcceptanceResidue = {
  students: number;
  loginAttempts: number;
  imports: number;
};

type StudentAuthAcceptanceState = {
  databaseIdentity: StudentAuthAcceptanceDatabaseIdentity;
};

export function normalizeStudentAuthAcceptanceDatabaseIdentity(
  databaseUrl: string,
): StudentAuthAcceptanceDatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the PostgreSQL scheme.");
  }
  const hasDestinationOverride = [...parsed.searchParams.keys()].some((parameter) => {
    const normalized = parameter.toLocaleLowerCase();
    return normalized === "host" || normalized === "port";
  });
  if (hasDestinationOverride) {
    throw new Error("DATABASE_URL must not use host or port query parameters.");
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLocaleLowerCase();
  let database: string;
  try {
    database = decodeURI(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL must contain a valid database name.");
  }
  if (!host || !database) {
    throw new Error("DATABASE_URL must contain a host and database name.");
  }
  return {
    scheme: "postgresql",
    host,
    port: parsed.port || "5432",
    database,
  };
}

export function assertSafeStudentAuthAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveDatabase: string | undefined,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  }
  const identity = normalizeStudentAuthAcceptanceDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Student auth acceptance requires a PostgreSQL database on a loopback host.");
  }
  if (exclusiveDatabase !== "1") {
    throw new Error(
      "Set STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a local database dedicated to student auth acceptance.",
    );
  }
  return identity;
}

function assertMatchingDatabaseIdentity(
  current: StudentAuthAcceptanceDatabaseIdentity,
  persisted: StudentAuthAcceptanceDatabaseIdentity,
) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) {
    throw new Error("The current acceptance database does not match the prepared fixture database.");
  }
}

export function createMissingMiddleNameCsv() {
  return [
    "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
    `${STUDENT_AUTH_ACCEPTANCE_FIXTURE.missingMiddleNameStudentNumber},Browser,Missing,,,College of Computer Studies,BSIT,3,2004-08-04`,
  ].join("\n");
}

export function assertZeroStudentAuthAcceptanceResidue(residue: StudentAuthAcceptanceResidue) {
  if (Object.values(residue).some((count) => count !== 0)) {
    throw new Error(`Student auth acceptance cleanup residue remains: ${JSON.stringify(residue)}.`);
  }
  return residue;
}

async function readState(): Promise<StudentAuthAcceptanceState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as StudentAuthAcceptanceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function residue(client: PoolClient): Promise<StudentAuthAcceptanceResidue> {
  const result = await client.query<StudentAuthAcceptanceResidue>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_login_attempts WHERE student_number=ANY($1::varchar[])) AS "loginAttempts",
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename=$2) AS imports`,
    [[
      STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber,
      STUDENT_AUTH_ACCEPTANCE_FIXTURE.missingMiddleNameStudentNumber,
    ], STUDENT_AUTH_ACCEPTANCE_FIXTURE.missingMiddleNameFilename],
  );
  return result.rows[0];
}

async function removeFixtureRows(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM student_login_attempts WHERE student_number=ANY($1::varchar[])",
      [[
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber,
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.missingMiddleNameStudentNumber,
      ]],
    );
    await client.query(
      "DELETE FROM students WHERE student_number=ANY($1::varchar[])",
      [[
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber,
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.missingMiddleNameStudentNumber,
      ]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function prepare(pool: Pool, databaseIdentity: StudentAuthAcceptanceDatabaseIdentity) {
  const client = await pool.connect();
  try {
    const state = await readState();
    if (state) {
      assertMatchingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
      await removeFixtureRows(client);
      assertZeroStudentAuthAcceptanceResidue(await residue(client));
    } else {
      const existing = await residue(client);
      if (existing.students || existing.loginAttempts || existing.imports) {
        throw new Error(
          `Refusing to overwrite an untracked student auth acceptance fixture: ${JSON.stringify(existing)}.`,
        );
      }
    }

    await mkdir(FIXTURE_DIRECTORY, { recursive: true });
    await writeFile(
      STATE_FILE,
      `${JSON.stringify({ databaseIdentity } satisfies StudentAuthAcceptanceState, null, 2)}\n`,
      "utf8",
    );
    await writeFile(MISSING_MIDDLE_NAME_CSV, createMissingMiddleNameCsv(), "utf8");
    await client.query(
      `INSERT INTO students (
         student_number, first_name, middle_name, last_name,
         college_id, program_id, year_level, date_of_birth
       ) VALUES ($1,'Auth','Maria Angela','Browser',$2,$3,3,$4::date)`,
      [
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber,
        REFERENCE_COLLEGE_ID,
        REFERENCE_PROGRAM_ID,
        STUDENT_AUTH_ACCEPTANCE_FIXTURE.dateOfBirth,
      ],
    );
    return {
      mode: "prepare",
      databaseIdentity,
      studentNumber: STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber,
      dateOfBirth: STUDENT_AUTH_ACCEPTANCE_FIXTURE.dateOfBirth,
      middleName: STUDENT_AUTH_ACCEPTANCE_FIXTURE.middleName,
      missingMiddleNameCsv: MISSING_MIDDLE_NAME_CSV,
    };
  } finally {
    client.release();
  }
}

async function status(pool: Pool, databaseIdentity: StudentAuthAcceptanceDatabaseIdentity) {
  const state = await readState();
  if (!state) throw new Error("Prepare the student auth acceptance fixture first.");
  assertMatchingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try {
    const student = await client.query<{
      studentNumber: string;
      middleName: string | null;
      dateOfBirth: string | null;
      isActive: boolean;
    }>(
      `SELECT student_number AS "studentNumber", middle_name AS "middleName",
              date_of_birth::text AS "dateOfBirth", is_active AS "isActive"
         FROM students WHERE student_number=$1`,
      [STUDENT_AUTH_ACCEPTANCE_FIXTURE.studentNumber],
    );
    return {
      mode: "status",
      databaseIdentity,
      student: student.rows[0] ?? null,
      residue: await residue(client),
    };
  } finally {
    client.release();
  }
}

async function cleanup(pool: Pool, databaseIdentity: StudentAuthAcceptanceDatabaseIdentity) {
  const state = await readState();
  if (!state) throw new Error("Prepare the student auth acceptance fixture before cleanup.");
  assertMatchingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try {
    await removeFixtureRows(client);
    const proof = assertZeroStudentAuthAcceptanceResidue(await residue(client));
    await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
    return { mode: "cleanup", databaseIdentity, residue: proof };
  } finally {
    client.release();
  }
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["prepare", "status", "cleanup"].includes(mode)) {
    throw new Error(
      "Use prepare, status, or cleanup with a loopback PostgreSQL DATABASE_URL and STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE=1.",
    );
  }
  const databaseIdentity = assertSafeStudentAuthAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env.STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE,
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const output = mode === "prepare" ? await prepare(pool, databaseIdentity)
      : mode === "status" ? await status(pool, databaseIdentity)
        : await cleanup(pool, databaseIdentity);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await run();
}
