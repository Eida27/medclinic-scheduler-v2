import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { AUTOMATIC_NO_SHOW_NOTE } from "../src/server/appointments/automatic-no-show";
import {
  parseStudentImportCsv,
  STUDENT_IMPORT_HEADERS,
  type ImportedStudentRow,
} from "../src/server/services/student-import-csv";

export const APPROVED_CSV_PATH =
  "C:\\endless_refinement\\microsoft_docs\\Physical_Laboratory_Scheduling.csv";
export const EXPECTED_APPROVED_ROWS = 280;
export const EXPECTED_APPROVED_BYTE_LENGTH = 25_176;
export const EXPECTED_APPROVED_SHA256 =
  "a8324f7ccf2d7000ddf1ce873c57eb92d7f4557b1e016f494c4b4a1a53bd0e15";

const FIXTURE_DIRECTORY = resolve(".data/browser-clinic-scheduler-ux");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const RESULT_STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type AcceptanceDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

export function normalizeAcceptanceDatabaseIdentity(
  databaseUrl: string,
): AcceptanceDatabaseIdentity {
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

export function assertSafeAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveDatabase: string | undefined,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  }
  const identity = normalizeAcceptanceDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Clinic UX acceptance requires a PostgreSQL database on a loopback host.");
  }
  if (exclusiveDatabase !== "1") {
    throw new Error(
      "Set CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a local database dedicated to Clinic UX acceptance.",
    );
  }
  return identity;
}

export function assertMatchingAcceptanceDatabaseIdentity(
  current: AcceptanceDatabaseIdentity,
  persisted: AcceptanceDatabaseIdentity | undefined,
) {
  if (!persisted) {
    throw new Error(
      "Fixture state has no database identity. Refusing to connect; restore or inspect the original acceptance database manually.",
    );
  }
  if (
    current.scheme !== persisted.scheme
    || current.host !== persisted.host
    || current.port !== persisted.port
    || current.database !== persisted.database
  ) {
    throw new Error(
      "Current DATABASE_URL identity does not match the fixture database identity stored in state. Switch back to the original database before continuing.",
    );
  }
}

export async function runGuardedAcceptanceDatabaseOperation<T>({
  databaseUrl,
  exclusiveDatabase,
  persistedIdentity,
  operation,
}: {
  databaseUrl: string | undefined;
  exclusiveDatabase: string | undefined;
  persistedIdentity?: AcceptanceDatabaseIdentity;
  operation: (identity: AcceptanceDatabaseIdentity) => Promise<T> | T;
}) {
  const currentIdentity = assertSafeAcceptanceDatabase(databaseUrl, exclusiveDatabase);
  if (persistedIdentity) {
    assertMatchingAcceptanceDatabaseIdentity(currentIdentity, persistedIdentity);
  }
  return operation(currentIdentity);
}

type JsonObject = Record<string, unknown>;
type CapacityBaseline = {
  id: string;
  safeDailyCapacity: number;
  maxDailyCapacity: number;
};
type BaselineIds = Record<string, string[]>;
type ProgramReference = { collegeName: string; courseCode: string };
type TemporaryProgram = {
  id: string;
  collegeId: string;
  code: string;
  name: string;
};
export type CalendarAcceptanceFixture = {
  draftBlocks: Array<{
    clinicId: string;
    clinicName: string;
    date: string;
  }>;
  safeRestoration: {
    clinicId: string;
    clinicName: string;
    date: string;
    unavailableDateId: string;
    expectedUpdatedAt: string;
    originalAppointmentIds: string[];
    replacementAppointmentIds: string[];
  };
  protectedRestoration: {
    clinicId: string;
    clinicName: string;
    date: string;
    unavailableDateId: string;
    expectedUpdatedAt: string;
    originalAppointmentIds: string[];
    replacementAppointmentIds: string[];
    protectedAppointmentId: string;
  };
};

export function validateCalendarAcceptanceFixture<T extends CalendarAcceptanceFixture>(fixture: T): T {
  if (fixture.draftBlocks.length !== 2) {
    throw new Error("Calendar acceptance requires exactly two draft block dates.");
  }
  if (new Set(fixture.draftBlocks.map((block) => block.clinicId)).size !== 2) {
    throw new Error("Calendar acceptance draft dates must cover both clinics.");
  }
  if (new Set(fixture.draftBlocks.map((block) => block.date.slice(0, 7))).size !== 2) {
    throw new Error("Calendar acceptance draft dates must use different months.");
  }
  const safeIds = new Set([
    ...fixture.safeRestoration.originalAppointmentIds,
    ...fixture.safeRestoration.replacementAppointmentIds,
  ]);
  const protectedIds = [
    ...fixture.protectedRestoration.originalAppointmentIds,
    ...fixture.protectedRestoration.replacementAppointmentIds,
  ];
  if (protectedIds.some((id) => safeIds.has(id))) {
    throw new Error("Safe and protected restoration appointment fixtures must be disjoint.");
  }
  if (!fixture.protectedRestoration.replacementAppointmentIds.includes(
    fixture.protectedRestoration.protectedAppointmentId,
  )) {
    throw new Error("The protected appointment must be one of the generated replacements.");
  }
  return fixture;
}

export type QuickStatusAcceptanceFixture = {
  pending: { studentNumber: string; appointmentId: string; appointmentDate: string };
  noShow: { studentNumber: string; appointmentId: string; appointmentDate: string };
  protected: { studentNumber: string; appointmentId: string; appointmentDate: string };
};

export function validateQuickStatusAcceptanceFixture<T extends QuickStatusAcceptanceFixture>(fixture: T): T {
  const appointmentIds = [
    fixture.pending.appointmentId,
    fixture.noShow.appointmentId,
    fixture.protected.appointmentId,
  ];
  if (new Set(appointmentIds).size !== appointmentIds.length) {
    throw new Error("Quick-status acceptance appointments must be disjoint.");
  }
  return fixture;
}

export type LaboratoryStatusAcceptanceFixture = {
  unavailable: {
    studentNumber: string;
    laboratoryAppointmentId: string;
    physicalAppointmentId: string;
  };
};

export type LaboratoryStatusAcceptanceOwnership = {
  studentNumbers: string[];
  appointmentIds: string[];
};

export function validateLaboratoryStatusAcceptanceFixture<T extends LaboratoryStatusAcceptanceFixture>(
  fixture: T,
  ownership: LaboratoryStatusAcceptanceOwnership,
): T {
  const { unavailable } = fixture;
  for (const field of [
    "studentNumber",
    "laboratoryAppointmentId",
    "physicalAppointmentId",
  ] as const) {
    if (!unavailable[field]?.trim()) {
      throw new Error(`Laboratory-status acceptance requires unavailable.${field}.`);
    }
  }
  if (ownership.studentNumbers.includes(unavailable.studentNumber)) {
    throw new Error("The unavailable Laboratory-status student role must be disjoint from other staged roles.");
  }
  const unavailableAppointmentIds = [
    unavailable.laboratoryAppointmentId,
    unavailable.physicalAppointmentId,
  ];
  if (
    new Set(unavailableAppointmentIds).size !== unavailableAppointmentIds.length
    || unavailableAppointmentIds.some((id) => ownership.appointmentIds.includes(id))
  ) {
    throw new Error("Unavailable Laboratory-status appointments must be disjoint from other staged roles.");
  }
  return fixture;
}

type FixtureState = {
  version: 3;
  runId: string;
  phase: "PREPARING" | "PREPARED" | "IMPORTED" | "STAGED";
  startedAt: string;
  databaseIdentity: AcceptanceDatabaseIdentity;
  source: {
    path: string;
    sha256: string;
    byteLength: number;
    bomHex: string;
    acceptedRows: number;
  };
  temporaryCsv: {
    path: string;
    filename: string;
    sha256: string;
    byteLength: number;
    encoding: "windows-1252";
    peñaCount: 1;
  };
  browserImport?: {
    path: string;
    filename: string;
    encoding: "utf-8-bom" | "windows-1252";
  };
  fixtureReason: string;
  studentNumbers: string[];
  preExistingStudents: JsonObject[];
  referencePrograms: {
    preExisting: JsonObject[];
    temporary: TemporaryProgram[];
  };
  baseline: {
    capacities: CapacityBaseline[];
    ids: BaselineIds;
  };
  imported?: {
    importIds: string[];
    batchIds: string[];
    appointmentIds: string[];
    createdStudentNumbers: string[];
  };
  staged?: {
    correction: { studentNumber: string; appointmentId: string; appointmentDate: string };
    complete: { studentNumber: string; laboratoryAppointmentId: string; physicalAppointmentId: string };
    mixed: { studentNumber: string; laboratoryAppointmentId: string; physicalAppointmentId: string };
    clinicContextStudentNumber: string;
    successCalendarDate: string;
    failureCalendarDate: string;
    calendar?: CalendarAcceptanceFixture;
    quickStatus?: QuickStatusAcceptanceFixture;
    laboratoryStatus?: LaboratoryStatusAcceptanceFixture;
  };
  cleanup?: CleanupProgress;
};

type ApprovedCsvInspection = {
  byteLength: number;
  sha256: string;
  bomHex: string;
  acceptedRows: number;
  studentNumbers: string[];
  rows: ImportedStudentRow[];
};

type ApprovedCsvExpectations = {
  expectedRows: number;
  expectedByteLength: number;
  expectedSha256: string;
};

const WINDOWS_1252_SPECIAL = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function differenceIds(current: string[], baseline: string[]) {
  const existing = new Set(baseline);
  return current.filter((id) => !existing.has(id));
}

