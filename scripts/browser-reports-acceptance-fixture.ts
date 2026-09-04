import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const FIXTURE_DIRECTORY = resolve(".data/browser-reports-acceptance");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const STATE_TEMP_FILE = resolve(FIXTURE_DIRECTORY, "state.json.tmp");
const FIXTURE_VERSION = 1;
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
const importGroups = [
  {
    id: "b8000000-0000-4000-8000-000000000001",
    name: "Browser Reports 2020 Standard",
    sourceFilename: "browser-reports-2020-standard.csv",
    academicYearStart: 2020,
    importMode: "STANDARD",
    acceptedAt: "2020-08-01T00:00:00.000Z",
    firstYearLaboratoryDate: null,
  },
  {
    id: "b8000000-0000-4000-8000-000000000002",
    name: "Browser Reports 2020 First-Year",
    sourceFilename: "browser-reports-2020-first-year.csv",
    academicYearStart: 2020,
    importMode: "FIRST_YEAR_OVPSA",
    acceptedAt: "2020-08-02T00:00:00.000Z",
    firstYearLaboratoryDate: "2020-09-01",
  },
  {
    id: "b8000000-0000-4000-8000-000000000003",
    name: "Browser Reports 2098 Standard",
    sourceFilename: "browser-reports-2098-standard.csv",
    academicYearStart: 2098,
    importMode: "STANDARD",
    acceptedAt: "2098-08-01T00:00:00.000Z",
    firstYearLaboratoryDate: null,
  },
  {
    id: "b8000000-0000-4000-8000-000000000004",
    name: "Browser Reports 2098 First-Year",
    sourceFilename: "browser-reports-2098-first-year.csv",
    academicYearStart: 2098,
    importMode: "FIRST_YEAR_OVPSA",
    acceptedAt: "2098-08-02T00:00:00.000Z",
    firstYearLaboratoryDate: "2098-09-01",
  },
] as const;

export const REPORTS_ACCEPTANCE_FIXTURE = {
  marker: "BROWSER-REPORTS-ACCEPTANCE-V1",
  studentPrefix: "B-RPT-",
  studentNumbers,
  appointmentIds,
  snapshotIds,
  importGroups,
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
      importMode: "STANDARD",
    },
    historicalDivergence: {
      studentNumber: "B-RPT-0002",
      currentCollege: "College of Computer Studies",
      currentProgram: "Bachelor of Science in Information Technology",
      historicalCollege: "Archived College of Health Sciences",
      historicalProgram: "Archived Clinical Sciences",
      classification: "DID_NOT_COMPLY_BOTH",
      importMode: "FIRST_YEAR_OVPSA",
    },
    laboratoryOnly: {
      studentNumber: "B-RPT-0004",
      classification: "DID_NOT_COMPLY_LABORATORY",
    },
    completed: {
      studentNumber: "B-RPT-0005",
      classification: "COMPLIED",
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
  importGroups: number;
  academicYears: number;
  crudScratchYears: number;
  auditLogs: number;
  stateFiles: number;
};

type FixtureState = {
  version: typeof FIXTURE_VERSION;
  marker: typeof REPORTS_ACCEPTANCE_FIXTURE.marker;
  databaseIdentity: ReportsAcceptanceDatabaseIdentity;
  setupAuditId: string;
  preparedAt: string;
};

type StateReadResult =
  | { kind: "absent" }
  | { kind: "valid"; value: FixtureState }
  | { kind: "invalid"; reason: string };

type SetupMarker = {
  id: string;
  createdAt: Date;
};

type SetupMarkerResult =
  | { kind: "absent" }
  | { kind: "exact"; value: SetupMarker }
  | { kind: "invalid"; reason: string };

type AuditCandidate = {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
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
  source_import_group_id: string;
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

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseReportsAcceptanceState(value: unknown): FixtureState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "marker", "databaseIdentity", "setupAuditId", "preparedAt",
  ])) {
    throw new Error("Reports fixture state has an invalid schema.");
  }
  if (value.version !== FIXTURE_VERSION || value.marker !== REPORTS_ACCEPTANCE_FIXTURE.marker
    || !isUuid(value.setupAuditId) || !isIsoTimestamp(value.preparedAt)
    || !isRecord(value.databaseIdentity)
    || !hasExactKeys(value.databaseIdentity, ["scheme", "host", "port", "database"])) {
    throw new Error("Reports fixture state has an invalid marker, version, or identity schema.");
  }
  const identity = value.databaseIdentity;
  if (identity.scheme !== "postgresql"
    || typeof identity.host !== "string" || !LOOPBACK_DATABASE_HOSTS.has(identity.host)
    || typeof identity.port !== "string" || !/^\d{1,5}$/.test(identity.port)
    || typeof identity.database !== "string" || identity.database.length === 0) {
    throw new Error("Reports fixture state has an invalid database identity.");
  }
  return value as FixtureState;
}

