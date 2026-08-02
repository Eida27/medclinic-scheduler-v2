import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const FIXTURE_DIRECTORY = resolve(".data/browser-reports-acceptance");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const CURRENT_COLLEGE_ID = "10000000-0000-4000-8000-000000000003";
const CURRENT_PROGRAM_ID = "20000000-0000-4000-8000-000000000003";
const HISTORICAL_COLLEGE_IDS = [
  "b8100000-0000-4000-8000-000000000001",
  "b8100000-0000-4000-8000-000000000002",
] as const;
const HISTORICAL_PROGRAM_IDS = [
  "b8200000-0000-4000-8000-000000000001",
  "b8200000-0000-4000-8000-000000000002",
] as const;

const studentNumbers = Array.from({ length: 153 }, (_, index) =>
  `B-RPT-${String(index + 1).padStart(4, "0")}`);
const appointmentIds = Array.from({ length: 165 }, (_, index) =>
  `b8300000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const snapshotIds = Array.from({ length: 157 }, (_, index) =>
  `b8400000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);

export const REPORTS_ACCEPTANCE_FIXTURE = {
  marker: "BROWSER-REPORTS-ACCEPTANCE-V1",
  studentPrefix: "B-RPT-",
  studentNumbers,
  appointmentIds,
  snapshotIds,
  paginationCount: 153,
  years: {
    closed: { startYear: 2020, label: "2020–2021", closingDate: "2021-07-31" },
    open: { startYear: 2098, label: "2098–2099", closingDate: "2099-07-31" },
  },
  crudScratch: { startYear: 2097, closingDate: "2098-07-31" },
  expected: {
    replacement: {
      studentNumber: "B-RPT-0001",
      classification: "COMPLIED",
      laboratoryStatus: "COMPLETED",
      dataQuality: "VERIFIED_HISTORICAL",
    },
    historicalDivergence: {
      studentNumber: "B-RPT-0002",
      currentCollege: "College of Computer Studies",
      currentProgram: "Bachelor of Science in Information Technology",
      historicalCollege: "Archived College of Health Sciences",
      historicalProgram: "Archived Clinical Sciences",
      classification: "DID_NOT_COMPLY_BOTH",
      dataQuality: "RECOVERED_HISTORICAL",
    },
    migratedIncomplete: {
      studentNumber: "B-RPT-0003",
      classification: "DID_NOT_COMPLY_PHYSICAL_EXAM",
      dataQuality: "MIGRATED_INCOMPLETE",
    },
    laboratoryOnly: {
      studentNumber: "B-RPT-0004",
      classification: "DID_NOT_COMPLY_LABORATORY",
      dataQuality: "VERIFIED_HISTORICAL",
    },
    completed: {
      studentNumber: "B-RPT-0005",
      classification: "COMPLIED",
      dataQuality: "RECOVERED_HISTORICAL",
    },
  },
} as const;

export type ReportsAcceptanceDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

export type ReportsAcceptanceResidue = {
  students: number;
  snapshots: number;
  appointments: number;
  academicYears: number;
  crudScratchYears: number;
  auditLogs: number;
  stateFiles: number;
};

type FixtureState = {
  marker: typeof REPORTS_ACCEPTANCE_FIXTURE.marker;
  databaseIdentity: ReportsAcceptanceDatabaseIdentity;
  preparedAt: string;
};

type StudentSeed = {
  student_number: string;
  first_name: string;
  last_name: string;
  year_level: number;
  is_active: boolean;
};

type SnapshotSeed = {
  id: string;
  student_number: string;
  academic_year_start: number;
  student_name: string;
  college_id: string;
  college_name: string;
  program_id: string;
  program_code: string;
  program_name: string;
  year_level: number;
  source_type: "VERIFIED_HISTORICAL" | "RECOVERED_HISTORICAL" | "MIGRATED_INCOMPLETE";
};

type AppointmentSeed = {
  id: string;
  clinic_id: string;
  student_number: string;
  schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
  appointment_date: string;
  status: "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
  is_published: boolean;
  rescheduled_from: string | null;
  schedule_cycle_start: number;
};

