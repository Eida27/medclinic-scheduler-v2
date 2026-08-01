import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const FIXTURE_DIRECTORY = resolve(".data/browser-appointment-protection");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const COLLEGE_ID = "10000000-0000-4000-8000-000000000003";
const PROGRAM_ID = "20000000-0000-4000-8000-000000000003";
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const APPOINTMENT_PROTECTION_FIXTURE = {
  studentNumbers: ["B-APROT-LOCK", "B-APROT-DRAFT"],
  appointmentIds: [
    "ba150000-0000-4000-8000-000000000001",
    "ba150000-0000-4000-8000-000000000002",
    "ba150000-0000-4000-8000-000000000003",
    "ba150000-0000-4000-8000-000000000004",
  ],
  schedulePairIds: [
    "ba150000-0000-4000-8000-000000000101",
    "ba150000-0000-4000-8000-000000000102",
  ],
  originalDates: { laboratory: "2029-08-06", physicalExam: "2029-08-07" },
  inheritedReplacementDate: "2029-08-13",
  manualReplacementDates: { laboratory: "2029-08-20", physicalExam: "2029-08-21" },
  closureDates: ["2029-08-06", "2029-08-13"],
  closureReason: "APROT Browser acceptance closure",
  lockReason: "APROT Browser acceptance inherited lock",
  students: {
    lock: { studentNumber: "B-APROT-LOCK", dateOfBirth: "2004-08-04", middleName: "Maria Angela" },
    draft: { studentNumber: "B-APROT-DRAFT", dateOfBirth: "2004-08-05", middleName: "De la Cruz" },
  },
} as const;

export type AppointmentProtectionDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

export type AppointmentProtectionResidue = {
  students: number;
  appointments: number;
  submissions: number;
  files: number;
  manualCases: number;
  rescheduleEvents: number;
  closures: number;
  notifications: number;
  outbox: number;
  auditLogs: number;
  storageFiles: number;
  stateFiles: number;
};

type OwnedManifest = {
  studentNumbers: string[];
  appointmentIds: string[];
  submissionIds: string[];
  fileIds: string[];
  storageKeys: string[];
  manualCaseIds: string[];
  rescheduleEventIds: string[];
  closureGroupIds: string[];
  unavailableDateIds: string[];
  calendarRequestIds: string[];
  notificationIds: string[];
  outboxIds: string[];
  statusLogIds: string[];
  examResultIds: string[];
  laboratoryResultIds: string[];
  loginAttemptIds: string[];
  emailVerificationIds: string[];
  auditLogIds: string[];
};

type FixtureState = {
  databaseIdentity: AppointmentProtectionDatabaseIdentity;
  preparedAt: string;
  storageRoot: string;
  phase: "PREPARED" | "MANIFESTED" | "DATABASE_DELETED" | "STORAGE_DELETED";
  manifest: OwnedManifest;
};

type IdRow = { id: string };

export function normalizeAppointmentProtectionDatabaseIdentity(
  databaseUrl: string,
): AppointmentProtectionDatabaseIdentity {
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

export function assertSafeAppointmentProtectionAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveDatabase: string | undefined,
) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  const identity = normalizeAppointmentProtectionDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Appointment protection acceptance requires a PostgreSQL database on a loopback host.");
  }
  if (exclusiveDatabase !== "1") {
    throw new Error(
      "Set APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a local database dedicated to appointment protection acceptance.",
    );
  }
  return identity;
}

export function assertMatchingAppointmentProtectionDatabaseIdentity(
  current: AppointmentProtectionDatabaseIdentity,
  persisted: AppointmentProtectionDatabaseIdentity,
) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) {
    throw new Error("The current database identity does not match the prepared appointment protection fixture database.");
  }
}

export function assertAppointmentProtectionStorageTarget(storageRoot: string, storageKey: string) {
  const root = resolve(storageRoot);
  if (isAbsolute(storageKey) || storageKey.includes("..") || storageKey.includes("\\")) {
    throw new Error("Invalid appointment protection storage key.");
  }
  const target = resolve(root, storageKey);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("Invalid appointment protection storage key.");
  return target;
}

export function assertZeroAppointmentProtectionResidue<T extends AppointmentProtectionResidue>(residue: T) {
  if (Object.values(residue).some((count) => count !== 0)) {
    throw new Error(`Appointment protection acceptance cleanup residue remains: ${JSON.stringify(residue)}.`);
  }
  return residue;
}