async function readState(): Promise<StateReadResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_FILE, "utf8"));
    try {
      return { kind: "valid", value: parseReportsAcceptanceState(parsed) };
    } catch {
      return { kind: "invalid", reason: "Reports fixture state is malformed or has the wrong marker." };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    if (error instanceof SyntaxError) {
      return { kind: "invalid", reason: "Reports fixture state is malformed or truncated." };
    }
    throw error;
  }
}

async function writeState(state: FixtureState) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_TEMP_FILE, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(STATE_TEMP_FILE, STATE_FILE);
}

function importGroupId(academicYearStart: number, importMode: "STANDARD" | "FIRST_YEAR_OVPSA") {
  const group = importGroups.find((candidate) => candidate.academicYearStart === academicYearStart
    && candidate.importMode === importMode);
  if (!group) throw new Error("Reports fixture import-group contract drifted.");
  return group.id;
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
      3: "Compliance, Physical Examination Student",
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
      source_import_group_id: importGroupId(
        REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
        index % 2 === 1 ? "STANDARD" : "FIRST_YEAR_OVPSA",
      ),
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
      source_import_group_id: importGroupId(
        REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear,
        index % 2 === 1 ? "STANDARD" : "FIRST_YEAR_OVPSA",
      ),
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
    const status = index === 3 || index === 5 ? "COMPLETED" : "NO_SHOW";
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

function setupMarkerMetadata() {
  return {
    fixtureMarker: REPORTS_ACCEPTANCE_FIXTURE.marker,
    fixtureVersion: FIXTURE_VERSION,
    academicYearStarts: [
      REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
      REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear,
    ],
    crudScratchYearStart: REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear,
    studentCount: REPORTS_ACCEPTANCE_FIXTURE.studentNumbers.length,
    snapshotCount: REPORTS_ACCEPTANCE_FIXTURE.snapshotIds.length,
    appointmentCount: REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.length,
    importGroupCount: REPORTS_ACCEPTANCE_FIXTURE.importGroups.length,
    paginationCount: REPORTS_ACCEPTANCE_FIXTURE.paginationCount,
  };
}

function isExactSetupMarkerMetadata(value: unknown) {
  return canonicalJson(value) === canonicalJson(setupMarkerMetadata());
}

async function getSetupMarker(client: PoolClient): Promise<SetupMarkerResult> {
  const result = await client.query<{
    id: string; actorUserId: string | null; metadata: unknown; createdAt: Date;
  }>(
    `SELECT id::text AS id,actor_user_id::text AS "actorUserId",metadata,created_at AS "createdAt"
       FROM audit_logs
      WHERE action='BROWSER_REPORTS_FIXTURE_SETUP'
        AND entity_type='acceptance_fixture' AND entity_id=$1
      ORDER BY created_at,id`,
    [REPORTS_ACCEPTANCE_FIXTURE.marker],
  );
  if (result.rows.length === 0) return { kind: "absent" };
  if (result.rows.length !== 1) {
    return { kind: "invalid", reason: "Reports fixture setup marker count is invalid." };
  }
  const row = result.rows[0];
  if (!isUuid(row.id) || row.actorUserId !== ADMIN_USER_ID
    || !(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime())
    || !isExactSetupMarkerMetadata(row.metadata)) {
    return { kind: "invalid", reason: "Reports fixture setup marker ownership is malformed or partial." };
  }
  return { kind: "exact", value: { id: row.id, createdAt: row.createdAt } };
}

function validAcademicClosingDate(value: unknown, startYear: number) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= `${startYear}-08-01` && value <= `${startYear + 1}-07-31`;
}