export function normalizeReportsAcceptanceDatabaseIdentity(
  databaseUrl: string,
): ReportsAcceptanceDatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the PostgreSQL scheme.");
  }
  if ([...parsed.searchParams.keys()].some((key) => ["host", "port"].includes(key.toLowerCase()))) {
    throw new Error("DATABASE_URL must not use host or port query parameters.");
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  let database: string;
  try {
    database = decodeURI(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL must contain a valid database name.");
  }
  if (!host || !database) throw new Error("DATABASE_URL must contain a host and database name.");
  return { scheme: "postgresql", host, port: parsed.port || "5432", database };
}

export function assertSafeReportsAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveDatabase: string | undefined,
) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  const identity = normalizeReportsAcceptanceDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Reports acceptance requires a PostgreSQL database on a loopback host.");
  }
  if (exclusiveDatabase !== "1") {
    throw new Error(
      "Set REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a local database dedicated to reports acceptance.",
    );
  }
  return identity;
}

export function assertMatchingReportsAcceptanceDatabaseIdentity(
  current: ReportsAcceptanceDatabaseIdentity,
  persisted: ReportsAcceptanceDatabaseIdentity,
) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) {
    throw new Error("The current database identity does not match the prepared reports fixture database.");
  }
}

export function assertZeroReportsAcceptanceResidue<T extends ReportsAcceptanceResidue>(residue: T) {
  if (Object.values(residue).some((count) => count !== 0)) {
    throw new Error(`Reports acceptance cleanup residue remains: ${JSON.stringify(residue)}.`);
  }
  return residue;
}

export function isReportsAcceptanceFixtureOwned(statePresent: boolean, markerAuditCount: number) {
  if (!Number.isInteger(markerAuditCount) || markerAuditCount < 0 || markerAuditCount > 1) {
    throw new Error("Reports fixture setup marker count is invalid; refusing destructive ownership.");
  }
  return statePresent || markerAuditCount === 1;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readState(): Promise<FixtureState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as FixtureState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state: FixtureState) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sourceType(index: number): SnapshotSeed["source_type"] {
  if (index === 1) return "VERIFIED_HISTORICAL";
  if (index === 2) return "RECOVERED_HISTORICAL";
  if (index === 3) return "MIGRATED_INCOMPLETE";
  return ["VERIFIED_HISTORICAL", "RECOVERED_HISTORICAL", "MIGRATED_INCOMPLETE"][
    (index - 1) % 3
  ] as SnapshotSeed["source_type"];
}

function students(): StudentSeed[] {
  return studentNumbers.map((studentNumber, offset) => {
    const index = offset + 1;
    return {
      student_number: studentNumber,
      first_name: index === 2 ? "Current Divergent" : `Browser ${String(index).padStart(4, "0")}`,
      last_name: index === 2 ? "Profile" : "Reports Fixture",
      year_level: index === 2 ? 4 : ((index - 1) % 4) + 1,
      is_active: index !== 2 && index !== 3,
    };
  });
}

function snapshotLabels(index: number) {
  const first = index === 2 || index % 2 === 1;
  return first ? {
    collegeId: HISTORICAL_COLLEGE_IDS[0],
    collegeName: "Archived College of Health Sciences",
    programId: HISTORICAL_PROGRAM_IDS[0],
    programCode: "ACS",
    programName: "Archived Clinical Sciences",
  } : {
    collegeId: HISTORICAL_COLLEGE_IDS[1],
    collegeName: "Former College of Community Wellness",
    programId: HISTORICAL_PROGRAM_IDS[1],
    programCode: "CHW",
    programName: "Community Health and Wellness",
  };
}

function snapshots(): SnapshotSeed[] {
  const closed = studentNumbers.map((studentNumber, offset) => {
    const index = offset + 1;
    const labels = snapshotLabels(index);
    const specialNames: Record<number, string> = {
      1: "Acceptance, Replacement Student",
      2: "Historical, Graduated Student",
      3: "Migration, Incomplete Student",
      4: "Laboratory, Incomplete Student",
      5: "Acceptance, Completed Student",
    };
    return {
      id: snapshotIds[offset],
      student_number: studentNumber,
      academic_year_start: REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
      student_name: specialNames[index] ?? "Pagination Tie, Student",
      college_id: labels.collegeId,
      college_name: labels.collegeName,
      program_id: labels.programId,
      program_code: labels.programCode,
      program_name: labels.programName,
      year_level: ((index - 1) % 4) + 1,
      source_type: sourceType(index),
    };
  });
  const open = studentNumbers.slice(0, 4).map((studentNumber, offset) => {
    const index = offset + 1;
    const labels = snapshotLabels(index);
    return {
      id: snapshotIds[153 + offset],
      student_number: studentNumber,
      academic_year_start: REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear,
      student_name: `Open Year, Student ${String(index).padStart(2, "0")}`,
      college_id: labels.collegeId,
      college_name: labels.collegeName,
      program_id: labels.programId,
      program_code: labels.programCode,
      program_name: labels.programName,
      year_level: index,
      source_type: sourceType(index),
    };
  });
  return [...closed, ...open];
}