function emptyManifest(): OwnedManifest {
  return {
    studentNumbers: [...APPOINTMENT_PROTECTION_FIXTURE.studentNumbers],
    appointmentIds: [...APPOINTMENT_PROTECTION_FIXTURE.appointmentIds],
    submissionIds: [], fileIds: [], storageKeys: [], manualCaseIds: [], rescheduleEventIds: [],
    closureGroupIds: [], unavailableDateIds: [], calendarRequestIds: [], notificationIds: [],
    outboxIds: [], statusLogIds: [], examResultIds: [], laboratoryResultIds: [], loginAttemptIds: [],
    emailVerificationIds: [], auditLogIds: [],
  };
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

function ids(rows: IdRow[]) {
  return rows.map((row) => row.id);
}

async function queryIds(client: PoolClient, sql: string, parameters: unknown[] = []) {
  return ids((await client.query<IdRow>(sql, parameters)).rows);
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

function identityPatterns(manifest: OwnedManifest) {
  return [
    ...manifest.studentNumbers,
    ...manifest.appointmentIds,
    ...manifest.submissionIds,
    ...manifest.fileIds,
    ...manifest.manualCaseIds,
    ...manifest.rescheduleEventIds,
    ...manifest.closureGroupIds,
    ...manifest.unavailableDateIds,
    ...manifest.calendarRequestIds,
  ].map((value) => `%${value}%`);
}

async function discoverOwnedManifest(client: PoolClient): Promise<OwnedManifest> {
  const studentNumbers = [...APPOINTMENT_PROTECTION_FIXTURE.studentNumbers];
  const appointmentIds = await queryIds(client,
    "SELECT id::text FROM appointments WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const submissionIds = await queryIds(client,
    "SELECT id::text FROM student_result_submissions WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const fileRows = await client.query<{ id: string; storageKey: string }>(
    `SELECT file.id::text AS id,file.storage_key AS "storageKey"
       FROM student_result_files file
      WHERE file.submission_id=ANY($1::uuid[]) ORDER BY file.id`,
    [submissionIds],
  );
  const closureGroupIds = await queryIds(client,
    "SELECT id::text FROM clinic_closure_groups WHERE reason=$1 ORDER BY id",
    [APPOINTMENT_PROTECTION_FIXTURE.closureReason]);
  const unavailableDateIds = await queryIds(client,
    "SELECT id::text FROM clinic_unavailable_dates WHERE closure_group_id=ANY($1::uuid[]) ORDER BY id",
    [closureGroupIds]);
  const manualCaseIds = await queryIds(client,
    "SELECT id::text FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const rescheduleEventIds = await queryIds(client,
    "SELECT id::text FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const calendarRequestIds = await queryIds(client,
    `SELECT request.request_id::text AS id
       FROM clinic_calendar_requests request
      WHERE request.batch_id=ANY(
        SELECT creation_batch_id FROM clinic_closure_groups WHERE id=ANY($1::uuid[])
        UNION SELECT reopening_batch_id FROM clinic_unavailable_dates
          WHERE closure_group_id=ANY($1::uuid[]) AND reopening_batch_id IS NOT NULL
      ) ORDER BY id`, [closureGroupIds]);
  const notificationIds = await queryIds(client,
    "SELECT id::text FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const outboxIds = await queryIds(client,
    "SELECT id::text FROM email_outbox WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const statusLogIds = await queryIds(client,
    "SELECT id::text FROM appointment_status_logs WHERE appointment_id=ANY($1::uuid[]) ORDER BY id", [appointmentIds]);
  const examResultIds = await queryIds(client,
    "SELECT id::text FROM exam_results WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const laboratoryResultIds = await queryIds(client,
    "SELECT id::text FROM laboratory_results WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const loginAttemptIds = await queryIds(client,
    "SELECT id::text FROM student_login_attempts WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const emailVerificationIds = await queryIds(client,
    "SELECT id::text FROM student_email_verifications WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const partial: OwnedManifest = {
    studentNumbers, appointmentIds, submissionIds,
    fileIds: fileRows.rows.map((row) => row.id),
    storageKeys: fileRows.rows.map((row) => row.storageKey),
    manualCaseIds, rescheduleEventIds, closureGroupIds, unavailableDateIds, calendarRequestIds,
    notificationIds, outboxIds, statusLogIds, examResultIds, laboratoryResultIds,
    loginAttemptIds, emailVerificationIds, auditLogIds: [],
  };
  partial.auditLogIds = await queryIds(client,
    `SELECT id::text FROM audit_logs
      WHERE entity_id=ANY($1::text[])
         OR metadata->>'studentNumber'=ANY($2::text[])
         OR metadata::text LIKE ANY($3::text[])
      ORDER BY id`,
    [[...appointmentIds, ...submissionIds, ...partial.fileIds, ...manualCaseIds,
      ...rescheduleEventIds, ...closureGroupIds, ...unavailableDateIds, ...calendarRequestIds],
    studentNumbers, identityPatterns(partial)],
  );
  return partial;
}

async function databaseResidue(client: PoolClient, manifest: OwnedManifest) {
  const result = await client.query<Omit<AppointmentProtectionResidue, "storageFiles" | "stateFiles">>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])) AS appointments,
       (SELECT COUNT(*)::int FROM student_result_submissions WHERE student_number=ANY($1::varchar[]) OR id=ANY($3::uuid[])) AS submissions,
       (SELECT COUNT(*)::int FROM student_result_files WHERE id=ANY($4::uuid[])) AS files,
       (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[]) OR id=ANY($5::uuid[])) AS "manualCases",
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[]) OR id=ANY($6::uuid[])) AS "rescheduleEvents",
       (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE reason=$7 OR id=ANY($8::uuid[])) AS closures,
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) OR id=ANY($9::uuid[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=ANY($1::varchar[]) OR id=ANY($10::uuid[])) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs WHERE id=ANY($11::uuid[]) OR metadata->>'studentNumber'=ANY($1::text[]) OR metadata::text LIKE ANY($12::text[])) AS "auditLogs"`,
    [manifest.studentNumbers, manifest.appointmentIds, manifest.submissionIds, manifest.fileIds,
      manifest.manualCaseIds, manifest.rescheduleEventIds, APPOINTMENT_PROTECTION_FIXTURE.closureReason,
      manifest.closureGroupIds, manifest.notificationIds, manifest.outboxIds, manifest.auditLogIds,
      identityPatterns(manifest)],
  );
  return result.rows[0];
}

async function residue(client: PoolClient, manifest: OwnedManifest): Promise<AppointmentProtectionResidue> {
  const database = await databaseResidue(client, manifest);
  const storageTargets = manifest.storageKeys.map((key) => assertAppointmentProtectionStorageTarget(STORAGE_ROOT, key));
  return {
    ...database,
    storageFiles: (await Promise.all(storageTargets.map(fileExists))).filter(Boolean).length,
    stateFiles: await fileExists(STATE_FILE) ? 1 : 0,
  };
}

async function assertReferences(client: PoolClient) {
  const result = await client.query<{ users: number; clinics: number; references: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=$1) AS users,
       (SELECT COUNT(*)::int FROM clinics WHERE id=ANY($2::uuid[])) AS clinics,
       (SELECT COUNT(*)::int FROM programs WHERE id=$3 AND college_id=$4) AS references`,
    [ADMIN_USER_ID, [LABORATORY_CLINIC_ID, PHYSICAL_EXAM_CLINIC_ID], PROGRAM_ID, COLLEGE_ID],
  );
  if (result.rows[0].users !== 1 || result.rows[0].clinics !== 2 || result.rows[0].references !== 1) {
    throw new Error(`Required seeded admin, clinics, or CPU reference rows are missing: ${JSON.stringify(result.rows[0])}.`);
  }
}