export function baselineRowsMatch(
  baseline: JsonObject[],
  current: JsonObject[],
  key: string,
) {
  const normalized = (rows: JsonObject[]) => [...rows]
    .sort((left, right) => String(left[key]).localeCompare(String(right[key])));
  return JSON.stringify(normalized(baseline)) === JSON.stringify(normalized(current));
}

export function requiredProgramReferences(rows: ImportedStudentRow[]): ProgramReference[] {
  const references = new Map<string, ProgramReference>();
  for (const row of rows) {
    const reference = { collegeName: row.collegeName, courseCode: row.courseCode };
    references.set(`${row.collegeName.toLocaleLowerCase()}:${row.courseCode.toLocaleLowerCase()}`, reference);
  }
  return [...references.values()].sort((left, right) => (
    left.collegeName.localeCompare(right.collegeName) || left.courseCode.localeCompare(right.courseCode)
  ));
}

export function inspectApprovedCsv(
  bytes: Uint8Array,
  expected: number | ApprovedCsvExpectations = {
    expectedRows: EXPECTED_APPROVED_ROWS,
    expectedByteLength: EXPECTED_APPROVED_BYTE_LENGTH,
    expectedSha256: EXPECTED_APPROVED_SHA256,
  },
): ApprovedCsvInspection {
  const expectedRows = typeof expected === "number" ? expected : expected.expectedRows;
  const actualSha256 = sha256(bytes);
  if (typeof expected !== "number" && bytes.byteLength !== expected.expectedByteLength) {
    throw new Error(
      `Approved CSV byte length must be exactly ${expected.expectedByteLength}; found ${bytes.byteLength}.`,
    );
  }
  if (typeof expected !== "number" && actualSha256 !== expected.expectedSha256) {
    throw new Error(
      `Approved CSV SHA-256 must be ${expected.expectedSha256}; found ${actualSha256}.`,
    );
  }
  const bomHex = Buffer.from(bytes.subarray(0, 3)).toString("hex");
  if (bomHex !== "efbbbf") {
    throw new Error(`Approved CSV must begin with the UTF-8 BOM EF BB BF; found ${bomHex || "no bytes"}.`);
  }
  const rows = parseStudentImportCsv(bytes);
  if (rows.length !== expectedRows) {
    throw new Error(`Approved CSV must contain exactly ${expectedRows} accepted rows; parsed ${rows.length}.`);
  }
  return {
    byteLength: bytes.byteLength,
    sha256: actualSha256,
    bomHex,
    acceptedRows: rows.length,
    studentNumbers: rows.map((row) => row.studentNumber),
    rows,
  };
}

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function windows1252Bytes(text: string) {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      bytes.push(codePoint);
      continue;
    }
    const encoded = WINDOWS_1252_SPECIAL.get(codePoint);
    if (encoded === undefined) {
      throw new Error(`Approved CSV contains ${JSON.stringify(character)}, which Windows-1252 cannot encode.`);
    }
    bytes.push(encoded);
  }
  return Buffer.from(bytes);
}

function displayBirthDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-");
  return `${month}-${day}-${year}`;
}

