import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  parseStudentImportCsv,
  STUDENT_IMPORT_HEADERS,
  type ImportedStudentRow,
} from "../src/server/services/student-import-csv";

export const APPROVED_CSV_PATH =
  "C:\\endless_refinement\\microsoft_docs\\Physical_Laboratory_Scheduling_Completed.csv";
export const EXPECTED_APPROVED_ROWS = 280;

const FIXTURE_DIRECTORY = resolve(".data/browser-clinic-scheduler-ux");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const RESULT_STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";

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
type FixtureState = {
  version: 1;
  runId: string;
  phase: "PREPARING" | "PREPARED" | "IMPORTED" | "STAGED";
  startedAt: string;
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
  };
};

type ApprovedCsvInspection = {
  bomHex: string;
  acceptedRows: number;
  studentNumbers: string[];
  rows: ImportedStudentRow[];
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
  expectedRows = EXPECTED_APPROVED_ROWS,
): ApprovedCsvInspection {
  const bomHex = Buffer.from(bytes.subarray(0, 3)).toString("hex");
  if (bomHex !== "efbbbf") {
    throw new Error(`Approved CSV must begin with the UTF-8 BOM EF BB BF; found ${bomHex || "no bytes"}.`);
  }
  const rows = parseStudentImportCsv(bytes);
  if (rows.length !== expectedRows) {
    throw new Error(`Approved CSV must contain exactly ${expectedRows} accepted rows; parsed ${rows.length}.`);
  }
  return {
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
      row.middleInitial,
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
    closures: await idRows(client, "SELECT id::text AS id FROM clinic_unavailable_dates"),
    audits: await idRows(client, "SELECT id::text AS id FROM audit_logs"),
  };
}

async function prepare(pool: Pool) {
  if (await readState()) {
    throw new Error(`Fixture state already exists at ${STATE_FILE}. Run cleanup before preparing another acceptance run.`);
  }
  const sourceBytes = await readFile(APPROVED_CSV_PATH);
  const inspection = inspectApprovedCsv(sourceBytes);
  const variant = createWindows1252Variant(sourceBytes);
  const runId = randomUUID();
  const filename = `BROWSER-UX-${runId}-Physical_Laboratory_Scheduling_Completed-windows1252.csv`;
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
      version: 1,
      runId,
      phase: "PREPARING",
      startedAt: new Date().toISOString(),
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
      file: state.temporaryCsv.path,
      studentCategory: "Regular",
      academicYear: "Use the current academic year shown by the form",
    },
  };
}