function appointments(): AppointmentSeed[] {
  let idIndex = 0;
  const next = (input: Omit<AppointmentSeed, "id">): AppointmentSeed => ({
    id: appointmentIds[idIndex++],
    ...input,
  });
  const rows: AppointmentSeed[] = studentNumbers.map((studentNumber, offset) => {
    const index = offset + 1;
    const status = index === 1 ? "NO_SHOW"
      : index === 3 || index === 5 ? "COMPLETED" : "PENDING";
    return next({
      clinic_id: LABORATORY_CLINIC_ID,
      student_number: studentNumber,
      schedule_type: "LABORATORY",
      appointment_date: `2020-09-${String(((index - 1) % 28) + 1).padStart(2, "0")}`,
      status,
      is_published: true,
      rescheduled_from: null,
      schedule_cycle_start: REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
    });
  });
  rows.push(
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[0],
      schedule_type: "LABORATORY", appointment_date: "2020-10-15", status: "COMPLETED",
      is_published: true, rescheduled_from: appointmentIds[0], schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[0],
      schedule_type: "LABORATORY", appointment_date: "2021-07-15", status: "NO_SHOW",
      is_published: false, rescheduled_from: null, schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[0],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2020-10-16", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[2],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2020-10-17", status: "NO_SHOW",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[3],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2020-10-18", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[4],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2020-10-19", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2020,
    }),
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[0],
      schedule_type: "LABORATORY", appointment_date: "2098-09-01", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[0],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2098-09-02", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[1],
      schedule_type: "LABORATORY", appointment_date: "2098-09-03", status: "PENDING",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[2],
      schedule_type: "LABORATORY", appointment_date: "2098-09-04", status: "NO_SHOW",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
    next({
      clinic_id: PHYSICAL_EXAM_CLINIC_ID, student_number: studentNumbers[2],
      schedule_type: "PHYSICAL_EXAM", appointment_date: "2098-09-05", status: "COMPLETED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
    next({
      clinic_id: LABORATORY_CLINIC_ID, student_number: studentNumbers[3],
      schedule_type: "LABORATORY", appointment_date: "2098-09-06", status: "CANCELLED",
      is_published: true, rescheduled_from: null, schedule_cycle_start: 2098,
    }),
  );
  if (idIndex !== appointmentIds.length) {
    throw new Error(`Reports fixture appointment contract drifted: expected ${appointmentIds.length}, got ${idIndex}.`);
  }
  return rows;
}