export function createWindows1252Variant(
  sourceBytes: Uint8Array,
  expectedRows = EXPECTED_APPROVED_ROWS,
) {
  const inspection = inspectApprovedCsv(sourceBytes, expectedRows);
  const records = [
    [...STUDENT_IMPORT_HEADERS],
    ...inspection.rows.map((row, index) => [
      row.studentNumber,
      index === 0 ? "Peña" : row.surname,
      row.firstName,
      row.middleName,
      row.suffix,
      row.collegeName,
      row.courseCode,
      row.yearLevel,
      displayBirthDate(row.dateOfBirth),
    ]),
  ];
  const text = records.map((record) => record.map(csvCell).join(",")).join("\r\n");
  const peñaCount = records.flat().filter((value) => value === "Peña").length;
  if (peñaCount !== 1) throw new Error(`Windows-1252 variant must contain exactly one Peña value; found ${peñaCount}.`);
  const bytes = windows1252Bytes(text);
  const reparsed = parseStudentImportCsv(bytes);
  if (reparsed.length !== expectedRows || reparsed[0]?.surname !== "Peña") {
    throw new Error("Generated Windows-1252 CSV did not round-trip through the application parser.");
  }
  return { bytes, peñaCount: 1 as const, rows: reparsed };
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
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function idRows(client: PoolClient, sql: string, values: unknown[] = []) {
  const result = await client.query<{ id: string }>(sql, values);
  return result.rows.map(({ id }) => id);
}

async function captureBaselineIds(client: PoolClient, studentNumbers: string[]): Promise<BaselineIds> {
  return {
    appointments: await idRows(client, "SELECT id::text AS id FROM appointments WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    coordinatorItems: await idRows(client, "SELECT id::text AS id FROM coordinator_schedule_items WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    laboratoryResults: await idRows(client, "SELECT id::text AS id FROM laboratory_results WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    examResults: await idRows(client, "SELECT id::text AS id FROM exam_results WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    submissions: await idRows(client, "SELECT id::text AS id FROM student_result_submissions WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    notifications: await idRows(client, "SELECT id::text AS id FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    verificationTokens: await idRows(client, "SELECT id::text AS id FROM student_email_verifications WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    loginAttempts: await idRows(client, "SELECT id::text AS id FROM student_login_attempts WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    outbox: await idRows(client, "SELECT id::text AS id FROM email_outbox WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    rescheduleEvents: await idRows(client, "SELECT id::text AS id FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])", [studentNumbers]),
    // Baseline ownership must include active and historical soft-unblocked rows.
    closures: await idRows(client, "SELECT id::text AS id FROM clinic_unavailable_dates"),
    audits: await idRows(client, "SELECT id::text AS id FROM audit_logs"),
  };
}

async function prepare(pool: Pool, databaseIdentity: AcceptanceDatabaseIdentity) {
  if (await readState()) {
    throw new Error(`Fixture state already exists at ${STATE_FILE}. Run cleanup before preparing another acceptance run.`);
  }
  const sourceBytes = await readFile(APPROVED_CSV_PATH);
  const inspection = inspectApprovedCsv(sourceBytes);
  const variant = createWindows1252Variant(sourceBytes);
  const useApprovedCsv = process.env.CLINIC_UX_ACCEPTANCE_USE_APPROVED_CSV === "1";
  const runId = randomUUID();
  const filename = `BROWSER-UX-${runId}-Physical_Laboratory_Scheduling-windows1252.csv`;
  const temporaryPath = resolve(FIXTURE_DIRECTORY, filename);
  const client = await pool.connect();
  let state: FixtureState;
  try {
    const references = requiredProgramReferences(inspection.rows);
    const students = await client.query<{ value: JsonObject }>(
      "SELECT to_jsonb(student) AS value FROM students student WHERE student_number=ANY($1::varchar[]) ORDER BY student_number",
      [inspection.studentNumbers],
    );
    const capacities = await client.query<CapacityBaseline>(
      `SELECT id::text, safe_daily_capacity AS "safeDailyCapacity", max_daily_capacity AS "maxDailyCapacity"
         FROM clinic_capacity_settings ORDER BY id`,
    );
    const colleges = await client.query<{ id: string; name: string; isActive: boolean }>(
      `SELECT id::text, name, is_active AS "isActive" FROM colleges
        WHERE LOWER(name)=ANY($1::text[]) ORDER BY name`,
      [[...new Set(references.map((reference) => reference.collegeName.toLocaleLowerCase()))]],
    );
    const collegeByName = new Map(colleges.rows.map((college) => [college.name.toLocaleLowerCase(), college]));
    for (const reference of references) {
      const college = collegeByName.get(reference.collegeName.toLocaleLowerCase());
      if (!college?.isActive) {
        throw new Error(`Acceptance database requires active college ${reference.collegeName}.`);
      }
    }
    const programs = await client.query<{ value: JsonObject }>(
      `SELECT to_jsonb(program) AS value FROM programs program
        WHERE college_id=ANY($1::uuid[]) ORDER BY college_id, code`,
      [[...new Set(colleges.rows.map((college) => college.id))]],
    );
    const existingProgramByKey = new Map(programs.rows.map(({ value }) => [
      `${value.college_id}:${String(value.code).toLocaleLowerCase()}`,
      value,
    ]));
    const requiredExistingPrograms: JsonObject[] = [];
    const temporaryPrograms: TemporaryProgram[] = [];
    for (const reference of references) {
      const college = collegeByName.get(reference.collegeName.toLocaleLowerCase())!;
      const existing = existingProgramByKey.get(`${college.id}:${reference.courseCode.toLocaleLowerCase()}`);
      if (existing) requiredExistingPrograms.push(existing);
      else temporaryPrograms.push({
        id: randomUUID(),
        collegeId: college.id,
        code: reference.courseCode,
        name: `Browser acceptance ${reference.courseCode}`,
      });
    }
    state = {
      version: 3,
      runId,
      phase: "PREPARING",
      startedAt: new Date().toISOString(),
      databaseIdentity,
      source: {
        path: APPROVED_CSV_PATH,
        sha256: sha256(sourceBytes),
        byteLength: sourceBytes.byteLength,
        bomHex: inspection.bomHex,
        acceptedRows: inspection.acceptedRows,
      },
      temporaryCsv: {
        path: temporaryPath,
        filename,
        sha256: sha256(variant.bytes),
        byteLength: variant.bytes.byteLength,
        encoding: "windows-1252",
        peñaCount: 1,
      },
      browserImport: useApprovedCsv ? {
        path: APPROVED_CSV_PATH,
        filename: basename(APPROVED_CSV_PATH),
        encoding: "utf-8-bom",
      } : {
        path: temporaryPath,
        filename,
        encoding: "windows-1252",
      },
      fixtureReason: `BROWSER-UX-${runId}`,
      studentNumbers: inspection.studentNumbers,
      preExistingStudents: students.rows.map(({ value }) => value),
      referencePrograms: {
        preExisting: requiredExistingPrograms,
        temporary: temporaryPrograms,
      },
      baseline: {
        capacities: capacities.rows,
        ids: await captureBaselineIds(client, inspection.studentNumbers),
      },
    };
    await mkdir(FIXTURE_DIRECTORY, { recursive: true });
    await writeFile(temporaryPath, variant.bytes);
    await writeState(state);
    await client.query("BEGIN");
    const inactiveProgramIds = requiredExistingPrograms
      .filter((program) => program.is_active === false)
      .map((program) => program.id);
    if (inactiveProgramIds.length) {
      await client.query(
        "UPDATE programs SET is_active=TRUE WHERE id=ANY($1::uuid[])",
        [inactiveProgramIds],
      );
    }
    for (const program of temporaryPrograms) {
      await client.query(
        "INSERT INTO programs (id, college_id, code, name, is_active) VALUES ($1,$2,$3,$4,TRUE)",
        [program.id, program.collegeId, program.code, program.name],
      );
    }
    await client.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=GREATEST(max_daily_capacity, $1),
              max_daily_capacity=GREATEST(max_daily_capacity, $1)`,
      [EXPECTED_APPROVED_ROWS],
    );
    await client.query("COMMIT");
    state.phase = "PREPARED";
    await writeState(state);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* no active transaction */ }
    throw error;
  } finally {
    client.release();
  }
  return {
    mode: "prepare",
    statePath: STATE_FILE,
    phase: state.phase,
    source: state.source,
    temporaryCsv: state.temporaryCsv,
    preExistingMatchingStudents: state.preExistingStudents.length,
    temporaryReferencePrograms: state.referencePrograms.temporary,
    capacityRowsRecorded: state.baseline.capacities.length,
    browserImport: {
      file: state.browserImport!.path,
      filename: state.browserImport!.filename,
      encoding: state.browserImport!.encoding,
      studentCategory: "Regular",
      academicYear: "Use the current academic year shown by the form",
    },
  };
}

function browserImportFilename(state: FixtureState) {
  return state.browserImport?.filename ?? state.temporaryCsv.filename;
}

async function captureImport(client: PoolClient, state: FixtureState) {
  const importIds = await idRows(
    client,
    `SELECT id::text AS id FROM schedule_import_groups
      WHERE source_filename=$1 AND created_at >= $2::timestamptz ORDER BY created_at`,
    [browserImportFilename(state), state.startedAt],
  );
  const batchIds = importIds.length
    ? await idRows(client, "SELECT id::text AS id FROM schedule_batches WHERE import_group_id=ANY($1::uuid[]) ORDER BY id", [importIds])
    : [];
  const appointmentIds = batchIds.length
    ? await idRows(client, "SELECT id::text AS id FROM appointments WHERE batch_id=ANY($1::uuid[]) ORDER BY id", [batchIds])
    : [];
  const preExisting = new Set(state.preExistingStudents.map((student) => String(student.student_number)));
  const existingNow = await client.query<{ student_number: string }>(
    "SELECT student_number FROM students WHERE student_number=ANY($1::varchar[]) ORDER BY student_number",
    [state.studentNumbers],
  );
  state.imported = {
    importIds,
    batchIds,
    appointmentIds,
    createdStudentNumbers: existingNow.rows
      .map((row) => row.student_number)
      .filter((studentNumber) => !preExisting.has(studentNumber)),
  };
  if (importIds.length) state.phase = state.phase === "STAGED" ? "STAGED" : "IMPORTED";
  return state.imported;
}

function importSummary(imported: NonNullable<FixtureState["imported"]>) {
  return {
    importIds: imported.importIds,
    batchIds: imported.batchIds,
    appointmentCount: imported.appointmentIds.length,
    createdStudentCount: imported.createdStudentNumbers.length,
  };
}

export type PublishedImportSummary = {
  importId: string;
  importStatus: string;
  totalRows: number;
  processedStudentCount: number;
  batchCount: number;
  batchStatuses: string[];
  coordinatorItemCount: number;
  laboratoryItemCount: number;
  physicalExamItemCount: number;
  appointmentCount: number;
  publishedAppointmentCount: number;
  pendingAppointmentCount: number;
  laboratoryAppointmentCount: number;
  physicalExamAppointmentCount: number;
  pairedStudentCount: number;
};

export function validatePublishedImport(
  summary: PublishedImportSummary,
  expectedStudents = EXPECTED_APPROVED_ROWS,
) {
  const expectedAppointments = expectedStudents * 2;
  if (
    summary.importStatus !== "PUBLISHED"
    || summary.batchCount !== 2
    || summary.batchStatuses.length !== 2
    || summary.batchStatuses.some((status) => status !== "PUBLISHED")
  ) {
    throw new Error(
      `Import ${summary.importId} must be fully published with exactly two published child batches; `
      + `found status ${summary.importStatus} and batches ${JSON.stringify(summary.batchStatuses)}.`,
    );
  }
  if (summary.totalRows !== expectedStudents || summary.processedStudentCount !== expectedStudents) {
    throw new Error(
      `Import ${summary.importId} must contain and process exactly ${expectedStudents} students; `
      + `found total ${summary.totalRows} and processed ${summary.processedStudentCount}.`,
    );
  }
  if (
    summary.coordinatorItemCount !== expectedAppointments
    || summary.laboratoryItemCount !== expectedStudents
    || summary.physicalExamItemCount !== expectedStudents
  ) {
    throw new Error(
      `Import ${summary.importId} must have exactly ${expectedAppointments} coordinator items `
      + `(${expectedStudents} per service); found ${summary.coordinatorItemCount}.`,
    );
  }
  if (
    summary.appointmentCount !== expectedAppointments
    || summary.publishedAppointmentCount !== expectedAppointments
    || summary.pendingAppointmentCount !== expectedAppointments
    || summary.laboratoryAppointmentCount !== expectedStudents
    || summary.physicalExamAppointmentCount !== expectedStudents
    || summary.pairedStudentCount !== expectedStudents
  ) {
    throw new Error(
      `Import ${summary.importId} must have exactly ${expectedAppointments} appointments, all published and pending, `
      + `with ${expectedStudents} complete service pairs; found ${JSON.stringify({
        appointmentCount: summary.appointmentCount,
        publishedAppointmentCount: summary.publishedAppointmentCount,
        pendingAppointmentCount: summary.pendingAppointmentCount,
        laboratoryAppointmentCount: summary.laboratoryAppointmentCount,
        physicalExamAppointmentCount: summary.physicalExamAppointmentCount,
        pairedStudentCount: summary.pairedStudentCount,
      })}.`,
    );
  }
  return summary;
}

async function peñaStudent(client: PoolClient, state: FixtureState) {
  const result = await client.query<{ studentNumber: string; surname: string }>(
    `SELECT student_number AS "studentNumber", last_name AS surname
       FROM students WHERE student_number=$1`,
    [state.studentNumbers[0]],
  );
  return result.rows[0] ?? null;
}

function manilaDate(offsetDays: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function addIsoDays(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export async function findEmptyFutureWeekday(
  client: PoolClient,
  clinicId = LABORATORY_CLINIC_ID,
  startDate = manilaDate(1),
  endDate = manilaDate(120),
) {
  const result = await client.query<{ date: string }>(
    `SELECT candidate::date::text AS date
       FROM generate_series($1::date, $2::date, interval '1 day') candidate
      WHERE EXTRACT(ISODOW FROM candidate) BETWEEN 1 AND 5
        AND NOT EXISTS (
          SELECT 1 FROM clinic_unavailable_dates unavailable
           WHERE unavailable.blocked_date=candidate::date
             AND unavailable.reopened_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM appointments appointment
           WHERE appointment.clinic_id=$3 AND appointment.appointment_date=candidate::date
             AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
        )
      ORDER BY candidate LIMIT 1`,
    [startDate, endDate, clinicId],
  );
  if (!result.rows[0]) {
    throw new Error(`No empty future clinic weekday is available from ${startDate} through ${endDate}.`);
  }
  return result.rows[0].date;
}

function monthBounds(offset: number) {
  const today = new Date(`${manilaDate(0)}T00:00:00.000Z`);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset + 1, 0));
  return {
    startDate: first.toISOString().slice(0, 10),
    endDate: last.toISOString().slice(0, 10),
  };
}

async function seedCpuRestorationFixture(
  client: PoolClient,
  state: FixtureState,
  pair: {
    studentNumber: string;
    laboratoryDate: string;
    physicalId: string;
    physicalDate: string;
  },
  kind: "safe" | "protected",
) {
  const blockBatchId = randomUUID();
  const closureGroup = await client.query<{ id: string }>(
    `INSERT INTO clinic_closure_groups (
       start_date,end_date,category,reason,created_by,creation_batch_id
     ) VALUES ($1,$1,'MAINTENANCE',$2,$3,$4)
     RETURNING id::text`,
    [
      pair.physicalDate,
      `${state.fixtureReason} ${kind} restoration`,
      ADMIN_USER_ID,
      blockBatchId,
    ],
  );
  const block = await client.query<{ id: string; updatedAt: string }>(
    `INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
     VALUES ($1,$2)
     RETURNING id::text,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"`,
    [closureGroup.rows[0].id, pair.physicalDate],
  );
  const replacementDate = await findEmptyFutureWeekday(
    client,
    PHYSICAL_EXAM_CLINIC_ID,
    addIsoDays(pair.laboratoryDate, 1),
    addIsoDays(pair.laboratoryDate, 180),
  );
  const retired = await client.query(
    `UPDATE appointments SET status='RESCHEDULED', updated_by=$2, updated_at=NOW()
      WHERE id=$1 AND status='PENDING' AND is_published=TRUE`,
    [pair.physicalId, ADMIN_USER_ID],
  );
  if (retired.rowCount !== 1) {
    throw new Error(`Expected one pending Physical Examination original for ${kind} restoration.`);
  }
  const replacement = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date, status,
       is_published, notes, rescheduled_from, created_by, updated_by,
       schedule_pair_id, schedule_cycle_start
     ) SELECT clinic_id, student_number, schedule_type, $2::date, 'PENDING',
              TRUE, $3, id, $4, $4, schedule_pair_id, schedule_cycle_start
         FROM appointments WHERE id=$1
     RETURNING id::text`,
    [
      pair.physicalId,
      replacementDate,
      `${state.fixtureReason} ${kind} restoration replacement`,
      ADMIN_USER_ID,
    ],
  );
  await client.query(
    `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
     VALUES ($1,'PENDING','RESCHEDULED',$3,$2), ($4,NULL,'PENDING',$3,$2)`,
    [
      pair.physicalId,
      ADMIN_USER_ID,
      `${state.fixtureReason} ${kind} restoration setup`,
      replacement.rows[0].id,
    ],
  );
  const event = await client.query<{ id: string }>(
    `INSERT INTO appointment_reschedule_events (
       student_number, schedule_pair_id, cause, closure_group_id, schedule_cycle_start,
       strategy, outcome,
       old_physical_exam_appointment_id, new_physical_exam_appointment_id,
       actor_user_id, block_batch_id
     ) SELECT student_number, schedule_pair_id, 'CLINIC_CLOSURE', $2, schedule_cycle_start,
              'MOVE_PHYSICAL_ONLY', 'REPLACED', id, $3, $4, $5
          FROM appointments WHERE id=$1
     RETURNING id::text`,
    [pair.physicalId, closureGroup.rows[0].id, replacement.rows[0].id, ADMIN_USER_ID, blockBatchId],
  );
  await client.query(
    `INSERT INTO appointment_reschedule_event_unavailable_dates (event_id,unavailable_date_id)
     VALUES ($1,$2)`,
    [event.rows[0].id, block.rows[0].id],
  );
  if (kind === "protected") {
    await client.query(
      `INSERT INTO exam_results (student_number, appointment_id, result_status, remarks, encoded_by)
       VALUES ($1,$2,'REQUIRES_FOLLOW_UP',$3,$4)`,
      [pair.studentNumber, replacement.rows[0].id, state.fixtureReason, ADMIN_USER_ID],
    );
  }
  return {
    clinicId: PHYSICAL_EXAM_CLINIC_ID,
    clinicName: "CPU Clinic",
    date: pair.physicalDate,
    unavailableDateId: block.rows[0].id,
    expectedUpdatedAt: block.rows[0].updatedAt,
    originalAppointmentIds: [pair.physicalId],
    replacementAppointmentIds: [replacement.rows[0].id],
    ...(kind === "protected" ? { protectedAppointmentId: replacement.rows[0].id } : {}),
  };
}

async function stage(pool: Pool, currentIdentity: AcceptanceDatabaseIdentity) {
  const state = await readState();
  if (!state) throw new Error(`No fixture state exists at ${STATE_FILE}. Run prepare first.`);
  assertMatchingAcceptanceDatabaseIdentity(currentIdentity, state.databaseIdentity);
  if (state.phase === "STAGED") throw new Error("Fixture states are already staged; use status or cleanup.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imported = await captureImport(client, state);
    if (imported.importIds.length !== 1) {
      throw new Error(`Expected one UI import for ${browserImportFilename(state)}; found ${imported.importIds.length}.`);
    }
    const importRow = await client.query<{ totalRows: number; processedStudentCount: number }>(
      `SELECT total_rows AS "totalRows",
              (created_student_count + matched_student_count)::int AS "processedStudentCount"
         FROM schedule_import_groups WHERE id=$1 FOR UPDATE`,
      [imported.importIds[0]],
    );
    const batches = await client.query<{ id: string; status: string }>(
      "SELECT id::text, status FROM schedule_batches WHERE import_group_id=$1 ORDER BY id FOR UPDATE",
      [imported.importIds[0]],
    );
    await client.query(
      "SELECT id FROM coordinator_schedule_items WHERE batch_id=ANY($1::uuid[]) FOR UPDATE",
      [imported.batchIds],
    );
    await client.query(
      "SELECT id FROM appointments WHERE batch_id=ANY($1::uuid[]) FOR UPDATE",
      [imported.batchIds],
    );
    const items = await client.query<{
      coordinatorItemCount: number;
      laboratoryItemCount: number;
      physicalExamItemCount: number;
    }>(
      `SELECT COUNT(*)::int AS "coordinatorItemCount",
              COUNT(*) FILTER (WHERE schedule_type='LABORATORY')::int AS "laboratoryItemCount",
              COUNT(*) FILTER (WHERE schedule_type='PHYSICAL_EXAM')::int AS "physicalExamItemCount"
         FROM coordinator_schedule_items WHERE batch_id=ANY($1::uuid[])`,
      [imported.batchIds],
    );
    const appointments = await client.query<{
      appointmentCount: number;
      publishedAppointmentCount: number;
      pendingAppointmentCount: number;
      laboratoryAppointmentCount: number;
      physicalExamAppointmentCount: number;
    }>(
      `SELECT COUNT(*)::int AS "appointmentCount",
              COUNT(*) FILTER (WHERE is_published=TRUE)::int AS "publishedAppointmentCount",
              COUNT(*) FILTER (WHERE status='PENDING')::int AS "pendingAppointmentCount",
              COUNT(*) FILTER (WHERE schedule_type='LABORATORY')::int AS "laboratoryAppointmentCount",
              COUNT(*) FILTER (WHERE schedule_type='PHYSICAL_EXAM')::int AS "physicalExamAppointmentCount"
         FROM appointments WHERE batch_id=ANY($1::uuid[])`,
      [imported.batchIds],
    );
    const paired = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT student_number
           FROM appointments
          WHERE batch_id=ANY($1::uuid[]) AND status='PENDING' AND is_published=TRUE
          GROUP BY student_number
         HAVING COUNT(*)=2
            AND COUNT(*) FILTER (WHERE schedule_type='LABORATORY')=1
            AND COUNT(*) FILTER (WHERE schedule_type='PHYSICAL_EXAM')=1
       ) complete_pair`,
      [imported.batchIds],
    );
    const batchStatuses = batches.rows.map((batch) => batch.status);
    const publication = validatePublishedImport({
      importId: imported.importIds[0],
      importStatus: batchStatuses.length > 0 && batchStatuses.every((status) => status === "PUBLISHED")
        ? "PUBLISHED"
        : "NEEDS_REVIEW",
      totalRows: importRow.rows[0]?.totalRows ?? 0,
      processedStudentCount: importRow.rows[0]?.processedStudentCount ?? 0,
      batchCount: batches.rows.length,
      batchStatuses,
      ...items.rows[0],
      ...appointments.rows[0],
      pairedStudentCount: paired.rows[0]?.count ?? 0,
    });
    const pairs = await client.query<{
      studentNumber: string;
      laboratoryId: string;
      laboratoryDate: string;
      physicalId: string;
      physicalDate: string;
      middleName: string | null;
    }>(
      `SELECT appointment.student_number AS "studentNumber",
              MAX(appointment.id::text) FILTER (WHERE appointment.schedule_type='LABORATORY') AS "laboratoryId",
              MAX(appointment.appointment_date::text) FILTER (WHERE appointment.schedule_type='LABORATORY') AS "laboratoryDate",
              MAX(appointment.id::text) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM') AS "physicalId",
              MAX(appointment.appointment_date::text) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM') AS "physicalDate",
              student.middle_name AS "middleName"
         FROM appointments appointment
         JOIN students student ON student.student_number=appointment.student_number
        WHERE appointment.batch_id=ANY($1::uuid[]) AND appointment.status='PENDING' AND appointment.is_published=TRUE
        GROUP BY appointment.student_number, student.middle_name
       HAVING COUNT(*) FILTER (WHERE appointment.schedule_type='LABORATORY')=1
          AND COUNT(*) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM')=1
        ORDER BY CASE WHEN BTRIM(COALESCE(student.middle_name, '')) LIKE '% %' THEN 0 ELSE 1 END,
                 appointment.student_number
        LIMIT 9`,
      [imported.batchIds],
    );
    if (pairs.rows.length < 9) throw new Error(`Expected at least nine published appointment pairs; found ${pairs.rows.length}.`);
    const [
      fullMiddleName,
      correction,
      complete,
      mixed,
      clinicContext,
      safeRestorationPair,
      protectedRestorationPair,
      noShow,
      unavailableLaboratory,
    ] = pairs.rows;
    if (!fullMiddleName.middleName?.includes(" ")) {
      throw new Error("Acceptance import must provide a student with a multi-word middle name.");
    }
    const appointmentIds = [
      correction.laboratoryId,
      complete.laboratoryId,
      complete.physicalId,
      mixed.laboratoryId,
      mixed.physicalId,
    ];
    await client.query(
      "SELECT id FROM appointments WHERE id=ANY($1::uuid[]) FOR UPDATE",
      [[...appointmentIds, noShow.laboratoryId, unavailableLaboratory.laboratoryId]],
    );
    const correctionDate = manilaDate(-2);
    await client.query(
      `UPDATE appointments
          SET status='COMPLETED',
              appointment_date=CASE WHEN id=$2::uuid THEN $3::date ELSE appointment_date END,
              updated_by=$4, updated_at=NOW()
        WHERE id=ANY($1::uuid[])`,
      [appointmentIds, correction.laboratoryId, correctionDate, ADMIN_USER_ID],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
       SELECT id, 'PENDING', 'COMPLETED', $2, $3 FROM UNNEST($1::uuid[]) fixture(id)`,
      [appointmentIds, `${state.fixtureReason} deterministic Browser state`, ADMIN_USER_ID],
    );
    await client.query(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status, completed_at, remarks, encoded_by)
       VALUES ($1,$2,'COMPLETED',$3::date,$4,$7), ($5,$6,'COMPLETED',$3::date,$4,$7)`,
      [
        complete.studentNumber, complete.laboratoryId, manilaDate(0), state.fixtureReason,
        mixed.studentNumber, mixed.laboratoryId, ADMIN_USER_ID,
      ],
    );
    await client.query(
      `INSERT INTO exam_results (student_number, appointment_id, result_status, completed_at, remarks, encoded_by)
       VALUES ($1,$2,'COMPLETED',$3::date,$4,$7), ($5,$6,'REQUIRES_FOLLOW_UP',NULL,$4,$7)`,
      [
        complete.studentNumber, complete.physicalId, manilaDate(0), state.fixtureReason,
        mixed.studentNumber, mixed.physicalId, ADMIN_USER_ID,
      ],
    );
    const noShowDate = manilaDate(-2);
    noShow.laboratoryDate = noShowDate;
    await client.query(
      `UPDATE appointments
          SET status='NO_SHOW', appointment_date=$2::date, updated_by=$3, updated_at=NOW()
        WHERE id=$1 AND status='PENDING' AND is_published=TRUE`,
      [noShow.laboratoryId, noShowDate, ADMIN_USER_ID],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
       VALUES ($1,'PENDING','NO_SHOW',$2,NULL)`,
      [noShow.laboratoryId, AUTOMATIC_NO_SHOW_NOTE],
    );
    const unavailableLaboratoryUpdate = await client.query(
      `UPDATE appointments
          SET status='CANCELLED', updated_by=$2, updated_at=NOW()
        WHERE id=$1 AND status='PENDING' AND is_published=TRUE`,
      [unavailableLaboratory.laboratoryId, ADMIN_USER_ID],
    );
    if (unavailableLaboratoryUpdate.rowCount !== 1) {
      throw new Error("Expected one pending Laboratory appointment for the Not available fixture.");
    }
    await client.query(
      `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, notes, changed_by)
       VALUES ($1,'PENDING','CANCELLED',$2,$3)`,
      [
        unavailableLaboratory.laboratoryId,
        `${state.fixtureReason} deterministic Not available state`,
        ADMIN_USER_ID,
      ],
    );
    const safeRestorationMonth = monthBounds(3);
    const protectedRestorationMonth = monthBounds(4);
    safeRestorationPair.physicalDate = await findEmptyFutureWeekday(
      client,
      PHYSICAL_EXAM_CLINIC_ID,
      safeRestorationMonth.startDate,
      safeRestorationMonth.endDate,
    );
    await client.query(
      "UPDATE appointments SET appointment_date=$2::date, updated_by=$3, updated_at=NOW() WHERE id=$1",
      [safeRestorationPair.physicalId, safeRestorationPair.physicalDate, ADMIN_USER_ID],
    );
    protectedRestorationPair.physicalDate = await findEmptyFutureWeekday(
      client,
      PHYSICAL_EXAM_CLINIC_ID,
      protectedRestorationMonth.startDate,
      protectedRestorationMonth.endDate,
    );
    await client.query(
      "UPDATE appointments SET appointment_date=$2::date, updated_by=$3, updated_at=NOW() WHERE id=$1",
      [protectedRestorationPair.physicalId, protectedRestorationPair.physicalDate, ADMIN_USER_ID],
    );
    const safeRestoration = await seedCpuRestorationFixture(
      client,
      state,
      safeRestorationPair,
      "safe",
    );
    const protectedRestoration = await seedCpuRestorationFixture(
      client,
      state,
      protectedRestorationPair,
      "protected",
    );
    const firstDraftMonth = monthBounds(1);
    const secondDraftMonth = monthBounds(2);
    const draftBlocks = [{
      clinicId: LABORATORY_CLINIC_ID,
      clinicName: "KABALAKA Clinic",
      date: await findEmptyFutureWeekday(
        client,
        LABORATORY_CLINIC_ID,
        firstDraftMonth.startDate,
        firstDraftMonth.endDate,
      ),
    }, {
      clinicId: PHYSICAL_EXAM_CLINIC_ID,
      clinicName: "CPU Clinic",
      date: await findEmptyFutureWeekday(
        client,
        PHYSICAL_EXAM_CLINIC_ID,
        secondDraftMonth.startDate,
        secondDraftMonth.endDate,
      ),
    }];
    const calendar = validateCalendarAcceptanceFixture({
      draftBlocks,
      safeRestoration,
      protectedRestoration: {
        ...protectedRestoration,
        protectedAppointmentId: protectedRestoration.protectedAppointmentId!,
      },
    });
    const successCalendarDate = draftBlocks[0].date;
    const quickStatus = validateQuickStatusAcceptanceFixture({
      pending: {
        studentNumber: fullMiddleName.studentNumber,
        appointmentId: fullMiddleName.laboratoryId,
        appointmentDate: fullMiddleName.laboratoryDate,
      },
      noShow: {
        studentNumber: noShow.studentNumber,
        appointmentId: noShow.laboratoryId,
        appointmentDate: noShow.laboratoryDate,
      },
      protected: {
        studentNumber: complete.studentNumber,
        appointmentId: complete.laboratoryId,
        appointmentDate: complete.laboratoryDate,
      },
    });
    const otherStagedPairs = pairs.rows.slice(0, 8);
    const laboratoryStatus = validateLaboratoryStatusAcceptanceFixture({
      unavailable: {
        studentNumber: unavailableLaboratory.studentNumber,
        laboratoryAppointmentId: unavailableLaboratory.laboratoryId,
        physicalAppointmentId: unavailableLaboratory.physicalId,
      },
    }, {
      studentNumbers: otherStagedPairs.map((pair) => pair.studentNumber),
      appointmentIds: [
        ...otherStagedPairs.flatMap((pair) => [pair.laboratoryId, pair.physicalId]),
        ...calendar.safeRestoration.originalAppointmentIds,
        ...calendar.safeRestoration.replacementAppointmentIds,
        ...calendar.protectedRestoration.originalAppointmentIds,
        ...calendar.protectedRestoration.replacementAppointmentIds,
      ],
    });
    state.phase = "STAGED";
    state.staged = {
      correction: {
        studentNumber: correction.studentNumber,
        appointmentId: correction.laboratoryId,
        appointmentDate: correctionDate,
      },
      complete: {
        studentNumber: complete.studentNumber,
        laboratoryAppointmentId: complete.laboratoryId,
        physicalAppointmentId: complete.physicalId,
      },
      mixed: {
        studentNumber: mixed.studentNumber,
        laboratoryAppointmentId: mixed.laboratoryId,
        physicalAppointmentId: mixed.physicalId,
      },
      clinicContextStudentNumber: clinicContext.studentNumber,
      successCalendarDate,
      failureCalendarDate: protectedRestoration.date,
      calendar,
      quickStatus,
      laboratoryStatus,
    };
    await client.query("COMMIT");
    await writeState(state);
    return {
      mode: "stage",
      statePath: STATE_FILE,
      phase: state.phase,
      import: importSummary(state.imported!),
      publication,
      peñaStudent: await peñaStudent(client, state),
      browser: {
        ...state.staged,
        calendarClinic: "Kabalaka Clinic",
        calendarCategory: "Closure",
        calendarReason: state.fixtureReason,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function quickStatusDatabaseProof(client: PoolClient, fixture?: QuickStatusAcceptanceFixture) {
  if (!fixture) return null;
  const roles = new Map([
    [fixture.pending.appointmentId, "pending"],
    [fixture.noShow.appointmentId, "noShow"],
    [fixture.protected.appointmentId, "protected"],
  ]);
  const result = await client.query<{
    id: string;
    appointmentDate: string;
    status: string;
    resultStatus: string | null;
    statusLogCount: number;
    auditCount: number;
  }>(
    `SELECT appointment.id::text,
            appointment.appointment_date::text AS "appointmentDate",
            appointment.status,
            result.result_status AS "resultStatus",
            (SELECT COUNT(*)::int FROM appointment_status_logs log
              WHERE log.appointment_id=appointment.id) AS "statusLogCount",
            (SELECT COUNT(*)::int FROM audit_logs audit
              WHERE audit.entity_type='appointment' AND audit.entity_id=appointment.id::text) AS "auditCount"
       FROM appointments appointment
       LEFT JOIN laboratory_results result ON result.appointment_id=appointment.id
      WHERE appointment.id=ANY($1::uuid[])
      ORDER BY appointment.id`,
    [[...roles.keys()]],
  );
  return result.rows.map((row) => ({ role: roles.get(row.id), ...row }));
}

async function laboratoryStatusDatabaseProof(
  client: PoolClient,
  fixture?: LaboratoryStatusAcceptanceFixture,
) {
  if (!fixture) return null;
  const { unavailable } = fixture;
  const result = await client.query<{
    id: string;
    studentNumber: string;
    scheduleType: string;
    status: string;
    isPublished: boolean;
    statusLogCount: number;
    latestOldStatus: string | null;
    latestNewStatus: string | null;
    latestNotes: string | null;
    latestChangedBy: string | null;
  }>(
    `SELECT appointment.id::text,
            appointment.student_number AS "studentNumber",
            appointment.schedule_type AS "scheduleType",
            appointment.status,
            appointment.is_published AS "isPublished",
            (SELECT COUNT(*)::int FROM appointment_status_logs log
              WHERE log.appointment_id=appointment.id) AS "statusLogCount",
            latest.old_status AS "latestOldStatus",
            latest.new_status AS "latestNewStatus",
            latest.notes AS "latestNotes",
            latest.changed_by::text AS "latestChangedBy"
       FROM appointments appointment
       LEFT JOIN LATERAL (
         SELECT old_status, new_status, notes, changed_by
           FROM appointment_status_logs
          WHERE appointment_id=appointment.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE appointment.id=ANY($1::uuid[])
      ORDER BY appointment.schedule_type`,
    [[unavailable.laboratoryAppointmentId, unavailable.physicalAppointmentId]],
  );
  return { ...unavailable, appointments: result.rows };
}

async function status(pool: Pool, currentIdentity: AcceptanceDatabaseIdentity) {
  const state = await readState();
  if (!state) {
    return { mode: "status", statePath: STATE_FILE, phase: "ABSENT" };
  }
  assertMatchingAcceptanceDatabaseIdentity(currentIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try {
    const imported = await captureImport(client, state);
    const capacities = await client.query<CapacityBaseline>(
      `SELECT id::text, safe_daily_capacity AS "safeDailyCapacity", max_daily_capacity AS "maxDailyCapacity"
         FROM clinic_capacity_settings ORDER BY id`,
    );
    // Status deliberately includes fixture-owned active and historical soft-unblocked rows.
    const calendarRows = (await client.query<{
      id: string;
      unblockedAt: Date | null;
      createdBatchId: string | null;
      unblockedBatchId: string | null;
    }>(
      `SELECT unavailable.id::text, unavailable.reopened_at AS "unblockedAt",
              closure.creation_batch_id::text AS "createdBatchId",
              unavailable.reopening_batch_id::text AS "unblockedBatchId"
         FROM clinic_unavailable_dates unavailable
         JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
        WHERE closure.reason LIKE $1 AND closure.created_at >= $2::timestamptz
        ORDER BY unavailable.id`,
      [`${state.fixtureReason}%`, state.startedAt],
    )).rows;
    const eventProvenance = (await client.query<{
      id: string;
      blockBatchId: string | null;
      restorationBatchId: string | null;
      restoredAt: Date | null;
    }>(
      `SELECT event.id::text, event.block_batch_id::text AS "blockBatchId",
              event.restoration_batch_id::text AS "restorationBatchId",
              event.restored_at AS "restoredAt"
         FROM appointment_reschedule_events event
         JOIN appointment_reschedule_event_unavailable_dates link ON link.event_id=event.id
         JOIN clinic_unavailable_dates unavailable ON unavailable.id=link.unavailable_date_id
         JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
        WHERE closure.reason LIKE $1 AND closure.created_at >= $2::timestamptz
        ORDER BY event.id`,
      [`${state.fixtureReason}%`, state.startedAt],
    )).rows;
    await writeState(state);
    return {
      mode: "status",
      statePath: STATE_FILE,
      phase: state.phase,
      source: state.source,
      temporaryCsv: state.temporaryCsv,
      browserImport: state.browserImport,
      preExistingMatchingStudents: state.preExistingStudents.length,
      imported: importSummary(imported),
      peñaStudent: await peñaStudent(client, state),
      staged: state.staged,
      quickStatusProof: await quickStatusDatabaseProof(client, state.staged?.quickStatus),
      laboratoryStatusProof: await laboratoryStatusDatabaseProof(
        client,
        state.staged?.laboratoryStatus,
      ),
      fixtureClosures: calendarRows.map((row) => row.id),
      calendarProof: {
        rowCount: calendarRows.length,
        activeCount: calendarRows.filter((row) => row.unblockedAt === null).length,
        unblockedCount: calendarRows.filter((row) => row.unblockedAt !== null).length,
        allRowsHaveCreationProvenance: calendarRows.every((row) => Boolean(row.createdBatchId)),
        allUnblockedRowsHaveRestorationProvenance: calendarRows
          .filter((row) => row.unblockedAt !== null)
          .every((row) => Boolean(row.unblockedBatchId)),
        eventCount: eventProvenance.length,
        allEventsHaveBlockProvenance: eventProvenance.every((event) => Boolean(event.blockBatchId)),
        restoredEventsHaveRestorationProvenance: eventProvenance
          .filter((event) => event.restoredAt !== null)
          .every((event) => Boolean(event.restorationBatchId)),
      },
      capacities: capacities.rows,
      fixtureReason: state.fixtureReason,
    };
  } finally {
    client.release();
  }
}

export type CleanupManifest = {
  imports: string[];
  batches: string[];
  calendarBatchIds: string[];
  coordinatorItems: string[];
  createdStudents: string[];
  appointments: string[];
  closures: string[];
  submissions: string[];
  resultFiles: Array<{ id: string; storageKey: string }>;
  laboratoryResults: string[];
  examResults: string[];
  statusLogs: string[];
  audits: string[];
  notifications: string[];
  events: string[];
  verificationTokens: string[];
  loginAttempts: string[];
  outbox: string[];
  referencePrograms: string[];
};

export type CleanupProgress = {
  phase: "MANIFESTED" | "DATABASE_DELETED" | "FILES_DELETED";
  manifest: CleanupManifest;
  privateResultStorageKeys: string[];
  privateResultDirectories: string[];
};

export type CleanupResidue = {
  imports: number;
  batches: number;
  coordinatorItems: number;
  students: number;
  appointments: number;
  closures: number;
  submissions: number;
  resultFiles: number;
  laboratoryResults: number;
  examResults: number;
  statusLogs: number;
  events: number;
  notifications: number;
  audits: number;
  verificationTokens: number;
  loginAttempts: number;
  outbox: number;
  referencePrograms: number;
  privateStorageDirectories: number;
};

type PersistedCleanupActions = {
  captureManifest: () => Promise<CleanupManifest>;
  persist: (progress: CleanupProgress) => Promise<void>;
  deleteDatabase: (manifest: CleanupManifest) => Promise<void>;
  deletePrivateFiles: (directories: string[]) => Promise<void>;
  prove: (manifest: CleanupManifest, directories: string[]) => Promise<CleanupResidue>;
};

export function assertZeroCleanupResidue(residue: CleanupResidue) {
  const remaining = Object.entries(residue).filter(([, count]) => count !== 0);
  if (remaining.length) {
    throw new Error(
      `Fixture cleanup residue remains: ${remaining.map(([category, count]) => `${category}=${count}`).join(", ")}.`,
    );
  }
}

export async function runPersistedCleanup(
  progress: CleanupProgress | undefined,
  actions: PersistedCleanupActions,
) {
  let current = progress;
  if (!current) {
    const manifest = await actions.captureManifest();
    current = {
      phase: "MANIFESTED",
      manifest,
      privateResultStorageKeys: manifest.resultFiles.map((file) => file.storageKey),
      privateResultDirectories: resultStorageDirectories(manifest.resultFiles),
    };
    await actions.persist(current);
  }

  if (current.phase === "MANIFESTED") {
    await actions.deleteDatabase(current.manifest);
    current = { ...current, phase: "DATABASE_DELETED" };
    await actions.persist(current);
  }
  if (current.phase === "DATABASE_DELETED") {
    await actions.deletePrivateFiles(current.privateResultDirectories);
    current = { ...current, phase: "FILES_DELETED" };
    await actions.persist(current);
  }
  const proof = await actions.prove(current.manifest, current.privateResultDirectories);
  assertZeroCleanupResidue(proof);
  return proof;
}

export async function collectCleanupManifest(
  client: PoolClient,
  state: FixtureState,
): Promise<CleanupManifest> {
  const imports = await idRows(
    client,
    "SELECT id::text AS id FROM schedule_import_groups WHERE source_filename=$1 AND created_at >= $2::timestamptz",
    [browserImportFilename(state), state.startedAt],
  );
  const batches = imports.length
    ? await idRows(client, "SELECT id::text AS id FROM schedule_batches WHERE import_group_id=ANY($1::uuid[])", [imports])
    : [];
  const appointments = batches.length
    ? await idRows(
      client,
      `WITH RECURSIVE owned AS (
         SELECT id FROM appointments WHERE batch_id=ANY($1::uuid[])
         UNION SELECT child.id FROM appointments child JOIN owned parent ON child.rescheduled_from=parent.id
       ) SELECT id::text FROM owned`,
      [batches],
    )
    : [];
  const closures = differenceIds(
    await idRows(
      client,
      // Cleanup owns both active and historical soft-unblocked records for this tagged run.
      `SELECT unavailable.id::text AS id
         FROM clinic_unavailable_dates unavailable
         JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
        WHERE closure.reason LIKE $1 AND unavailable.created_at >= $2::timestamptz`,
      [`${state.fixtureReason}%`, state.startedAt],
    ),
    state.baseline.ids.closures,
  );
  const calendarBatchIds = closures.length
    ? await idRows(
      client,
      `SELECT batch_id::text AS id
         FROM (
           SELECT closure.creation_batch_id AS batch_id
             FROM clinic_unavailable_dates unavailable
             JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
            WHERE unavailable.id=ANY($1::uuid[])
           UNION
           SELECT reopening_batch_id AS batch_id
             FROM clinic_unavailable_dates WHERE id=ANY($1::uuid[])
         ) fixture_batches
        WHERE batch_id IS NOT NULL
        ORDER BY batch_id`,
      [closures],
    )
    : [];
  const submissions = appointments.length
    ? await idRows(client, "SELECT id::text AS id FROM student_result_submissions WHERE appointment_id=ANY($1::uuid[])", [appointments])
    : [];
  const resultFiles = submissions.length
    ? (await client.query<{ id: string; storageKey: string }>(
      "SELECT id::text, storage_key AS \"storageKey\" FROM student_result_files WHERE submission_id=ANY($1::uuid[])",
      [submissions],
    )).rows
    : [];
  const laboratoryResults = appointments.length
    ? await idRows(client, "SELECT id::text AS id FROM laboratory_results WHERE appointment_id=ANY($1::uuid[])", [appointments])
    : [];
  const examResults = appointments.length
    ? await idRows(client, "SELECT id::text AS id FROM exam_results WHERE appointment_id=ANY($1::uuid[])", [appointments])
    : [];
  const statusLogs = appointments.length
    ? await idRows(client, "SELECT id::text AS id FROM appointment_status_logs WHERE appointment_id=ANY($1::uuid[])", [appointments])
    : [];
  const events = (appointments.length || imports.length || closures.length)
    ? await idRows(
      client,
      `SELECT id::text AS id FROM appointment_reschedule_events
        WHERE source_import_group_id=ANY($1::uuid[])
           OR id IN (
             SELECT event_id FROM appointment_reschedule_event_unavailable_dates
              WHERE unavailable_date_id=ANY($2::uuid[])
           )
           OR old_laboratory_appointment_id=ANY($3::uuid[])
           OR new_laboratory_appointment_id=ANY($3::uuid[])
           OR old_physical_exam_appointment_id=ANY($3::uuid[])
           OR new_physical_exam_appointment_id=ANY($3::uuid[])`,
      [imports, closures, appointments],
    )
    : [];
  const preExisting = new Set(state.preExistingStudents.map((student) => String(student.student_number)));
  const createdStudents = (await client.query<{ student_number: string }>(
    "SELECT student_number FROM students WHERE student_number=ANY($1::varchar[])",
    [state.studentNumbers],
  )).rows.map((row) => row.student_number).filter((studentNumber) => !preExisting.has(studentNumber));
  const notifications = differenceIds(
    await idRows(
      client,
      `SELECT id::text AS id FROM student_portal_notifications
        WHERE student_number=ANY($1::varchar[])
           OR metadata->>'sourceImportId'=ANY($2::text[])
           OR metadata->>'clinicUnavailableDateId'=ANY($3::text[])
           OR metadata->>'appointmentId'=ANY($4::text[])
           OR metadata->>'submissionId'=ANY($5::text[])`,
      [createdStudents, imports, closures, appointments, submissions],
    ),
    state.baseline.ids.notifications,
  );
  const auditCandidates = await idRows(
    client,
    `SELECT id::text AS id FROM audit_logs
      WHERE (entity_type='schedule_import_group' AND entity_id=ANY($1::text[]))
         OR (entity_type='schedule_batch' AND entity_id=ANY($2::text[]))
         OR (entity_type='appointment' AND entity_id=ANY($3::text[]))
         OR (entity_type='clinic_unavailable_date' AND entity_id=ANY($4::text[]))
         OR (entity_type='student' AND entity_id=ANY($5::text[]))
         OR entity_id=ANY($6::text[])
         OR metadata->>'importId'=ANY($1::text[])
         OR metadata->>'sourceImportId'=ANY($1::text[])
         OR metadata->>'batchId'=ANY($2::text[])
         OR metadata->>'replacementId'=ANY($3::text[])
         OR metadata->>'clinicUnavailableDateId'=ANY($4::text[])
         OR metadata->>'studentNumber'=ANY($5::text[])
         OR metadata->>'appointmentId'=ANY($3::text[])
         OR metadata->>'submissionId'=ANY($7::text[])
         OR (
           entity_type='clinic_calendar_batch'
           AND (
             entity_id=ANY($8::text[])
             OR metadata->>'batchId'=ANY($8::text[])
           )
         )`,
    [
      imports,
      batches,
      appointments,
      closures,
      createdStudents,
      [...laboratoryResults, ...examResults, ...submissions, ...resultFiles.map((file) => file.id)],
      submissions,
      calendarBatchIds,
    ],
  );
  return {
    imports,
    batches,
    calendarBatchIds,
    appointments,
    coordinatorItems: batches.length
      ? await idRows(client, "SELECT id::text AS id FROM coordinator_schedule_items WHERE batch_id=ANY($1::uuid[])", [batches])
      : [],
    closures,
    submissions,
    resultFiles,
    laboratoryResults,
    examResults,
    statusLogs,
    audits: differenceIds(auditCandidates, state.baseline.ids.audits),
    notifications,
    events: differenceIds(events, state.baseline.ids.rescheduleEvents),
    createdStudents,
    verificationTokens: differenceIds(
      await idRows(
        client,
        "SELECT id::text AS id FROM student_email_verifications WHERE student_number=ANY($1::varchar[])",
        [createdStudents],
      ),
      state.baseline.ids.verificationTokens,
    ),
    loginAttempts: differenceIds(
      await idRows(
        client,
        "SELECT id::text AS id FROM student_login_attempts WHERE student_number=ANY($1::varchar[])",
        [createdStudents],
      ),
      state.baseline.ids.loginAttempts,
    ),
    outbox: differenceIds(
      await idRows(
        client,
        "SELECT id::text AS id FROM email_outbox WHERE student_number=ANY($1::varchar[])",
        [createdStudents],
      ),
      state.baseline.ids.outbox,
    ),
    referencePrograms: state.referencePrograms.temporary.map((program) => program.id),
  };
}

async function deleteByIds(client: PoolClient, table: string, ids: string[]) {
  if (!ids.length) return;
  await client.query(`DELETE FROM ${table} WHERE id=ANY($1::uuid[])`, [ids]);
}

async function restoreStudents(client: PoolClient, students: JsonObject[]) {
  if (!students.length) return;
  await client.query("ALTER TABLE students DISABLE TRIGGER students_updated_at");
  for (const student of students) {
    await client.query(
      `UPDATE students SET
         first_name=$2, middle_name=$3, last_name=$4, suffix=$5,
         college_id=$6, program_id=$7, year_level=$8, section=$9,
         is_active=$10, date_of_birth=$11, email=$12, email_verified_at=$13,
         created_at=$14, updated_at=$15
       WHERE student_number=$1`,
      [
        student.student_number, student.first_name, student.middle_name, student.last_name,
        student.suffix, student.college_id, student.program_id, student.year_level,
        student.section, student.is_active, student.date_of_birth, student.email,
        student.email_verified_at, student.created_at, student.updated_at,
      ],
    );
  }
  await client.query("ALTER TABLE students ENABLE TRIGGER students_updated_at");
}

async function restorePrograms(client: PoolClient, programs: JsonObject[]) {
  if (!programs.length) return;
  await client.query("ALTER TABLE programs DISABLE TRIGGER programs_updated_at");
  for (const program of programs) {
    await client.query(
      `UPDATE programs SET college_id=$2, code=$3, name=$4, is_active=$5,
                           created_at=$6, updated_at=$7 WHERE id=$1`,
      [
        program.id, program.college_id, program.code, program.name,
        program.is_active, program.created_at, program.updated_at,
      ],
    );
  }
  await client.query("ALTER TABLE programs ENABLE TRIGGER programs_updated_at");
}

export function resultStorageDirectories(files: CleanupManifest["resultFiles"]) {
  return [...new Set(files.map((file) => file.storageKey.split("/")[0]).filter(Boolean))];
}

function privateStorageTarget(directory: string) {
  const target = resolve(RESULT_STORAGE_ROOT, directory);
  if (!target.startsWith(`${RESULT_STORAGE_ROOT}${sep}`)) {
    throw new Error(`Refusing to access result storage outside ${RESULT_STORAGE_ROOT}: ${target}`);
  }
  return target;
}

async function removePrivateFiles(directories: string[]) {
  for (const directory of directories) {
    await rm(privateStorageTarget(directory), { recursive: true, force: true });
  }
}

async function existingPrivateDirectoryCount(directories: string[]) {
  let count = 0;
  for (const directory of directories) {
    try {
      await access(privateStorageTarget(directory));
      count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return count;
}

async function countIds(client: PoolClient, table: string, ids: string[]) {
  if (!ids.length) return 0;
  return Number((await client.query(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE id=ANY($1::uuid[])`,
    [ids],
  )).rows[0].count);
}