async function prepare(pool: Pool, databaseIdentity: AppointmentProtectionDatabaseIdentity) {
  if (await readState()) throw new Error("An appointment protection fixture state already exists. Run cleanup first.");
  const client = await pool.connect();
  try {
    await assertReferences(client);
    const initial = await databaseResidue(client, emptyManifest());
    const blocked = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM clinic_unavailable_dates
        WHERE reopened_at IS NULL AND blocked_date=ANY($1::date[])`,
      [APPOINTMENT_PROTECTION_FIXTURE.closureDates],
    );
    if (Object.values(initial).some((count) => count !== 0) || blocked.rows[0].count !== 0) {
      throw new Error(`Refusing to overwrite untracked fixture residue: ${JSON.stringify({ ...initial, blockedDates: blocked.rows[0].count })}.`);
    }
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO students (
           student_number,first_name,middle_name,last_name,college_id,program_id,year_level,
           date_of_birth,email,email_verified_at,is_active
         ) VALUES
           ($1,'Lock','Maria Angela','Browser',$3,$4,4,'2004-08-04','aprot-lock@example.test',NOW(),TRUE),
           ($2,'Draft','De la Cruz','Browser',$3,$4,4,'2004-08-05','aprot-draft@example.test',NOW(),TRUE)`,
        [APPOINTMENT_PROTECTION_FIXTURE.students.lock.studentNumber,
          APPOINTMENT_PROTECTION_FIXTURE.students.draft.studentNumber, COLLEGE_ID, PROGRAM_ID],
      );
      await client.query(
        `INSERT INTO appointments (
           id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_pair_id,schedule_cycle_start,created_by,updated_by
         ) VALUES
           ($1,$5,$8,'LABORATORY',$12,'PENDING',TRUE,$10,2029,$7,$7),
           ($2,$6,$8,'PHYSICAL_EXAM',$13,'PENDING',TRUE,$10,2029,$7,$7),
           ($3,$5,$9,'LABORATORY',$12,'COMPLETED',TRUE,$11,2029,$7,$7),
           ($4,$6,$9,'PHYSICAL_EXAM',$13,'PENDING',TRUE,$11,2029,$7,$7)`,
        [...APPOINTMENT_PROTECTION_FIXTURE.appointmentIds, LABORATORY_CLINIC_ID,
          PHYSICAL_EXAM_CLINIC_ID, ADMIN_USER_ID,
          ...APPOINTMENT_PROTECTION_FIXTURE.studentNumbers,
          ...APPOINTMENT_PROTECTION_FIXTURE.schedulePairIds,
          APPOINTMENT_PROTECTION_FIXTURE.originalDates.laboratory,
          APPOINTMENT_PROTECTION_FIXTURE.originalDates.physicalExam],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const state: FixtureState = {
      databaseIdentity,
      preparedAt: new Date().toISOString(),
      storageRoot: STORAGE_ROOT,
      phase: "PREPARED",
      manifest: emptyManifest(),
    };
    await writeState(state);
    return {
      mode: "prepare", databaseIdentity, stateFile: STATE_FILE, storageRoot: STORAGE_ROOT,
      fixture: APPOINTMENT_PROTECTION_FIXTURE,
    };
  } finally {
    client.release();
  }
}