async function assertRequiredSchemaAndReferences(client: PoolClient) {
  const schema = await client.query<{ academicYears: string | null; snapshots: string | null }>(
    `SELECT to_regclass('academic_years')::text AS "academicYears",
            to_regclass('student_academic_snapshots')::text AS snapshots`,
  );
  if (!schema.rows[0]?.academicYears || !schema.rows[0]?.snapshots) {
    throw new Error("Migration 016 must be applied to the local acceptance database before setup.");
  }
  const references = await client.query<{ users: number; clinics: number; colleges: number; programs: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=$1 AND role='ADMIN') AS users,
       (SELECT COUNT(*)::int FROM clinics WHERE id=ANY($2::uuid[])) AS clinics,
       (SELECT COUNT(*)::int FROM colleges WHERE id=$3) AS colleges,
       (SELECT COUNT(*)::int FROM programs WHERE id=$4 AND college_id=$3) AS programs`,
    [ADMIN_USER_ID, [LABORATORY_CLINIC_ID, PHYSICAL_EXAM_CLINIC_ID], CURRENT_COLLEGE_ID, CURRENT_PROGRAM_ID],
  );
  if (Object.values(references.rows[0]).some((count, index) => count !== (index === 1 ? 2 : 1))) {
    throw new Error("Reports fixture requires the standard local admin, clinics, CCS college, and BSIT program seeds.");
  }
}

async function fixtureOwnershipExists(client: PoolClient) {
  const result = await client.query<{ markerCount: number }>(
    `SELECT COUNT(*)::int AS "markerCount"
       FROM audit_logs WHERE action='BROWSER_REPORTS_FIXTURE_SETUP'
        AND entity_type='acceptance_fixture' AND entity_id=$1`,
    [REPORTS_ACCEPTANCE_FIXTURE.marker],
  );
  return isReportsAcceptanceFixtureOwned(false, result.rows[0].markerCount);
}

async function assertReservedScopeAvailable(client: PoolClient) {
  if (await fixtureOwnershipExists(client)) return;
  const reservedYears = [
    REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
    REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear,
    REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear,
  ];
  const collision = await client.query<{
    years: number; audits: number; students: number; snapshots: number; appointments: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=ANY($1::int[])) AS years,
       (SELECT COUNT(*)::int FROM audit_logs
         WHERE (entity_type='academic_year' AND entity_id=ANY($2::text[]))
            OR metadata::text LIKE $3) AS audits,
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $4) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE id=ANY($5::uuid[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments WHERE id=ANY($6::uuid[])) AS appointments`,
    [reservedYears, reservedYears.map(String), `%${REPORTS_ACCEPTANCE_FIXTURE.marker}%`,
      `${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`, snapshotIds, appointmentIds],
  );
  if (Object.values(collision.rows[0]).some((count) => count !== 0)) {
    throw new Error("Reports fixture reserved IDs or academic years already exist without fixture ownership; refusing to overwrite them.");
  }
}

async function insertFixtureRows(client: PoolClient) {
  const yearRows = [REPORTS_ACCEPTANCE_FIXTURE.years.closed, REPORTS_ACCEPTANCE_FIXTURE.years.open];
  await client.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     SELECT row.start_year,row.closing_date::date,$2,$2
       FROM jsonb_to_recordset($1::jsonb) AS row(start_year int,closing_date text)
     ON CONFLICT (start_year) DO NOTHING`,
    [JSON.stringify(yearRows.map((year) => ({
      start_year: year.startYear, closing_date: year.closingDate,
    }))), ADMIN_USER_ID],
  );
  await client.query(
    `INSERT INTO students (
       student_number,first_name,last_name,college_id,program_id,year_level,is_active
     ) SELECT row.student_number,row.first_name,row.last_name,$2,$3,row.year_level,row.is_active
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number text,first_name text,last_name text,year_level int,is_active boolean
         )
     ON CONFLICT (student_number) DO UPDATE SET
       first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
       college_id=EXCLUDED.college_id,program_id=EXCLUDED.program_id,
       year_level=EXCLUDED.year_level,is_active=EXCLUDED.is_active`,
    [JSON.stringify(students()), CURRENT_COLLEGE_ID, CURRENT_PROGRAM_ID],
  );
  await client.query(
    `INSERT INTO student_academic_snapshots (
       id,student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_type,source_metadata
     ) SELECT row.id,row.student_number,row.academic_year_start,row.student_name,
              row.college_id,row.college_name,row.program_id,row.program_code,row.program_name,
              row.year_level,row.source_type,
              jsonb_build_object('fixtureMarker',$2::text,'historicalEvidenceComplete',
                row.source_type<>'MIGRATED_INCOMPLETE')
         FROM jsonb_to_recordset($1::jsonb) AS row(
           id uuid,student_number text,academic_year_start int,student_name text,
           college_id uuid,college_name text,program_id uuid,program_code text,
           program_name text,year_level int,source_type text
         )
     ON CONFLICT (student_number,academic_year_start) DO NOTHING`,
    [JSON.stringify(snapshots()), REPORTS_ACCEPTANCE_FIXTURE.marker],
  );
  await client.query(
    `INSERT INTO appointments (
       id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       rescheduled_from,schedule_cycle_start,created_by,updated_by,notes
     ) SELECT row.id,row.clinic_id,row.student_number,row.schedule_type,row.appointment_date::date,
              row.status,row.is_published,row.rescheduled_from,row.schedule_cycle_start,$2,$2,$3
         FROM jsonb_to_recordset($1::jsonb) AS row(
           id uuid,clinic_id uuid,student_number text,schedule_type text,appointment_date text,
           status text,is_published boolean,rescheduled_from uuid,schedule_cycle_start int
         )
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(appointments()), ADMIN_USER_ID, REPORTS_ACCEPTANCE_FIXTURE.marker],
  );
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     SELECT $1,'BROWSER_REPORTS_FIXTURE_SETUP','acceptance_fixture',$2::text,
            jsonb_build_object('fixtureMarker',$2::text,'studentCount',$3::int,'paginationCount',$3::int)
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_logs WHERE action='BROWSER_REPORTS_FIXTURE_SETUP'
          AND entity_type='acceptance_fixture' AND entity_id=$2::text
      )`,
    [ADMIN_USER_ID, REPORTS_ACCEPTANCE_FIXTURE.marker, REPORTS_ACCEPTANCE_FIXTURE.paginationCount],
  );
}

async function databaseCounts(client: PoolClient) {
  const years = [REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear];
  const result = await client.query<{
    students: number; snapshots: number; appointments: number; academicYears: number; auditLogs: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE id=ANY($2::uuid[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments WHERE id=ANY($3::uuid[])) AS appointments,
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=ANY($4::int[])) AS "academicYears",
       (SELECT COUNT(*)::int FROM audit_logs WHERE action='BROWSER_REPORTS_FIXTURE_SETUP'
          AND entity_type='acceptance_fixture' AND entity_id=$5) AS "auditLogs"`,
    [studentNumbers, snapshotIds, appointmentIds, years, REPORTS_ACCEPTANCE_FIXTURE.marker],
  );
  return result.rows[0];
}