async function countOwnedAuditResidue(client: PoolClient, manifest: CleanupManifest) {
  if (!manifest.audits.length && !manifest.calendarBatchIds.length) return 0;
  return Number((await client.query(
    `SELECT COUNT(*)::int AS count FROM audit_logs
      WHERE id=ANY($1::uuid[])
         OR (
           entity_type='clinic_calendar_batch'
           AND (
             entity_id=ANY($2::text[])
             OR metadata->>'batchId'=ANY($2::text[])
           )
         )`,
    [manifest.audits, manifest.calendarBatchIds],
  )).rows[0].count);
}

async function deleteOwnedAuditRows(client: PoolClient, manifest: CleanupManifest) {
  if (!manifest.audits.length && !manifest.calendarBatchIds.length) return;
  await client.query(
    `DELETE FROM audit_logs
      WHERE id=ANY($1::uuid[])
         OR (
           entity_type='clinic_calendar_batch'
           AND (
             entity_id=ANY($2::text[])
             OR metadata->>'batchId'=ANY($2::text[])
           )
         )`,
    [manifest.audits, manifest.calendarBatchIds],
  );
}

export async function countCleanupResidue(
  client: PoolClient,
  manifest: CleanupManifest,
  privateDirectories: string[],
): Promise<CleanupResidue> {
  return {
    imports: await countIds(client, "schedule_import_groups", manifest.imports),
    batches: await countIds(client, "schedule_batches", manifest.batches),
    coordinatorItems: await countIds(client, "coordinator_schedule_items", manifest.coordinatorItems),
    students: manifest.createdStudents.length
      ? Number((await client.query(
        "SELECT COUNT(*)::int AS count FROM students WHERE student_number=ANY($1::varchar[])",
        [manifest.createdStudents],
      )).rows[0].count)
      : 0,
    appointments: await countIds(client, "appointments", manifest.appointments),
    closures: await countIds(client, "clinic_unavailable_dates", manifest.closures),
    submissions: await countIds(client, "student_result_submissions", manifest.submissions),
    resultFiles: await countIds(client, "student_result_files", manifest.resultFiles.map((file) => file.id)),
    laboratoryResults: await countIds(client, "laboratory_results", manifest.laboratoryResults),
    examResults: await countIds(client, "exam_results", manifest.examResults),
    statusLogs: await countIds(client, "appointment_status_logs", manifest.statusLogs),
    events: await countIds(client, "appointment_reschedule_events", manifest.events),
    notifications: await countIds(client, "student_portal_notifications", manifest.notifications),
    audits: await countOwnedAuditResidue(client, manifest),
    verificationTokens: await countIds(client, "student_email_verifications", manifest.verificationTokens),
    loginAttempts: await countIds(client, "student_login_attempts", manifest.loginAttempts),
    outbox: await countIds(client, "email_outbox", manifest.outbox),
    referencePrograms: await countIds(client, "programs", manifest.referencePrograms),
    privateStorageDirectories: await existingPrivateDirectoryCount(privateDirectories),
  };
}