async function status(pool: Pool, databaseIdentity: AppointmentProtectionDatabaseIdentity) {
  const state = await readState();
  if (!state) throw new Error("Prepare the appointment protection fixture first.");
  assertMatchingAppointmentProtectionDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) throw new Error("RESULT_UPLOAD_ROOT does not match the prepared fixture storage root.");
  const client = await pool.connect();
  try {
    const manifest = state.phase === "PREPARED" ? await discoverOwnedManifest(client) : state.manifest;
    const appointments = await client.query(
      `SELECT id::text,student_number,schedule_type,appointment_date::text,status,is_published,
              rescheduled_from::text,is_manually_locked,lock_reason,locked_by::text,updated_at
         FROM appointments WHERE student_number=ANY($1::varchar[])
        ORDER BY student_number,created_at,id`,
      [manifest.studentNumbers],
    );
    const cases = await client.query(
      `SELECT id::text,student_number,status,reason_code,resolution_action,optimistic_token::text
         FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[]) ORDER BY created_at,id`,
      [manifest.studentNumbers],
    );
    return {
      mode: "status", databaseIdentity, phase: state.phase,
      credentials: APPOINTMENT_PROTECTION_FIXTURE.students,
      fixture: APPOINTMENT_PROTECTION_FIXTURE,
      manifest,
      appointments: appointments.rows,
      manualCases: cases.rows,
      residue: await residue(client, manifest),
    };
  } finally {
    client.release();
  }
}