async function assertFixtureReady(client: PoolClient) {
  const counts = await databaseCounts(client);
  const expected = { students: 153, snapshots: 157, appointments: 165, academicYears: 2, auditLogs: 1 };
  if (JSON.stringify(counts) !== JSON.stringify(expected)) {
    throw new Error(`Reports fixture setup is incomplete: ${JSON.stringify(counts)}.`);
  }
  const special = await client.query<{
    historicalCollege: string; historicalProgram: string; currentCollege: string;
    currentProgram: string; active: boolean;
  }>(
    `SELECT snapshot.college_name AS "historicalCollege",
            snapshot.program_name AS "historicalProgram",college.name AS "currentCollege",
            program.name AS "currentProgram",student.is_active AS active
       FROM student_academic_snapshots snapshot
       JOIN students student ON student.student_number=snapshot.student_number
       JOIN colleges college ON college.id=student.college_id
       JOIN programs program ON program.id=student.program_id
      WHERE snapshot.student_number=$1 AND snapshot.academic_year_start=$2`,
    [REPORTS_ACCEPTANCE_FIXTURE.expected.historicalDivergence.studentNumber,
      REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear],
  );
  if (!special.rows[0] || special.rows[0].active
    || special.rows[0].historicalCollege === special.rows[0].currentCollege
    || special.rows[0].historicalProgram === special.rows[0].currentProgram) {
    throw new Error("Reports fixture historical/current divergence contract is incomplete.");
  }
  return counts;
}