function isExactScratchAudit(candidate: AuditCandidate) {
  if (candidate.actorUserId !== ADMIN_USER_ID || candidate.entityType !== "academic_year"
    || candidate.entityId !== String(REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear)
    || !isRecord(candidate.metadata)) return false;
  const metadata = candidate.metadata;
  if (candidate.action === "ACADEMIC_YEAR_CLOSING_DATE_UPDATED") {
    return hasExactKeys(metadata, ["oldClosingDate", "newClosingDate"])
      && validAcademicClosingDate(metadata.oldClosingDate, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear)
      && validAcademicClosingDate(metadata.newClosingDate, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear);
  }
  if (candidate.action !== "ACADEMIC_YEAR_CREATED" && candidate.action !== "ACADEMIC_YEAR_DELETED") {
    return false;
  }
  return hasExactKeys(metadata, ["startYear", "label", "closingDate"])
    && metadata.startYear === REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear
    && metadata.label === "2097–2098"
    && validAcademicClosingDate(metadata.closingDate, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear);
}

const REPORT_SORTS = new Set([
  "college_asc", "college_desc", "program_asc", "program_desc", "year_asc", "year_desc",
  "name_asc", "name_desc", "attention_first", "completed_first",
]);

function isExactPdfAudit(candidate: AuditCandidate) {
  if (candidate.actorUserId !== ADMIN_USER_ID || candidate.action !== "HISTORICAL_COMPLIANCE_PDF_EXPORTED"
    || candidate.entityType !== "academic_year" || !isRecord(candidate.metadata)) return false;
  const year = candidate.entityId === String(REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear)
    ? REPORTS_ACCEPTANCE_FIXTURE.years.closed
    : candidate.entityId === String(REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear)
      ? REPORTS_ACCEPTANCE_FIXTURE.years.open : null;
  if (!year || !hasExactKeys(candidate.metadata, [
    "academicYearStart", "academicYearLabel", "filters", "sort", "rowCount",
    "generatedAt", "generationDurationMs",
  ])) return false;
  const metadata = candidate.metadata;
  return metadata.academicYearStart === year.startYear && metadata.academicYearLabel === year.label
    && isRecord(metadata.filters) && typeof metadata.sort === "string" && REPORT_SORTS.has(metadata.sort)
    && Number.isInteger(metadata.rowCount) && (metadata.rowCount as number) >= 0
    && (metadata.rowCount as number) <= 10_000 && isIsoTimestamp(metadata.generatedAt)
    && Number.isInteger(metadata.generationDurationMs) && (metadata.generationDurationMs as number) >= 0;
}

async function auditCandidates(client: PoolClient): Promise<AuditCandidate[]> {
  const result = await client.query<AuditCandidate>(
    `SELECT id::text AS id,actor_user_id::text AS "actorUserId",action,
            entity_type AS "entityType",entity_id AS "entityId",metadata,created_at AS "createdAt"
       FROM audit_logs
      WHERE actor_user_id=$1
        AND (
          (entity_type='academic_year' AND entity_id=$2
           AND action=ANY($3::text[]))
          OR
          (entity_type='academic_year' AND entity_id=ANY($4::text[])
           AND action='HISTORICAL_COMPLIANCE_PDF_EXPORTED')
        )
      ORDER BY created_at,id`,
    [ADMIN_USER_ID, String(REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear), [
      "ACADEMIC_YEAR_CREATED", "ACADEMIC_YEAR_CLOSING_DATE_UPDATED", "ACADEMIC_YEAR_DELETED",
    ], [
      String(REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear),
      String(REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear),
    ]],
  );
  return result.rows;
}

function exactOwnedAuditCandidates(candidates: AuditCandidate[], notBefore?: Date) {
  return candidates.filter((candidate) => {
    if (!(candidate.createdAt instanceof Date) || !isUuid(candidate.id)) return false;
    if (notBefore && candidate.createdAt.getTime() < notBefore.getTime()) return false;
    return isExactScratchAudit(candidate) || isExactPdfAudit(candidate);
  });
}