async function deleteOwnedDatabaseRows(client: PoolClient, manifest: OwnedManifest) {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM audit_logs WHERE id=ANY($1::uuid[])", [manifest.auditLogIds]);
    await client.query("DELETE FROM student_portal_notifications WHERE id=ANY($1::uuid[])", [manifest.notificationIds]);
    await client.query("DELETE FROM email_outbox WHERE id=ANY($1::uuid[])", [manifest.outboxIds]);
    await client.query("DELETE FROM student_email_verifications WHERE id=ANY($1::uuid[])", [manifest.emailVerificationIds]);
    await client.query("DELETE FROM student_login_attempts WHERE id=ANY($1::uuid[])", [manifest.loginAttemptIds]);
    await client.query(
      "DELETE FROM appointment_reschedule_event_unavailable_dates WHERE event_id=ANY($1::uuid[])",
      [manifest.rescheduleEventIds],
    );
    await client.query("DELETE FROM appointment_reschedule_events WHERE id=ANY($1::uuid[])", [manifest.rescheduleEventIds]);
    await client.query("DELETE FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])", [manifest.manualCaseIds]);
    await client.query("DELETE FROM student_result_files WHERE id=ANY($1::uuid[])", [manifest.fileIds]);
    await client.query("DELETE FROM student_result_submissions WHERE id=ANY($1::uuid[])", [manifest.submissionIds]);
    await client.query("DELETE FROM exam_results WHERE id=ANY($1::uuid[])", [manifest.examResultIds]);
    await client.query("DELETE FROM laboratory_results WHERE id=ANY($1::uuid[])", [manifest.laboratoryResultIds]);
    await client.query("DELETE FROM appointment_status_logs WHERE id=ANY($1::uuid[])", [manifest.statusLogIds]);
    await client.query("DELETE FROM appointments WHERE id=ANY($1::uuid[])", [manifest.appointmentIds]);
    await client.query("DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])", [manifest.calendarRequestIds]);
    await client.query("DELETE FROM clinic_unavailable_dates WHERE id=ANY($1::uuid[])", [manifest.unavailableDateIds]);
    await client.query("DELETE FROM clinic_closure_groups WHERE id=ANY($1::uuid[])", [manifest.closureGroupIds]);
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [manifest.studentNumbers]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function deleteOwnedStorage(manifest: OwnedManifest) {
  for (const key of manifest.storageKeys) {
    await rm(assertAppointmentProtectionStorageTarget(STORAGE_ROOT, key), { force: true });
  }
  for (const submissionId of manifest.submissionIds) {
    const sentinel = assertAppointmentProtectionStorageTarget(STORAGE_ROOT, `${submissionId}/sentinel`);
    await rm(dirname(sentinel), { recursive: true, force: true });
  }
}

async function cleanup(pool: Pool, databaseIdentity: AppointmentProtectionDatabaseIdentity) {
  let state = await readState();
  if (!state) throw new Error("Prepare the appointment protection fixture before cleanup.");
  assertMatchingAppointmentProtectionDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) throw new Error("RESULT_UPLOAD_ROOT does not match the prepared fixture storage root.");
  const client = await pool.connect();
  try {
    if (state.phase === "PREPARED") {
      state = { ...state, phase: "MANIFESTED", manifest: await discoverOwnedManifest(client) };
      await writeState(state);
    }
    if (state.phase === "MANIFESTED") {
      await deleteOwnedDatabaseRows(client, state.manifest);
      state = { ...state, phase: "DATABASE_DELETED" };
      await writeState(state);
    }
    if (state.phase === "DATABASE_DELETED") {
      await deleteOwnedStorage(state.manifest);
      state = { ...state, phase: "STORAGE_DELETED" };
      await writeState(state);
    }
    const proofBeforeStateRemoval = await residue(client, state.manifest);
    if (proofBeforeStateRemoval.stateFiles !== 1) {
      throw new Error("The exact appointment protection fixture state file is missing before final proof.");
    }
    assertZeroAppointmentProtectionResidue({ ...proofBeforeStateRemoval, stateFiles: 0 });
    await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
    const proof = assertZeroAppointmentProtectionResidue(await residue(client, state.manifest));
    return { mode: "cleanup", databaseIdentity, phase: "CLEAN", manifest: state.manifest, residue: proof };
  } finally {
    client.release();
  }
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["prepare", "status", "cleanup"].includes(mode)) {
    throw new Error(
      "Use prepare, status, or cleanup with a loopback DATABASE_URL and APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE=1.",
    );
  }
  const databaseIdentity = assertSafeAppointmentProtectionAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env.APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE,
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
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) await run();