export async function setupReportsAcceptanceFixture(
  pool: Pool,
  databaseIdentity: ReportsAcceptanceDatabaseIdentity,
) {
  const existingState = await readState();
  if (existingState) {
    assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, existingState.databaseIdentity);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertRequiredSchemaAndReferences(client);
    await assertReservedScopeAvailable(client);
    await insertFixtureRows(client);
    const counts = await assertFixtureReady(client);
    await client.query("COMMIT");
    await writeState({
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      databaseIdentity,
      preparedAt: new Date().toISOString(),
    });
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getReportsAcceptanceFixtureStatus(
  pool: Pool,
  databaseIdentity: ReportsAcceptanceDatabaseIdentity,
) {
  const state = await readState();
  if (state) assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try {
    await assertRequiredSchemaAndReferences(client);
    const counts = await assertFixtureReady(client);
    return {
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      years: {
        closed: { ...REPORTS_ACCEPTANCE_FIXTURE.years.closed, state: "CLOSED" as const },
        open: { ...REPORTS_ACCEPTANCE_FIXTURE.years.open, state: "OPEN" as const },
      },
      paginationCount: REPORTS_ACCEPTANCE_FIXTURE.paginationCount,
      pagination: { page1: 150, page2: 3 },
      crudScratch: REPORTS_ACCEPTANCE_FIXTURE.crudScratch,
      expected: REPORTS_ACCEPTANCE_FIXTURE.expected,
      counts: {
        students: counts.students,
        snapshots: counts.snapshots,
        appointments: counts.appointments,
        academicYears: counts.academicYears,
      },
      stateFile: Boolean(state),
    };
  } finally {
    client.release();
  }
}

async function residueCounts(client: PoolClient): Promise<Omit<ReportsAcceptanceResidue, "stateFiles">> {
  const years = [REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear];
  const auditYears = [...years, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear].map(String);
  const result = await client.query<Omit<ReportsAcceptanceResidue, "stateFiles">>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots
         WHERE id=ANY($2::uuid[]) OR student_number=ANY($1::varchar[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments
         WHERE id=ANY($3::uuid[]) OR student_number=ANY($1::varchar[])) AS appointments,
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=ANY($4::int[])) AS "academicYears",
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=$5) AS "crudScratchYears",
       (SELECT COUNT(*)::int FROM audit_logs
         WHERE (entity_type='academic_year' AND entity_id=ANY($6::text[]))
            OR (entity_type='acceptance_fixture' AND entity_id=$7)
            OR metadata::text LIKE $8) AS "auditLogs"`,
    [studentNumbers, snapshotIds, appointmentIds, years,
      REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear, auditYears,
      REPORTS_ACCEPTANCE_FIXTURE.marker, `%${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`],
  );
  return result.rows[0];
}

export async function cleanupReportsAcceptanceFixture(
  pool: Pool,
  databaseIdentity: ReportsAcceptanceDatabaseIdentity,
) {
  const state = await readState();
  if (state) assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertRequiredSchemaAndReferences(client);
    const owned = Boolean(state) || await fixtureOwnershipExists(client);
    if (owned) {
      const years = [REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear];
      const auditYears = [...years, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear].map(String);
      await client.query(
        `DELETE FROM audit_logs
          WHERE (entity_type='academic_year' AND entity_id=ANY($1::text[]))
             OR (entity_type='acceptance_fixture' AND entity_id=$2)
             OR metadata::text LIKE $3 OR metadata::text LIKE $4`,
        [auditYears, REPORTS_ACCEPTANCE_FIXTURE.marker,
          `%${REPORTS_ACCEPTANCE_FIXTURE.marker}%`, `%${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`],
      );
      await client.query(
        "DELETE FROM appointments WHERE id=ANY($1::uuid[]) OR student_number=ANY($2::varchar[])",
        [appointmentIds, studentNumbers],
      );
      await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
      await client.query(
        "DELETE FROM student_academic_snapshots WHERE id=ANY($1::uuid[]) OR student_number=ANY($2::varchar[])",
        [snapshotIds, studentNumbers],
      );
      await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
      await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [studentNumbers]);
      await client.query(
        "DELETE FROM academic_years WHERE start_year=ANY($1::int[])",
        [[...years, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear]],
      );
    }
    await client.query("COMMIT");
    await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
    const proofClient = await pool.connect();
    try {
      const residue = {
        ...await residueCounts(proofClient),
        stateFiles: await fileExists(STATE_FILE) ? 1 : 0,
      };
      return assertZeroReportsAcceptanceResidue(residue);
    } finally {
      proofClient.release();
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error(
      "Use setup, status, or cleanup with a loopback PostgreSQL DATABASE_URL and REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE=1.",
    );
  }
  const databaseIdentity = assertSafeReportsAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env.REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE,
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const output = mode === "setup" ? await setupReportsAcceptanceFixture(pool, databaseIdentity)
      : mode === "status" ? await getReportsAcceptanceFixtureStatus(pool, databaseIdentity)
        : await cleanupReportsAcceptanceFixture(pool, databaseIdentity);
    console.log(JSON.stringify({ mode, ...output }, null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await run();
}