async function assertRequiredSchemaAndReferences(client: PoolClient) {
  const schema = await client.query<{
    academicYears: string | null; snapshots: string | null; importGroups: string | null;
  }>(
    `SELECT to_regclass('academic_years')::text AS "academicYears",
            to_regclass('student_academic_snapshots')::text AS snapshots,
            to_regclass('schedule_import_groups')::text AS "importGroups"`,
  );
  if (!schema.rows[0]?.academicYears || !schema.rows[0]?.snapshots || !schema.rows[0]?.importGroups) {
    throw new Error("Migration 016 must be applied to the local acceptance database before setup.");
  }
  const admin = await client.query<{ role: string; active: boolean }>(
    `SELECT role,
            (deleted_at IS NULL AND email_verified_at IS NOT NULL AND must_change_password=FALSE) AS active
       FROM users WHERE id=$1`, [ADMIN_USER_ID],
  );
  const clinics = await client.query<{ id: string; code: string; name: string; active: boolean }>(
    `SELECT id::text AS id,code,name,is_active AS active FROM clinics
      WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[LABORATORY_CLINIC_ID, PHYSICAL_EXAM_CLINIC_ID]],
  );
  const college = await client.query<{ id: string; code: string; name: string; active: boolean }>(
    `SELECT id::text AS id,code,name,is_active AS active FROM colleges WHERE id=$1`, [CURRENT_COLLEGE_ID],
  );
  const program = await client.query<{
    id: string; collegeId: string; code: string; name: string; active: boolean;
  }>(
    `SELECT id::text AS id,college_id::text AS "collegeId",code,name,is_active AS active
       FROM programs WHERE id=$1`, [CURRENT_PROGRAM_ID],
  );
  const actual = {
    admin: admin.rows,
    clinics: clinics.rows,
    college: college.rows,
    program: program.rows,
  };
  const expected = {
    admin: [{ role: "ADMIN", active: true }],
    clinics: [
      { id: LABORATORY_CLINIC_ID, code: "KABALAKA_CLINIC", name: "KABALAKA Clinic", active: true },
      { id: PHYSICAL_EXAM_CLINIC_ID, code: "CPU_CLINIC", name: "CPU Clinic", active: true },
    ],
    college: [{
      id: CURRENT_COLLEGE_ID, code: "CCS", name: "College of Computer Studies", active: true,
    }],
    program: [{
      id: CURRENT_PROGRAM_ID, collegeId: CURRENT_COLLEGE_ID, code: "BSIT",
      name: "Bachelor of Science in Information Technology", active: true,
    }],
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Reports fixture required reference readiness drifted from the exact local admin/clinic/CCS/BSIT contract.");
  }
}

async function assertReservedScopeAvailable(client: PoolClient) {
  const marker = await getSetupMarker(client);
  if (marker.kind === "invalid") throw new Error(marker.reason);
  if (marker.kind === "exact") return;
  const reservedYears = [
    REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear,
    REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear,
    REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear,
  ];
  const collision = await client.query<{
    years: number; students: number; snapshots: number; appointments: number; importGroups: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=ANY($1::int[])) AS years,
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $2) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE id=ANY($3::uuid[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments WHERE id=ANY($4::uuid[])) AS appointments,
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=ANY($5::uuid[])) AS "importGroups"`,
    [
      reservedYears,
      `${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`,
      snapshotIds,
      appointmentIds,
      importGroups.map((group) => group.id),
    ],
  );
  const ownedAuditCollisions = exactOwnedAuditCandidates(await auditCandidates(client));
  if (Object.values(collision.rows[0]).some((count) => count !== 0)
    || ownedAuditCollisions.length !== 0) {
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
    `INSERT INTO schedule_import_groups (
       id,import_name,source_filename,total_rows,matched_student_count,description,
       created_by,student_category,academic_year_start,preferred_month,accepted_at,
       import_mode,first_year_laboratory_date
     ) SELECT row.id,row.name,row.source_filename,1,0,$2,$3,'REGULAR',
              row.academic_year_start,NULL,row.accepted_at::timestamptz,row.import_mode,
              row.first_year_laboratory_date::date
         FROM jsonb_to_recordset($1::jsonb) AS row(
           id uuid,name text,source_filename text,academic_year_start int,import_mode text,
           accepted_at text,first_year_laboratory_date text
         )
     ON CONFLICT (id) DO NOTHING`,
    [
      JSON.stringify(importGroups.map((group) => ({
        id: group.id,
        name: group.name,
        source_filename: group.sourceFilename,
        academic_year_start: group.academicYearStart,
        import_mode: group.importMode,
        accepted_at: group.acceptedAt,
        first_year_laboratory_date: group.firstYearLaboratoryDate,
      }))),
      REPORTS_ACCEPTANCE_FIXTURE.marker,
      ADMIN_USER_ID,
    ],
  );
  await client.query(
    `INSERT INTO student_academic_snapshots (
       id,student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_import_group_id
     ) SELECT row.id,row.student_number,row.academic_year_start,row.student_name,
              row.college_id,row.college_name,row.program_id,row.program_code,row.program_name,
              row.year_level,row.source_import_group_id
         FROM jsonb_to_recordset($1::jsonb) AS row(
           id uuid,student_number text,academic_year_start int,student_name text,
           college_id uuid,college_name text,program_id uuid,program_code text,
           program_name text,year_level int,source_import_group_id uuid
         )
     ON CONFLICT (student_number,academic_year_start) DO NOTHING`,
    [JSON.stringify(snapshots())],
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
}

async function ensureSetupMarker(client: PoolClient) {
  const existing = await getSetupMarker(client);
  if (existing.kind === "exact") return existing.value;
  if (existing.kind === "invalid") throw new Error(existing.reason);
  const inserted = await client.query<{ id: string; createdAt: Date }>(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES ($1,'BROWSER_REPORTS_FIXTURE_SETUP','acceptance_fixture',$2,$3::jsonb)
     RETURNING id::text AS id,created_at AS "createdAt"`,
    [ADMIN_USER_ID, REPORTS_ACCEPTANCE_FIXTURE.marker, JSON.stringify(setupMarkerMetadata())],
  );
  return inserted.rows[0];
}

async function databaseCounts(client: PoolClient) {
  const marker = await getSetupMarker(client);
  return {
    students: studentNumbers.length,
    snapshots: snapshotIds.length,
    appointments: appointmentIds.length,
    importGroups: importGroups.length,
    academicYears: 2,
    auditLogs: marker.kind === "exact" ? 1 : 0,
  };
}

async function assertFixtureReady(client: PoolClient) {
  await assertRequiredSchemaAndReferences(client);
  const marker = await getSetupMarker(client);
  if (marker.kind !== "exact") {
    throw new Error(marker.kind === "invalid" ? marker.reason : "Reports fixture readiness is missing its exact setup marker.");
  }

  const yearRows = await client.query<{
    startYear: number; label: string; closingDate: string; createdBy: string; updatedBy: string;
  }>(
    `SELECT start_year AS "startYear",label,closing_date::text AS "closingDate",
            created_by::text AS "createdBy",updated_by::text AS "updatedBy"
       FROM academic_years WHERE start_year=ANY($1::int[]) ORDER BY start_year`,
    [[REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear]],
  );
  const expectedYears = [REPORTS_ACCEPTANCE_FIXTURE.years.closed, REPORTS_ACCEPTANCE_FIXTURE.years.open]
    .sort((left, right) => left.startYear - right.startYear)
    .map((year) => ({
      startYear: year.startYear, label: year.label, closingDate: year.closingDate,
      createdBy: ADMIN_USER_ID, updatedBy: ADMIN_USER_ID,
    }));
  if (canonicalJson(yearRows.rows) !== canonicalJson(expectedYears)) {
    throw new Error("Reports fixture readiness detected academic-year ownership or closing-date drift.");
  }

  const studentRows = await client.query<{
    studentNumber: string; firstName: string; middleName: string | null; lastName: string;
    suffix: string | null; collegeId: string; programId: string; yearLevel: number;
    section: string | null; active: boolean;
  }>(
    `SELECT student_number AS "studentNumber",first_name AS "firstName",middle_name AS "middleName",
            last_name AS "lastName",suffix,college_id::text AS "collegeId",
            program_id::text AS "programId",year_level AS "yearLevel",section,is_active AS active
       FROM students WHERE student_number LIKE $1 ORDER BY student_number`,
    [`${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`],
  );
  const expectedStudents = students().map((student) => ({
    studentNumber: student.student_number, firstName: student.first_name, middleName: null,
    lastName: student.last_name, suffix: null, collegeId: CURRENT_COLLEGE_ID,
    programId: CURRENT_PROGRAM_ID, yearLevel: student.year_level, section: null,
    active: student.is_active,
  }));
  if (canonicalJson(studentRows.rows) !== canonicalJson(expectedStudents)) {
    throw new Error("Reports fixture readiness detected current-student or fixture-prefix drift.");
  }

  const importGroupRows = await client.query<{
    id: string; name: string; sourceFilename: string; academicYearStart: number;
    importMode: string; acceptedAt: Date; firstYearLaboratoryDate: string | null;
  }>(
    `SELECT id::text AS id,import_name AS name,source_filename AS "sourceFilename",
            academic_year_start AS "academicYearStart",import_mode AS "importMode",
            accepted_at AS "acceptedAt",first_year_laboratory_date::text AS "firstYearLaboratoryDate"
       FROM schedule_import_groups WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [importGroups.map((group) => group.id)],
  );
  const expectedImportGroups = importGroups.map((group) => ({
    id: group.id,
    name: group.name,
    sourceFilename: group.sourceFilename,
    academicYearStart: group.academicYearStart,
    importMode: group.importMode,
    acceptedAt: new Date(group.acceptedAt).toISOString(),
    firstYearLaboratoryDate: group.firstYearLaboratoryDate,
  }));
  const actualImportGroups = importGroupRows.rows.map((group) => ({
    ...group,
    acceptedAt: group.acceptedAt.toISOString(),
  }));
  if (canonicalJson(actualImportGroups) !== canonicalJson(expectedImportGroups)) {
    throw new Error("Reports fixture readiness detected import-group provenance drift or extra fixture groups.");
  }

  const snapshotRows = await client.query<{
    id: string; studentNumber: string; academicYearStart: number; studentName: string;
    collegeId: string; collegeName: string; programId: string; programCode: string;
    programName: string; yearLevel: number; sourceImportGroupId: string;
  }>(
    `SELECT id::text AS id,student_number AS "studentNumber",
            academic_year_start AS "academicYearStart",student_name AS "studentName",
            college_id::text AS "collegeId",college_name AS "collegeName",
            program_id::text AS "programId",program_code AS "programCode",
            program_name AS "programName",year_level AS "yearLevel",
            source_import_group_id::text AS "sourceImportGroupId"
       FROM student_academic_snapshots
      WHERE student_number LIKE $1 OR id=ANY($2::uuid[]) ORDER BY id`,
    [`${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`, snapshotIds],
  );
  const expectedSnapshots = snapshots().map((snapshot) => ({
    id: snapshot.id, studentNumber: snapshot.student_number,
    academicYearStart: snapshot.academic_year_start, studentName: snapshot.student_name,
    collegeId: snapshot.college_id, collegeName: snapshot.college_name,
    programId: snapshot.program_id, programCode: snapshot.program_code,
    programName: snapshot.program_name, yearLevel: snapshot.year_level,
    sourceImportGroupId: snapshot.source_import_group_id,
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(snapshotRows.rows) !== canonicalJson(expectedSnapshots)) {
    throw new Error("Reports fixture readiness detected immutable snapshot drift or extra snapshot rows.");
  }

  const appointmentRows = await client.query<{
    id: string; clinicId: string; studentNumber: string; scheduleType: string;
    appointmentDate: string; status: string; published: boolean; rescheduledFrom: string | null;
    scheduleCycleStart: number; createdBy: string; updatedBy: string; notes: string | null;
  }>(
    `SELECT id::text AS id,clinic_id::text AS "clinicId",student_number AS "studentNumber",
            schedule_type AS "scheduleType",appointment_date::text AS "appointmentDate",status,
            is_published AS published,rescheduled_from::text AS "rescheduledFrom",
            schedule_cycle_start AS "scheduleCycleStart",created_by::text AS "createdBy",
            updated_by::text AS "updatedBy",notes
       FROM appointments
      WHERE student_number LIKE $1 OR id=ANY($2::uuid[]) ORDER BY id`,
    [`${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}%`, appointmentIds],
  );
  const expectedAppointments = appointments().map((appointment) => ({
    id: appointment.id, clinicId: appointment.clinic_id,
    studentNumber: appointment.student_number, scheduleType: appointment.schedule_type,
    appointmentDate: appointment.appointment_date, status: appointment.status,
    published: appointment.is_published, rescheduledFrom: appointment.rescheduled_from,
    scheduleCycleStart: appointment.schedule_cycle_start, createdBy: ADMIN_USER_ID,
    updatedBy: ADMIN_USER_ID, notes: REPORTS_ACCEPTANCE_FIXTURE.marker,
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(appointmentRows.rows) !== canonicalJson(expectedAppointments)) {
    throw new Error("Reports fixture readiness detected appointment drift or extra fixture-student appointments.");
  }

  return databaseCounts(client);
}

export async function setupReportsAcceptanceFixture(
  pool: Pool,
  databaseIdentity: ReportsAcceptanceDatabaseIdentity,
) {
  const state = await readState();
  if (state.kind === "invalid") throw new Error(state.reason);
  if (state.kind === "valid") {
    assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, state.value.databaseIdentity);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertRequiredSchemaAndReferences(client);
    await assertReservedScopeAvailable(client);
    const markerBeforeSetup = await getSetupMarker(client);
    if (state.kind === "valid") {
      if (markerBeforeSetup.kind !== "exact"
        || state.value.setupAuditId !== markerBeforeSetup.value.id
        || state.value.preparedAt !== markerBeforeSetup.value.createdAt.toISOString()) {
        throw new Error("Reports fixture state does not match the exact database setup marker.");
      }
    }
    await insertFixtureRows(client);
    const marker = await ensureSetupMarker(client);
    const counts = await assertFixtureReady(client);
    await client.query("COMMIT");
    await writeState({
      version: FIXTURE_VERSION,
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      databaseIdentity,
      setupAuditId: marker.id,
      preparedAt: marker.createdAt.toISOString(),
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
  if (state.kind !== "valid") {
    throw new Error(state.kind === "invalid" ? state.reason : "Reports fixture state is missing.");
  }
  assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, state.value.databaseIdentity);
  const client = await pool.connect();
  try {
    await assertRequiredSchemaAndReferences(client);
    const marker = await getSetupMarker(client);
    if (marker.kind !== "exact" || marker.value.id !== state.value.setupAuditId
      || marker.value.createdAt.toISOString() !== state.value.preparedAt) {
      throw new Error("Reports fixture state does not match the exact database setup marker.");
    }
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
        importGroups: counts.importGroups,
        academicYears: counts.academicYears,
      },
      stateFile: true,
    };
  } finally {
    client.release();
  }
}

async function residueCounts(client: PoolClient): Promise<Omit<ReportsAcceptanceResidue, "stateFiles">> {
  const years = [REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear];
  const result = await client.query<Omit<ReportsAcceptanceResidue, "stateFiles" | "auditLogs">>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_academic_snapshots
         WHERE id=ANY($2::uuid[]) OR student_number=ANY($1::varchar[])) AS snapshots,
       (SELECT COUNT(*)::int FROM appointments
         WHERE id=ANY($3::uuid[]) OR student_number=ANY($1::varchar[])) AS appointments,
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=ANY($4::uuid[])) AS "importGroups",
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=ANY($5::int[])) AS "academicYears",
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=$6) AS "crudScratchYears"`,
    [studentNumbers, snapshotIds, appointmentIds, importGroups.map((group) => group.id), years,
      REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear],
  );
  const marker = await getSetupMarker(client);
  const markerCount = marker.kind === "absent" ? 0 : 1;
  return {
    ...result.rows[0],
    auditLogs: markerCount + exactOwnedAuditCandidates(await auditCandidates(client)).length,
  };
}

export async function cleanupReportsAcceptanceFixture(
  pool: Pool,
  databaseIdentity: ReportsAcceptanceDatabaseIdentity,
) {
  const state = await readState();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertRequiredSchemaAndReferences(client);
    const marker = await getSetupMarker(client);
    if (marker.kind === "invalid") throw new Error(marker.reason);
    if (marker.kind === "exact") {
      if (state.kind === "valid") {
        assertMatchingReportsAcceptanceDatabaseIdentity(databaseIdentity, state.value.databaseIdentity);
        if (state.value.setupAuditId !== marker.value.id
          || state.value.preparedAt !== marker.value.createdAt.toISOString()) {
          throw new Error("Reports fixture state does not match the exact database setup marker.");
        }
      }
      const years = [REPORTS_ACCEPTANCE_FIXTURE.years.closed.startYear, REPORTS_ACCEPTANCE_FIXTURE.years.open.startYear];
      const ownedAuditIds = [
        marker.value.id,
        ...exactOwnedAuditCandidates(await auditCandidates(client), marker.value.createdAt)
          .map((candidate) => candidate.id),
      ];
      await client.query("DELETE FROM audit_logs WHERE id=ANY($1::uuid[])", [ownedAuditIds]);
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
      await client.query("DELETE FROM schedule_import_groups WHERE id=ANY($1::uuid[])", [
        importGroups.map((group) => group.id),
      ]);
      await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [studentNumbers]);
      await client.query(
        "DELETE FROM academic_years WHERE start_year=ANY($1::int[])",
        [[...years, REPORTS_ACCEPTANCE_FIXTURE.crudScratch.startYear]],
      );
    } else if (state.kind !== "absent") {
      throw new Error("Reports fixture state exists without exact database marker ownership; refusing cleanup.");
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