export async function deleteDatabaseManifestWithClient(
  client: PoolClient,
  state: FixtureState,
  manifest: CleanupManifest,
) {
  await deleteOwnedAuditRows(client, manifest);
  await deleteByIds(client, "student_portal_notifications", manifest.notifications);
  await deleteByIds(client, "appointment_reschedule_events", manifest.events);
  await deleteByIds(client, "student_result_files", manifest.resultFiles.map((file) => file.id));
  await deleteByIds(client, "student_result_submissions", manifest.submissions);
  await deleteByIds(client, "exam_results", manifest.examResults);
  await deleteByIds(client, "laboratory_results", manifest.laboratoryResults);
  await deleteByIds(client, "appointment_status_logs", manifest.statusLogs);
  await deleteByIds(client, "appointments", manifest.appointments);
  await deleteByIds(client, "coordinator_schedule_items", manifest.coordinatorItems);
  await deleteByIds(client, "schedule_batches", manifest.batches);
  await deleteByIds(client, "schedule_import_groups", manifest.imports);
  await deleteByIds(client, "clinic_unavailable_dates", manifest.closures);
  await client.query(
    `DELETE FROM clinic_closure_groups closure
      WHERE closure.reason LIKE $1
        AND NOT EXISTS (
          SELECT 1 FROM clinic_unavailable_dates unavailable
           WHERE unavailable.closure_group_id=closure.id
        )`,
    [`${state.fixtureReason}%`],
  );
  await deleteByIds(client, "student_email_verifications", manifest.verificationTokens);
  await deleteByIds(client, "student_login_attempts", manifest.loginAttempts);
  await deleteByIds(client, "email_outbox", manifest.outbox);
  await restoreStudents(client, state.preExistingStudents);
  if (manifest.createdStudents.length) {
    await client.query(
      "DELETE FROM students WHERE student_number=ANY($1::varchar[])",
      [manifest.createdStudents],
    );
  }
  await restorePrograms(client, state.referencePrograms.preExisting);
  await deleteByIds(client, "programs", manifest.referencePrograms);
  for (const capacity of state.baseline.capacities) {
    await client.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=$2, max_daily_capacity=$3
        WHERE id=$1`,
      [capacity.id, capacity.safeDailyCapacity, capacity.maxDailyCapacity],
    );
  }
}

async function deleteDatabaseManifest(pool: Pool, state: FixtureState, manifest: CleanupManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await deleteDatabaseManifestWithClient(client, state, manifest);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool: Pool, currentIdentity: AcceptanceDatabaseIdentity) {
  const state = await readState();
  if (!state) {
    return { mode: "cleanup", statePath: STATE_FILE, phase: "ABSENT", message: "No fixture state exists." };
  }
  assertMatchingAcceptanceDatabaseIdentity(currentIdentity, state.databaseIdentity);

  const proof = await runPersistedCleanup(state.cleanup, {
    captureManifest: async () => {
      const client = await pool.connect();
      try {
        return await collectCleanupManifest(client, state);
      } finally {
        client.release();
      }
    },
    persist: async (progress) => {
      state.cleanup = progress;
      await writeState(state);
    },
    deleteDatabase: async (manifest) => deleteDatabaseManifest(pool, state, manifest),
    deletePrivateFiles: removePrivateFiles,
    prove: async (manifest, privateDirectories) => {
      const client = await pool.connect();
      try {
        return await countCleanupResidue(client, manifest, privateDirectories);
      } finally {
        client.release();
      }
    },
  });

  const proofClient = await pool.connect();
  try {
    const capacities = await proofClient.query<CapacityBaseline>(
      `SELECT id::text, safe_daily_capacity AS "safeDailyCapacity", max_daily_capacity AS "maxDailyCapacity"
         FROM clinic_capacity_settings ORDER BY id`,
    );
    const baselineCapacityJson = JSON.stringify(state.baseline.capacities);
    const currentCapacityJson = JSON.stringify(capacities.rows);
    const currentStudents = state.preExistingStudents.length
      ? (await proofClient.query<{ value: JsonObject }>(
        "SELECT to_jsonb(student) AS value FROM students student WHERE student_number=ANY($1::varchar[])",
        [state.preExistingStudents.map((student) => student.student_number)],
      )).rows.map(({ value }) => value)
      : [];
    const currentPrograms = state.referencePrograms.preExisting.length
      ? (await proofClient.query<{ value: JsonObject }>(
        "SELECT to_jsonb(program) AS value FROM programs program WHERE id=ANY($1::uuid[])",
        [state.referencePrograms.preExisting.map((program) => program.id)],
      )).rows.map(({ value }) => value)
      : [];
    const preExistingStudentsPreservedExactly = baselineRowsMatch(
      state.preExistingStudents,
      currentStudents,
      "student_number",
    );
    const preExistingProgramsPreservedExactly = baselineRowsMatch(
      state.referencePrograms.preExisting,
      currentPrograms,
      "id",
    );
    if (baselineCapacityJson !== currentCapacityJson) {
      throw new Error(`Capacity restoration mismatch. State retained at ${STATE_FILE}.`);
    }
    if (!preExistingStudentsPreservedExactly || !preExistingProgramsPreservedExactly) {
      throw new Error(`Pre-existing row restoration mismatch. State retained at ${STATE_FILE}.`);
    }
    await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
    return {
      mode: "cleanup",
      statePath: STATE_FILE,
      removedTemporaryCsv: state.temporaryCsv.path,
      restoredPreExistingStudents: state.preExistingStudents.length,
      restoredPreExistingPrograms: state.referencePrograms.preExisting.length,
      restoredCapacityRows: state.baseline.capacities.length,
      capacityColumnsRestoredExactly: true,
      preExistingStudentsPreservedExactly,
      preExistingProgramsPreservedExactly,
      residue: proof,
    };
  } finally {
    proofClient.release();
  }
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["prepare", "stage", "status", "cleanup"].includes(mode)) {
    throw new Error(
      "Use prepare, stage, status, or cleanup with a loopback PostgreSQL DATABASE_URL and CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE=1.",
    );
  }
  const persistedState = await readState();
  const persistedIdentity = persistedState
    ? persistedState.databaseIdentity
    : undefined;
  if (persistedState && !persistedIdentity) {
    assertMatchingAcceptanceDatabaseIdentity(
      assertSafeAcceptanceDatabase(
        process.env.DATABASE_URL,
        process.env.CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE,
      ),
      persistedIdentity,
    );
  }
  const output = await runGuardedAcceptanceDatabaseOperation({
    databaseUrl: process.env.DATABASE_URL,
    exclusiveDatabase: process.env.CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE,
    persistedIdentity,
    operation: async (currentIdentity) => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        return mode === "prepare" ? await prepare(pool, currentIdentity)
          : mode === "stage" ? await stage(pool, currentIdentity)
            : mode === "status" ? await status(pool, currentIdentity)
              : await cleanup(pool, currentIdentity);
      } finally {
        await pool.end();
      }
    },
  });
  console.log(JSON.stringify(output, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await run();
}