async function captureImport(client: PoolClient, state: FixtureState) {
  const importIds = await idRows(
    client,
    `SELECT id::text AS id FROM schedule_import_groups
      WHERE source_filename=$1 AND created_at >= $2::timestamptz ORDER BY created_at`,
    [state.temporaryCsv.filename, state.startedAt],
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

async function findEmptyFutureWeekday(client: PoolClient) {
  const result = await client.query<{ date: string }>(
    `SELECT candidate::date::text AS date
       FROM generate_series($1::date, $2::date, interval '1 day') candidate
      WHERE EXTRACT(ISODOW FROM candidate) BETWEEN 1 AND 5
        AND NOT EXISTS (
          SELECT 1 FROM clinic_unavailable_dates unavailable
           WHERE unavailable.clinic_id=$3 AND candidate::date BETWEEN unavailable.start_date AND unavailable.end_date
        )
        AND NOT EXISTS (
          SELECT 1 FROM appointments appointment
           WHERE appointment.clinic_id=$3 AND appointment.appointment_date=candidate::date
             AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
        )
      ORDER BY candidate LIMIT 1`,
    [manilaDate(1), manilaDate(62), LABORATORY_CLINIC_ID],
  );
  if (!result.rows[0]) throw new Error("No empty future Laboratory weekday is available in the next 62 days.");
  return result.rows[0].date;
}

async function stage(pool: Pool) {
  const state = await readState();
  if (!state) throw new Error(`No fixture state exists at ${STATE_FILE}. Run prepare first.`);
  if (state.phase === "STAGED") throw new Error("Fixture states are already staged; use status or cleanup.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imported = await captureImport(client, state);
    if (imported.importIds.length !== 1) {
      throw new Error(`Expected one UI import for ${state.temporaryCsv.filename}; found ${imported.importIds.length}.`);
    }
    const importRow = await client.query<{ totalRows: number }>(
      `SELECT total_rows AS "totalRows" FROM schedule_import_groups WHERE id=$1 FOR UPDATE`,
      [imported.importIds[0]],
    );
    if (importRow.rows[0]?.totalRows !== EXPECTED_APPROVED_ROWS) {
      throw new Error(`Expected imported row count ${EXPECTED_APPROVED_ROWS}; found ${importRow.rows[0]?.totalRows ?? "none"}.`);
    }
    const pairs = await client.query<{
      studentNumber: string;
      laboratoryId: string;
      laboratoryDate: string;
      physicalId: string;
      physicalDate: string;
    }>(
      `SELECT appointment.student_number AS "studentNumber",
              MAX(appointment.id::text) FILTER (WHERE appointment.schedule_type='LABORATORY') AS "laboratoryId",
              MAX(appointment.appointment_date::text) FILTER (WHERE appointment.schedule_type='LABORATORY') AS "laboratoryDate",
              MAX(appointment.id::text) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM') AS "physicalId",
              MAX(appointment.appointment_date::text) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM') AS "physicalDate"
         FROM appointments appointment
        WHERE appointment.batch_id=ANY($1::uuid[]) AND appointment.status='PENDING' AND appointment.is_published=TRUE
        GROUP BY appointment.student_number
       HAVING COUNT(*) FILTER (WHERE appointment.schedule_type='LABORATORY')=1
          AND COUNT(*) FILTER (WHERE appointment.schedule_type='PHYSICAL_EXAM')=1
        ORDER BY appointment.student_number
        LIMIT 4`,
      [imported.batchIds],
    );
    if (pairs.rows.length < 4) throw new Error(`Expected at least four published appointment pairs; found ${pairs.rows.length}.`);
    const [correction, complete, mixed, clinicContext] = pairs.rows;
    const appointmentIds = [
      correction.laboratoryId,
      complete.laboratoryId,
      complete.physicalId,
      mixed.laboratoryId,
      mixed.physicalId,
    ];
    await client.query("SELECT id FROM appointments WHERE id=ANY($1::uuid[]) FOR UPDATE", [appointmentIds]);
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
    const successCalendarDate = await findEmptyFutureWeekday(client);
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
      failureCalendarDate: complete.laboratoryDate,
    };
    await client.query("COMMIT");
    await writeState(state);
    return {
      mode: "stage",
      statePath: STATE_FILE,
      phase: state.phase,
      import: importSummary(state.imported!),
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

async function status(pool: Pool) {
  const state = await readState();
  if (!state) {
    return { mode: "status", statePath: STATE_FILE, phase: "ABSENT" };
  }
  const client = await pool.connect();
  try {
    const imported = await captureImport(client, state);
    const capacities = await client.query<CapacityBaseline>(
      `SELECT id::text, safe_daily_capacity AS "safeDailyCapacity", max_daily_capacity AS "maxDailyCapacity"
         FROM clinic_capacity_settings ORDER BY id`,
    );
    const closures = await idRows(
      client,
      "SELECT id::text AS id FROM clinic_unavailable_dates WHERE reason=$1 AND created_at >= $2::timestamptz ORDER BY id",
      [state.fixtureReason, state.startedAt],
    );
    await writeState(state);
    return {
      mode: "status",
      statePath: STATE_FILE,
      phase: state.phase,
      source: state.source,
      temporaryCsv: state.temporaryCsv,
      preExistingMatchingStudents: state.preExistingStudents.length,
      imported: importSummary(imported),
      peñaStudent: await peñaStudent(client, state),
      staged: state.staged,
      fixtureClosures: closures,
      capacities: capacities.rows,
      fixtureReason: state.fixtureReason,
    };
  } finally {
    client.release();
  }
}

type OwnedIds = {
  imports: string[];
  batches: string[];
  appointments: string[];
  coordinatorItems: string[];
  closures: string[];
  submissions: string[];
  resultFiles: Array<{ id: string; storageKey: string }>;
  laboratoryResults: string[];
  examResults: string[];
  statusLogs: string[];
  audits: string[];
  notifications: string[];
  events: string[];
  createdStudents: string[];
};

async function collectOwnedIds(client: PoolClient, state: FixtureState): Promise<OwnedIds> {
  const imports = await idRows(
    client,
    "SELECT id::text AS id FROM schedule_import_groups WHERE source_filename=$1 AND created_at >= $2::timestamptz",
    [state.temporaryCsv.filename, state.startedAt],
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
      "SELECT id::text AS id FROM clinic_unavailable_dates WHERE reason=$1 AND created_at >= $2::timestamptz",
      [state.fixtureReason, state.startedAt],
    ),
    state.baseline.ids.closures,
  );
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
           OR clinic_unavailable_date_id=ANY($2::uuid[])
           OR old_laboratory_appointment_id=ANY($3::uuid[])
           OR new_laboratory_appointment_id=ANY($3::uuid[])
           OR old_physical_exam_appointment_id=ANY($3::uuid[])
           OR new_physical_exam_appointment_id=ANY($3::uuid[])`,
      [imports, closures, appointments],
    )
    : [];
  const notifications = closures.length
    ? await idRows(
      client,
      "SELECT id::text AS id FROM student_portal_notifications WHERE metadata->>'clinicUnavailableDateId'=ANY($1::text[])",
      [closures],
    )
    : [];
  const auditCandidates = (imports.length || batches.length || appointments.length || closures.length)
    ? await idRows(
      client,
      `SELECT id::text AS id FROM audit_logs
        WHERE (entity_type='schedule_import_group' AND entity_id=ANY($1::text[]))
           OR (entity_type='schedule_batch' AND entity_id=ANY($2::text[]))
           OR (entity_type='appointment' AND entity_id=ANY($3::text[]))
           OR (entity_type='clinic_unavailable_date' AND entity_id=ANY($4::text[]))
           OR metadata->>'importId'=ANY($1::text[])
           OR metadata->>'batchId'=ANY($2::text[])
           OR metadata->>'replacementId'=ANY($3::text[])
           OR metadata->>'clinicUnavailableDateId'=ANY($4::text[])`,
      [imports, batches, appointments, closures],
    )
    : [];
  const preExisting = new Set(state.preExistingStudents.map((student) => String(student.student_number)));
  const createdStudents = (await client.query<{ student_number: string }>(
    "SELECT student_number FROM students WHERE student_number=ANY($1::varchar[])",
    [state.studentNumbers],
  )).rows.map((row) => row.student_number).filter((studentNumber) => !preExisting.has(studentNumber));
  return {
    imports,
    batches,
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
    notifications: differenceIds(notifications, state.baseline.ids.notifications),
    events: differenceIds(events, state.baseline.ids.rescheduleEvents),
    createdStudents,
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

export function resultStorageDirectories(files: OwnedIds["resultFiles"]) {
  return [...new Set(files.map((file) => file.storageKey.split("/")[0]).filter(Boolean))];
}

async function removePrivateFiles(files: OwnedIds["resultFiles"]) {
  const directories = resultStorageDirectories(files);
  for (const directory of directories) {
    const target = resolve(RESULT_STORAGE_ROOT, directory);
    if (!target.startsWith(`${RESULT_STORAGE_ROOT}${sep}`)) {
      throw new Error(`Refusing to remove result storage outside ${RESULT_STORAGE_ROOT}: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

async function cleanup(pool: Pool) {
  const state = await readState();
  if (!state) {
    return { mode: "cleanup", statePath: STATE_FILE, phase: "ABSENT", message: "No fixture state exists." };
  }
  const client = await pool.connect();
  let owned: OwnedIds;
  try {
    await client.query("BEGIN");
    owned = await collectOwnedIds(client, state);
    await deleteByIds(client, "audit_logs", owned.audits);
    await deleteByIds(client, "student_portal_notifications", owned.notifications);
    await deleteByIds(client, "appointment_reschedule_events", owned.events);
    await deleteByIds(client, "student_result_files", owned.resultFiles.map((file) => file.id));
    await deleteByIds(client, "student_result_submissions", owned.submissions);
    await deleteByIds(client, "exam_results", owned.examResults);
    await deleteByIds(client, "laboratory_results", owned.laboratoryResults);
    await deleteByIds(client, "appointment_status_logs", owned.statusLogs);
    await deleteByIds(client, "appointments", owned.appointments);
    await deleteByIds(client, "coordinator_schedule_items", owned.coordinatorItems);
    await deleteByIds(client, "schedule_batches", owned.batches);
    await deleteByIds(client, "schedule_import_groups", owned.imports);
    await deleteByIds(client, "clinic_unavailable_dates", owned.closures);
    await restoreStudents(client, state.preExistingStudents);
    if (owned.createdStudents.length) {
      await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [owned.createdStudents]);
    }
    await restorePrograms(client, state.referencePrograms.preExisting);
    if (state.referencePrograms.temporary.length) {
      await client.query(
        "DELETE FROM programs WHERE id=ANY($1::uuid[])",
        [state.referencePrograms.temporary.map((program) => program.id)],
      );
    }
    for (const capacity of state.baseline.capacities) {
      await client.query(
        `UPDATE clinic_capacity_settings
            SET safe_daily_capacity=$2, max_daily_capacity=$3
          WHERE id=$1`,
        [capacity.id, capacity.safeDailyCapacity, capacity.maxDailyCapacity],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await removePrivateFiles(owned!.resultFiles);

  const proofClient = await pool.connect();
  try {
    const residue = await collectOwnedIds(proofClient, state);
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
    const proof = {
      imports: residue.imports.length,
      students: residue.createdStudents.length,
      appointments: residue.appointments.length,
      closures: residue.closures.length,
      submissions: residue.submissions.length,
      audits: residue.audits.length,
      notifications: residue.notifications.length,
      events: residue.events.length,
      referencePrograms: Number((await proofClient.query(
        "SELECT COUNT(*)::int AS count FROM programs WHERE id=ANY($1::uuid[])",
        [state.referencePrograms.temporary.map((program) => program.id)],
      )).rows[0].count),
    };
    if (Object.values(proof).some((count) => count !== 0)) {
      throw new Error(`Fixture cleanup residue remains: ${JSON.stringify(proof)}. State retained at ${STATE_FILE}.`);
    }
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
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (normally loaded from .env.local). ");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const output = mode === "prepare" ? await prepare(pool)
      : mode === "stage" ? await stage(pool)
        : mode === "status" ? await status(pool)
          : mode === "cleanup" ? await cleanup(pool)
            : null;
    if (!output) throw new Error("Use prepare, stage, status, or cleanup.");
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await run();
}
