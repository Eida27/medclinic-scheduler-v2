import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const FIXTURE_VERSION = 1;
const FIXTURE_MARKER = "BROWSER-STUDENT-RESULT-EDITING-V1";
const FIXTURE_DIRECTORY = resolve(".data/browser-student-result-editing");
const ARTIFACT_DIRECTORY = resolve(FIXTURE_DIRECTORY, "chooser-artifacts");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const STATE_TEMP_FILE = resolve(FIXTURE_DIRECTORY, "state.json.tmp");
const STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const COLLEGE_ID = "10000000-0000-4000-8000-000000000003";
const PROGRAM_ID = "20000000-0000-4000-8000-000000000003";
const SETUP_AUDIT_ID = "be180000-0000-4000-8000-000000000301";

const PDF_BYTES = Buffer.from("%PDF-1.7\nSynthetic student result editing Browser fixture.\n", "utf8");
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]);
const TXT_BYTES = Buffer.from("This invalid chooser artifact must be rejected by the UI.\n", "utf8");

const INITIAL_STORAGE_KEYS = {
  laboratory: "be180000-0000-4000-8000-000000000101/be180000-0000-4000-8000-000000000201.pdf",
  physicalExam: "be180000-0000-4000-8000-000000000102/be180000-0000-4000-8000-000000000202.jpg",
} as const;

const CHOOSER_ARTIFACTS = {
  pdf: resolve(ARTIFACT_DIRECTORY, "valid-laboratory-result.pdf"),
  png: resolve(ARTIFACT_DIRECTORY, "valid-laboratory-result.png"),
  jpeg: resolve(ARTIFACT_DIRECTORY, "valid-physical-exam-result.jpeg"),
  invalidText: resolve(ARTIFACT_DIRECTORY, "invalid-result.txt"),
} as const;

export const STUDENT_RESULT_EDITING_FIXTURE = {
  version: FIXTURE_VERSION,
  marker: FIXTURE_MARKER,
  adminUserId: ADMIN_USER_ID,
  student: {
    studentNumber: "B-SR-EDIT-01",
    firstName: "Editing",
    middleName: "Maria Angela",
    lastName: "Browser",
    dateOfBirth: "2004-08-06",
  },
  login: {
    student: {
      studentNumber: "B-SR-EDIT-01",
      dateOfBirth: "2004-08-06",
      middleName: "Maria Angela",
    },
    admin: {
      email: "admin@medclinic.local",
      password: "Admin123!",
    },
  },
  appointmentIds: {
    laboratory: "be180000-0000-4000-8000-000000000001",
    physicalExam: "be180000-0000-4000-8000-000000000002",
  },
  submissionIds: {
    laboratoryDraft: "be180000-0000-4000-8000-000000000101",
    physicalExamOfficial: "be180000-0000-4000-8000-000000000102",
  },
  initialFileIds: {
    laboratory: "be180000-0000-4000-8000-000000000201",
    physicalExam: "be180000-0000-4000-8000-000000000202",
  },
  initialStorageKeys: INITIAL_STORAGE_KEYS,
  chooserArtifacts: CHOOSER_ARTIFACTS,
  appointmentDates: {
    laboratory: "2026-08-03",
    physicalExam: "2026-08-04",
  },
  administratorReplacementReason: "Browser acceptance administrator replacement reason",
  approvedConflictMessage: "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.",
} as const;

export type StudentResultEditingFixtureMode = "prepare" | "status" | "cleanup";

export type StudentResultEditingDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

export type StudentResultEditingResidue = {
  students: number;
  appointments: number;
  submissions: number;
  files: number;
  legacyExamResults: number;
  legacyLaboratoryResults: number;
  appointmentStatusLogs: number;
  storageCleanupIntents: number;
  notifications: number;
  outbox: number;
  auditLogs: number;
  loginAttempts: number;
  emailVerifications: number;
  storageObjects: number;
  chooserArtifacts: number;
  stateFiles: number;
};

type FixturePhase =
  | "INITIALIZED"
  | "DATABASE_PREPARED"
  | "STORAGE_PREPARED"
  | "PREPARED"
  | "MANIFESTED"
  | "DATABASE_DELETED"
  | "STORAGE_DELETED"
  | "ARTIFACTS_DELETED";

type OwnedManifest = {
  studentNumbers: string[];
  appointmentIds: string[];
  submissionIds: string[];
  fileIds: string[];
  storageKeys: string[];
  legacyExamResultIds: string[];
  legacyLaboratoryResultIds: string[];
  appointmentStatusLogIds: string[];
  storageCleanupKeys: string[];
  notificationIds: string[];
  outboxIds: string[];
  auditLogIds: string[];
  loginAttemptIds: string[];
  emailVerificationIds: string[];
};

type FixtureManifest = {
  marker: string;
  login: typeof STUDENT_RESULT_EDITING_FIXTURE.login;
  appointmentIds: typeof STUDENT_RESULT_EDITING_FIXTURE.appointmentIds;
  initialSubmissionIds: typeof STUDENT_RESULT_EDITING_FIXTURE.submissionIds;
  initialFileIds: typeof STUDENT_RESULT_EDITING_FIXTURE.initialFileIds;
  chooserArtifacts: typeof CHOOSER_ARTIFACTS;
  owned: OwnedManifest;
};

type FixtureState = {
  version: number;
  marker: string;
  databaseIdentity: StudentResultEditingDatabaseIdentity;
  storageRoot: string;
  phase: FixturePhase;
  initializedAt: string;
  preparedAt: string | null;
  manifest: FixtureManifest;
};

type StateReadResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; value: FixtureState };

export type StudentResultEditingCleanupDependencies = {
  removeStorageObject?: (target: string) => Promise<void>;
};

type IdRow = { id: string };

function checksum(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function emptyOwnedManifest(): OwnedManifest {
  return {
    studentNumbers: [STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber],
    appointmentIds: Object.values(STUDENT_RESULT_EDITING_FIXTURE.appointmentIds),
    submissionIds: Object.values(STUDENT_RESULT_EDITING_FIXTURE.submissionIds),
    fileIds: Object.values(STUDENT_RESULT_EDITING_FIXTURE.initialFileIds),
    storageKeys: Object.values(STUDENT_RESULT_EDITING_FIXTURE.initialStorageKeys),
    legacyExamResultIds: [],
    legacyLaboratoryResultIds: [],
    appointmentStatusLogIds: [],
    storageCleanupKeys: [],
    notificationIds: [],
    outboxIds: [],
    auditLogIds: [SETUP_AUDIT_ID],
    loginAttemptIds: [],
    emailVerificationIds: [],
  };
}

function fixtureManifest(): FixtureManifest {
  return {
    marker: FIXTURE_MARKER,
    login: STUDENT_RESULT_EDITING_FIXTURE.login,
    appointmentIds: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds,
    initialSubmissionIds: STUDENT_RESULT_EDITING_FIXTURE.submissionIds,
    initialFileIds: STUDENT_RESULT_EDITING_FIXTURE.initialFileIds,
    chooserArtifacts: CHOOSER_ARTIFACTS,
    owned: emptyOwnedManifest(),
  };
}

function mergeOwnedManifests(...manifests: OwnedManifest[]): OwnedManifest {
  return {
    studentNumbers: unique(manifests.flatMap((manifest) => manifest.studentNumbers)),
    appointmentIds: unique(manifests.flatMap((manifest) => manifest.appointmentIds)),
    submissionIds: unique(manifests.flatMap((manifest) => manifest.submissionIds)),
    fileIds: unique(manifests.flatMap((manifest) => manifest.fileIds)),
    storageKeys: unique(manifests.flatMap((manifest) => manifest.storageKeys)),
    legacyExamResultIds: unique(manifests.flatMap((manifest) => manifest.legacyExamResultIds)),
    legacyLaboratoryResultIds: unique(manifests.flatMap((manifest) => manifest.legacyLaboratoryResultIds)),
    appointmentStatusLogIds: unique(manifests.flatMap((manifest) => manifest.appointmentStatusLogIds)),
    storageCleanupKeys: unique(manifests.flatMap((manifest) => manifest.storageCleanupKeys)),
    notificationIds: unique(manifests.flatMap((manifest) => manifest.notificationIds)),
    outboxIds: unique(manifests.flatMap((manifest) => manifest.outboxIds)),
    auditLogIds: unique(manifests.flatMap((manifest) => manifest.auditLogIds)),
    loginAttemptIds: unique(manifests.flatMap((manifest) => manifest.loginAttemptIds)),
    emailVerificationIds: unique(manifests.flatMap((manifest) => manifest.emailVerificationIds)),
  };
}

export function normalizeStudentResultEditingDatabaseIdentity(
  databaseUrl: string,
): StudentResultEditingDatabaseIdentity {
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

export function assertSafeStudentResultEditingAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveDatabase: string | undefined,
  mode: StudentResultEditingFixtureMode,
) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  const identity = normalizeStudentResultEditingDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Student result editing acceptance requires a PostgreSQL database on a loopback host.");
  }
  if (mode !== "status" && exclusiveDatabase !== "1") {
    throw new Error(
      "Set STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a local database dedicated to student result editing acceptance.",
    );
  }
  return identity;
}

export function assertMatchingStudentResultEditingDatabaseIdentity(
  current: StudentResultEditingDatabaseIdentity,
  persisted: StudentResultEditingDatabaseIdentity,
) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) {
    throw new Error("The current database identity does not match the prepared student result editing fixture database.");
  }
}

export function assertStudentResultEditingStorageTarget(storageRoot: string, storageKey: string) {
  const root = resolve(storageRoot);
  if (isAbsolute(storageKey) || storageKey.includes("..") || storageKey.includes("\\")) {
    throw new Error("Invalid student result editing storage key.");
  }
  const target = resolve(root, storageKey);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("Invalid student result editing storage key.");
  }
  return target;
}

function assertChooserArtifactTarget(path: string) {
  const target = resolve(path);
  if (!target.startsWith(`${ARTIFACT_DIRECTORY}${sep}`)) {
    throw new Error("Invalid student result editing chooser artifact path.");
  }
  return target;
}

export function assertZeroStudentResultEditingResidue<T extends StudentResultEditingResidue>(residue: T) {
  if (Object.values(residue).some((count) => count !== 0)) {
    throw new Error(`Student result editing acceptance cleanup residue remains: ${JSON.stringify(residue)}.`);
  }
  return residue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseFixtureState(value: unknown): FixtureState {
  if (!isRecord(value)
    || value.version !== FIXTURE_VERSION
    || value.marker !== FIXTURE_MARKER
    || typeof value.storageRoot !== "string"
    || !isIsoTimestamp(value.initializedAt)
    || (value.preparedAt !== null && !isIsoTimestamp(value.preparedAt))
    || !isRecord(value.databaseIdentity)
    || !isRecord(value.manifest)) {
    throw new Error("Student result editing fixture state is malformed.");
  }
  const phases: FixturePhase[] = [
    "INITIALIZED", "DATABASE_PREPARED", "STORAGE_PREPARED", "PREPARED",
    "MANIFESTED", "DATABASE_DELETED", "STORAGE_DELETED", "ARTIFACTS_DELETED",
  ];
  if (!phases.includes(value.phase as FixturePhase)) {
    throw new Error("Student result editing fixture state has an invalid phase.");
  }
  const identity = value.databaseIdentity;
  if (identity.scheme !== "postgresql"
    || typeof identity.host !== "string"
    || typeof identity.port !== "string"
    || typeof identity.database !== "string"
    || !LOOPBACK_DATABASE_HOSTS.has(identity.host)) {
    throw new Error("Student result editing fixture state has an invalid database identity.");
  }
  const manifest = value.manifest as unknown as FixtureManifest;
  if (manifest.marker !== FIXTURE_MARKER
    || !isRecord(manifest.login)
    || !isRecord(manifest.appointmentIds)
    || !isRecord(manifest.initialSubmissionIds)
    || !isRecord(manifest.initialFileIds)
    || !isRecord(manifest.chooserArtifacts)
    || !isRecord(manifest.owned)) {
    throw new Error("Student result editing fixture manifest is malformed.");
  }
  const ownedKeys: (keyof OwnedManifest)[] = [
    "studentNumbers", "appointmentIds", "submissionIds", "fileIds", "storageKeys",
    "legacyExamResultIds", "legacyLaboratoryResultIds", "appointmentStatusLogIds",
    "storageCleanupKeys", "notificationIds", "outboxIds", "auditLogIds",
    "loginAttemptIds", "emailVerificationIds",
  ];
  if (ownedKeys.some((key) => !Array.isArray(manifest.owned[key])
    || manifest.owned[key].some((entry) => typeof entry !== "string"))) {
    throw new Error("Student result editing fixture ownership manifest is malformed.");
  }
  const expected = fixtureManifest();
  if (JSON.stringify(manifest.login) !== JSON.stringify(expected.login)
    || JSON.stringify(manifest.appointmentIds) !== JSON.stringify(expected.appointmentIds)
    || JSON.stringify(manifest.initialSubmissionIds) !== JSON.stringify(expected.initialSubmissionIds)
    || JSON.stringify(manifest.initialFileIds) !== JSON.stringify(expected.initialFileIds)
    || JSON.stringify(manifest.chooserArtifacts) !== JSON.stringify(expected.chooserArtifacts)) {
    throw new Error("Student result editing fixture manifest does not match its reserved identifiers.");
  }
  return value as FixtureState;
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

async function readState(): Promise<StateReadResult> {
  try {
    const value = JSON.parse(await readFile(STATE_FILE, "utf8")) as unknown;
    return { kind: "valid", value: parseFixtureState(value) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return {
      kind: "invalid",
      reason: error instanceof SyntaxError
        ? "Student result editing fixture state is not valid JSON."
        : error instanceof Error ? error.message : "Student result editing fixture state is invalid.",
    };
  }
}

async function writeState(state: FixtureState) {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true, mode: 0o700 });
  await writeFile(STATE_TEMP_FILE, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(STATE_TEMP_FILE, STATE_FILE);
}

function ids(rows: IdRow[]) {
  return rows.map((row) => row.id);
}

async function queryIds(client: PoolClient, sql: string, parameters: unknown[] = []) {
  return ids((await client.query<IdRow>(sql, parameters)).rows);
}

async function discoverOwnedManifest(client: PoolClient, seed: OwnedManifest): Promise<OwnedManifest> {
  const studentNumbers = unique([
    ...seed.studentNumbers,
    STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
  ]);
  const appointmentIds = unique([
    ...seed.appointmentIds,
    ...await queryIds(
      client,
      `SELECT id::text FROM appointments
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [studentNumbers, seed.appointmentIds],
    ),
  ]);
  const submissionIds = unique([
    ...seed.submissionIds,
    ...await queryIds(
      client,
      `SELECT id::text FROM student_result_submissions
        WHERE student_number=ANY($1::varchar[])
           OR appointment_id=ANY($2::uuid[])
           OR id=ANY($3::uuid[])
        ORDER BY id`,
      [studentNumbers, appointmentIds, seed.submissionIds],
    ),
  ]);
  const fileRows = await client.query<{ id: string; storageKey: string }>(
    `SELECT id::text AS id,storage_key AS "storageKey"
       FROM student_result_files
      WHERE submission_id=ANY($1::uuid[]) OR id=ANY($2::uuid[])
      ORDER BY id`,
    [submissionIds, seed.fileIds],
  );
  const fileIds = unique([...seed.fileIds, ...fileRows.rows.map((row) => row.id)]);
  const storageKeys = unique([...seed.storageKeys, ...fileRows.rows.map((row) => row.storageKey)]);
  const legacyExamResultIds = unique([
    ...seed.legacyExamResultIds,
    ...await queryIds(client,
      `SELECT id::text FROM exam_results
        WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[]) OR id=ANY($3::uuid[])
        ORDER BY id`,
      [studentNumbers, appointmentIds, seed.legacyExamResultIds]),
  ]);
  const legacyLaboratoryResultIds = unique([
    ...seed.legacyLaboratoryResultIds,
    ...await queryIds(client,
      `SELECT id::text FROM laboratory_results
        WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[]) OR id=ANY($3::uuid[])
        ORDER BY id`,
      [studentNumbers, appointmentIds, seed.legacyLaboratoryResultIds]),
  ]);
  const appointmentStatusLogIds = unique([
    ...seed.appointmentStatusLogIds,
    ...await queryIds(client,
      `SELECT id::text FROM appointment_status_logs
        WHERE appointment_id=ANY($1::uuid[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [appointmentIds, seed.appointmentStatusLogIds]),
  ]);
  const storageCleanupKeys = unique([
    ...seed.storageCleanupKeys,
    ...(await client.query<{ storageKey: string }>(
      `SELECT storage_key AS "storageKey" FROM student_result_storage_cleanup_intents
        WHERE storage_key=ANY($1::text[])
           OR split_part(storage_key,'/',1)=ANY($2::text[])
        ORDER BY storage_key`,
      [unique([...storageKeys, ...seed.storageCleanupKeys]), submissionIds],
    )).rows.map((row) => row.storageKey),
  ]);
  const notificationIds = unique([
    ...seed.notificationIds,
    ...await queryIds(client,
      `SELECT id::text FROM student_portal_notifications
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [studentNumbers, seed.notificationIds]),
  ]);
  const outboxIds = unique([
    ...seed.outboxIds,
    ...await queryIds(client,
      `SELECT id::text FROM email_outbox
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [studentNumbers, seed.outboxIds]),
  ]);
  const loginAttemptIds = unique([
    ...seed.loginAttemptIds,
    ...await queryIds(client,
      `SELECT id::text FROM student_login_attempts
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [studentNumbers, seed.loginAttemptIds]),
  ]);
  const emailVerificationIds = unique([
    ...seed.emailVerificationIds,
    ...await queryIds(client,
      `SELECT id::text FROM student_email_verifications
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY id`,
      [studentNumbers, seed.emailVerificationIds]),
  ]);
  const entityIds = unique([
    ...studentNumbers, ...appointmentIds, ...submissionIds, ...fileIds,
    ...legacyExamResultIds, ...legacyLaboratoryResultIds, ...appointmentStatusLogIds,
    ...notificationIds, ...outboxIds, ...loginAttemptIds, ...emailVerificationIds,
    SETUP_AUDIT_ID,
  ]);
  const auditLogIds = unique([
    ...seed.auditLogIds,
    ...await queryIds(client,
      `SELECT id::text FROM audit_logs
        WHERE id=ANY($1::uuid[])
           OR entity_id=ANY($2::text[])
           OR metadata->>'studentNumber'=ANY($3::text[])
           OR metadata->>'appointmentId'=ANY($4::text[])
           OR metadata->>'basedOnSubmissionId'=ANY($5::text[])
           OR metadata::text LIKE $6
        ORDER BY id`,
      [seed.auditLogIds, entityIds, studentNumbers, appointmentIds, submissionIds,
        `%${STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber}%`],
    ),
  ]);
  return {
    studentNumbers,
    appointmentIds,
    submissionIds,
    fileIds,
    storageKeys,
    legacyExamResultIds,
    legacyLaboratoryResultIds,
    appointmentStatusLogIds,
    storageCleanupKeys,
    notificationIds,
    outboxIds,
    auditLogIds,
    loginAttemptIds,
    emailVerificationIds,
  };
}

async function databaseResidue(
  client: PoolClient,
  manifest: OwnedManifest,
): Promise<Omit<StudentResultEditingResidue, "storageObjects" | "chooserArtifacts" | "stateFiles">> {
  const result = await client.query<Omit<
    StudentResultEditingResidue,
    "storageObjects" | "chooserArtifacts" | "stateFiles"
  >>(
    `SELECT
       (SELECT COUNT(*)::int FROM students
         WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM appointments
         WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])) AS appointments,
       (SELECT COUNT(*)::int FROM student_result_submissions
         WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
            OR id=ANY($3::uuid[])) AS submissions,
       (SELECT COUNT(*)::int FROM student_result_files
         WHERE submission_id=ANY($3::uuid[]) OR id=ANY($4::uuid[])) AS files,
       (SELECT COUNT(*)::int FROM exam_results
         WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
            OR id=ANY($5::uuid[])) AS "legacyExamResults",
       (SELECT COUNT(*)::int FROM laboratory_results
         WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
            OR id=ANY($6::uuid[])) AS "legacyLaboratoryResults",
       (SELECT COUNT(*)::int FROM appointment_status_logs
         WHERE appointment_id=ANY($2::uuid[]) OR id=ANY($7::uuid[])) AS "appointmentStatusLogs",
       (SELECT COUNT(*)::int FROM student_result_storage_cleanup_intents
         WHERE storage_key=ANY($8::text[])) AS "storageCleanupIntents",
       (SELECT COUNT(*)::int FROM student_portal_notifications
         WHERE student_number=ANY($1::varchar[]) OR id=ANY($9::uuid[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox
         WHERE student_number=ANY($1::varchar[]) OR id=ANY($10::uuid[])) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs WHERE id=ANY($11::uuid[])) AS "auditLogs",
       (SELECT COUNT(*)::int FROM student_login_attempts
         WHERE student_number=ANY($1::varchar[]) OR id=ANY($12::uuid[])) AS "loginAttempts",
       (SELECT COUNT(*)::int FROM student_email_verifications
         WHERE student_number=ANY($1::varchar[]) OR id=ANY($13::uuid[])) AS "emailVerifications"`,
    [
      manifest.studentNumbers,
      manifest.appointmentIds,
      manifest.submissionIds,
      manifest.fileIds,
      manifest.legacyExamResultIds,
      manifest.legacyLaboratoryResultIds,
      manifest.appointmentStatusLogIds,
      unique([...manifest.storageKeys, ...manifest.storageCleanupKeys]),
      manifest.notificationIds,
      manifest.outboxIds,
      manifest.auditLogIds,
      manifest.loginAttemptIds,
      manifest.emailVerificationIds,
    ],
  );
  return result.rows[0];
}

async function residue(client: PoolClient, manifest: OwnedManifest): Promise<StudentResultEditingResidue> {
  const storageTargets = unique([
    ...manifest.storageKeys,
    ...manifest.storageCleanupKeys,
  ].flatMap((key) => {
    const target = assertStudentResultEditingStorageTarget(STORAGE_ROOT, key);
    return [target, `${target}.uploading`];
  }));
  const artifactTargets = Object.values(CHOOSER_ARTIFACTS).map(assertChooserArtifactTarget);
  return {
    ...await databaseResidue(client, manifest),
    storageObjects: (await Promise.all(storageTargets.map(fileExists))).filter(Boolean).length,
    chooserArtifacts: (await Promise.all(artifactTargets.map(fileExists))).filter(Boolean).length,
    stateFiles: (await Promise.all([STATE_FILE, STATE_TEMP_FILE].map(fileExists))).filter(Boolean).length,
  };
}

async function assertRequiredSchemaAndReferences(client: PoolClient) {
  const required = await client.query<{
    users: number;
    clinics: number;
    references: number;
    schema: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=$1 AND role='ADMIN') AS users,
       (SELECT COUNT(*)::int FROM clinics WHERE id=ANY($2::uuid[])) AS clinics,
       (SELECT COUNT(*)::int FROM programs WHERE id=$3 AND college_id=$4) AS references,
       (SELECT COUNT(*)::int FROM information_schema.tables
         WHERE table_schema=current_schema()
           AND table_name IN (
             'student_result_submissions','student_result_files',
             'student_result_storage_cleanup_intents'
           )) AS schema`,
    [ADMIN_USER_ID, [LABORATORY_CLINIC_ID, PHYSICAL_EXAM_CLINIC_ID], PROGRAM_ID, COLLEGE_ID],
  );
  if (required.rows[0].users !== 1
    || required.rows[0].clinics !== 2
    || required.rows[0].references !== 1
    || required.rows[0].schema !== 3) {
    throw new Error(`Required seeded references or result-editing schema are missing: ${JSON.stringify(required.rows[0])}.`);
  }
}

async function assertReservedScopeAvailable(client: PoolClient) {
  const base = emptyOwnedManifest();
  const reserved = await discoverOwnedManifest(client, base);
  const counts = await databaseResidue(client, reserved);
  let stateDirectoryEntries = 0;
  try {
    stateDirectoryEntries = (await readdir(FIXTURE_DIRECTORY)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const storageTargets = base.storageKeys.flatMap((key) => {
    const target = assertStudentResultEditingStorageTarget(STORAGE_ROOT, key);
    return [target, `${target}.uploading`];
  });
  const fileCollisions = (await Promise.all([
    ...storageTargets,
    ...Object.values(CHOOSER_ARTIFACTS),
    STATE_TEMP_FILE,
  ].map(fileExists))).filter(Boolean).length;
  if (Object.values(counts).some((count) => count !== 0)
    || fileCollisions !== 0
    || stateDirectoryEntries !== 0) {
    throw new Error(
      `Student result editing fixture reserved database or file scope is occupied; refusing to overwrite it: ${JSON.stringify({ ...counts, fileCollisions, stateDirectoryEntries })}.`,
    );
  }
}

async function assertFixtureDatabaseReady(client: PoolClient) {
  const student = await client.query<{
    studentNumber: string;
    firstName: string;
    middleName: string;
    lastName: string;
    dateOfBirth: string;
    collegeId: string;
    programId: string;
    active: boolean;
  }>(
    `SELECT student_number AS "studentNumber",first_name AS "firstName",
            middle_name AS "middleName",last_name AS "lastName",
            date_of_birth::text AS "dateOfBirth",college_id::text AS "collegeId",
            program_id::text AS "programId",is_active AS active
       FROM students WHERE student_number=$1`,
    [STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber],
  );
  const expectedStudent = {
    studentNumber: STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
    firstName: STUDENT_RESULT_EDITING_FIXTURE.student.firstName,
    middleName: STUDENT_RESULT_EDITING_FIXTURE.student.middleName,
    lastName: STUDENT_RESULT_EDITING_FIXTURE.student.lastName,
    dateOfBirth: STUDENT_RESULT_EDITING_FIXTURE.student.dateOfBirth,
    collegeId: COLLEGE_ID,
    programId: PROGRAM_ID,
    active: true,
  };
  if (JSON.stringify(student.rows) !== JSON.stringify([expectedStudent])) {
    throw new Error("Student result editing fixture student ownership or readiness drift was detected.");
  }

  const appointments = await client.query<{
    id: string;
    clinicId: string;
    scheduleType: string;
    appointmentDate: string;
    status: string;
    published: boolean;
    cycle: number;
  }>(
    `SELECT id::text AS id,clinic_id::text AS "clinicId",schedule_type AS "scheduleType",
            appointment_date::text AS "appointmentDate",status,is_published AS published,
            schedule_cycle_start AS cycle
       FROM appointments WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [Object.values(STUDENT_RESULT_EDITING_FIXTURE.appointmentIds)],
  );
  const expectedAppointments = [
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.laboratory,
      clinicId: LABORATORY_CLINIC_ID,
      scheduleType: "LABORATORY",
      appointmentDate: STUDENT_RESULT_EDITING_FIXTURE.appointmentDates.laboratory,
      status: "COMPLETED",
      published: true,
      cycle: 2026,
    },
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
      clinicId: PHYSICAL_EXAM_CLINIC_ID,
      scheduleType: "PHYSICAL_EXAM",
      appointmentDate: STUDENT_RESULT_EDITING_FIXTURE.appointmentDates.physicalExam,
      status: "COMPLETED",
      published: true,
      cycle: 2026,
    },
  ];
  if (JSON.stringify(appointments.rows) !== JSON.stringify(expectedAppointments)) {
    throw new Error("Student result editing fixture appointment ownership or readiness drift was detected.");
  }

  const submissions = await client.query<{
    id: string;
    appointmentId: string;
    resultType: string;
    status: string;
    basedOnSubmissionId: string | null;
    finalized: boolean;
  }>(
    `SELECT id::text AS id,appointment_id::text AS "appointmentId",result_type AS "resultType",
            status,based_on_submission_id::text AS "basedOnSubmissionId",
            finalized_at IS NOT NULL AS finalized
       FROM student_result_submissions WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [Object.values(STUDENT_RESULT_EDITING_FIXTURE.submissionIds)],
  );
  const expectedSubmissions = [
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.submissionIds.laboratoryDraft,
      appointmentId: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.laboratory,
      resultType: "LABORATORY",
      status: "DRAFT",
      basedOnSubmissionId: null,
      finalized: false,
    },
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
      appointmentId: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
      resultType: "PHYSICAL_EXAM",
      status: "FINALIZED",
      basedOnSubmissionId: null,
      finalized: true,
    },
  ];
  if (JSON.stringify(submissions.rows) !== JSON.stringify(expectedSubmissions)) {
    throw new Error("Student result editing fixture submission ownership or readiness drift was detected.");
  }

  const files = await client.query<{
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    mimeType: string;
    extension: string;
    byteSize: number;
    checksum: string;
    deleted: boolean;
  }>(
    `SELECT id::text AS id,submission_id::text AS "submissionId",storage_key AS "storageKey",
            original_filename AS "originalFilename",detected_mime_type AS "mimeType",extension,
            byte_size::int AS "byteSize",checksum_sha256 AS checksum,
            deleted_at IS NOT NULL AS deleted
       FROM student_result_files WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [Object.values(STUDENT_RESULT_EDITING_FIXTURE.initialFileIds)],
  );
  const expectedFiles = [
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.laboratory,
      submissionId: STUDENT_RESULT_EDITING_FIXTURE.submissionIds.laboratoryDraft,
      storageKey: INITIAL_STORAGE_KEYS.laboratory,
      originalFilename: "initial-laboratory-draft.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      byteSize: PDF_BYTES.byteLength,
      checksum: checksum(PDF_BYTES),
      deleted: false,
    },
    {
      id: STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.physicalExam,
      submissionId: STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
      storageKey: INITIAL_STORAGE_KEYS.physicalExam,
      originalFilename: "initial-physical-exam-official.jpg",
      mimeType: "image/jpeg",
      extension: "jpg",
      byteSize: JPEG_BYTES.byteLength,
      checksum: checksum(JPEG_BYTES),
      deleted: false,
    },
  ];
  if (JSON.stringify(files.rows) !== JSON.stringify(expectedFiles)) {
    throw new Error("Student result editing fixture file ownership or readiness drift was detected.");
  }

  const marker = await client.query<{
    action: string;
    entityType: string;
    entityId: string;
    marker: string | null;
  }>(
    `SELECT action,entity_type AS "entityType",entity_id AS "entityId",
            metadata->>'fixtureMarker' AS marker
       FROM audit_logs WHERE id=$1`,
    [SETUP_AUDIT_ID],
  );
  if (JSON.stringify(marker.rows) !== JSON.stringify([{
    action: "BROWSER_STUDENT_RESULT_EDITING_FIXTURE_PREPARED",
    entityType: "acceptance_fixture",
    entityId: FIXTURE_MARKER,
    marker: FIXTURE_MARKER,
  }])) {
    throw new Error("Student result editing fixture setup marker ownership or readiness drift was detected.");
  }
}

async function ensureFixtureDatabase(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await assertRequiredSchemaAndReferences(client);
    await client.query(
      `INSERT INTO students (
         student_number,first_name,middle_name,last_name,college_id,program_id,year_level,
         date_of_birth,email,email_verified_at,is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,4,$7,'browser-result-editing@example.test',NULL,TRUE)
       ON CONFLICT (student_number) DO NOTHING`,
      [
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
        STUDENT_RESULT_EDITING_FIXTURE.student.firstName,
        STUDENT_RESULT_EDITING_FIXTURE.student.middleName,
        STUDENT_RESULT_EDITING_FIXTURE.student.lastName,
        COLLEGE_ID,
        PROGRAM_ID,
        STUDENT_RESULT_EDITING_FIXTURE.student.dateOfBirth,
      ],
    );
    await client.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,notes
       ) VALUES
         ($1,$3,$5,'LABORATORY',$6,'COMPLETED',TRUE,$8,2026,$9,$9,$10),
         ($2,$4,$5,'PHYSICAL_EXAM',$7,'COMPLETED',TRUE,$8,2026,$9,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.laboratory,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
        LABORATORY_CLINIC_ID,
        PHYSICAL_EXAM_CLINIC_ID,
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentDates.laboratory,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentDates.physicalExam,
        "be180000-0000-4000-8000-000000000401",
        ADMIN_USER_ID,
        FIXTURE_MARKER,
      ],
    );
    await client.query(
      `INSERT INTO student_result_submissions (
         id,appointment_id,student_number,result_type,status,last_activity_at,finalized_at,
         created_at,updated_at
       ) VALUES
         ($1,$3,$5,'LABORATORY','DRAFT',NOW(),NULL,NOW(),NOW()),
         ($2,$4,$5,'PHYSICAL_EXAM','FINALIZED',NOW(),NOW(),NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        STUDENT_RESULT_EDITING_FIXTURE.submissionIds.laboratoryDraft,
        STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.laboratory,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
      ],
    );
    await client.query(
      `INSERT INTO student_result_files (
         id,submission_id,storage_key,original_filename,detected_mime_type,extension,
         byte_size,checksum_sha256,uploaded_at
       ) VALUES
         ($1,$3,$5,'initial-laboratory-draft.pdf','application/pdf','pdf',$7,$9,
          '2026-08-06T08:01:00Z'),
         ($2,$4,$6,'initial-physical-exam-official.jpg','image/jpeg','jpg',$8,$10,
          '2026-08-06T08:06:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [
        STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.laboratory,
        STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.physicalExam,
        STUDENT_RESULT_EDITING_FIXTURE.submissionIds.laboratoryDraft,
        STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
        INITIAL_STORAGE_KEYS.laboratory,
        INITIAL_STORAGE_KEYS.physicalExam,
        PDF_BYTES.byteLength,
        JPEG_BYTES.byteLength,
        checksum(PDF_BYTES),
        checksum(JPEG_BYTES),
      ],
    );
    await client.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
       VALUES ($1,$2,'BROWSER_STUDENT_RESULT_EDITING_FIXTURE_PREPARED','acceptance_fixture',$3::text,
               jsonb_build_object('fixtureMarker',$3::text,'studentNumber',$4::text),
               '2026-08-06T08:07:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [SETUP_AUDIT_ID, ADMIN_USER_ID, FIXTURE_MARKER, STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber],
    );
    await assertFixtureDatabaseReady(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function ensureExactFile(target: string, bytes: Buffer) {
  try {
    const existing = await readFile(target);
    if (!existing.equals(bytes)) {
      throw new Error(`Student result editing fixture refuses to overwrite drifted file: ${target}.`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (!existing.equals(bytes)) {
      throw new Error(`Student result editing fixture refuses to overwrite drifted file: ${target}.`);
    }
  }
}

async function ensurePrivateStorage() {
  await ensureExactFile(
    assertStudentResultEditingStorageTarget(STORAGE_ROOT, INITIAL_STORAGE_KEYS.laboratory),
    PDF_BYTES,
  );
  await ensureExactFile(
    assertStudentResultEditingStorageTarget(STORAGE_ROOT, INITIAL_STORAGE_KEYS.physicalExam),
    JPEG_BYTES,
  );
}

async function ensureChooserArtifacts() {
  const artifacts: [string, Buffer][] = [
    [CHOOSER_ARTIFACTS.pdf, PDF_BYTES],
    [CHOOSER_ARTIFACTS.png, PNG_BYTES],
    [CHOOSER_ARTIFACTS.jpeg, JPEG_BYTES],
    [CHOOSER_ARTIFACTS.invalidText, TXT_BYTES],
  ];
  for (const [path, bytes] of artifacts) {
    await ensureExactFile(assertChooserArtifactTarget(path), bytes);
  }
}

function publicManifest() {
  return {
    marker: FIXTURE_MARKER,
    studentNumber: STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
    adminEmail: STUDENT_RESULT_EDITING_FIXTURE.login.admin.email,
    loginSecrets: `Stored only in the local manifest at ${STATE_FILE}`,
    appointmentIds: STUDENT_RESULT_EDITING_FIXTURE.appointmentIds,
    initialSubmissionIds: STUDENT_RESULT_EDITING_FIXTURE.submissionIds,
    initialFileIds: STUDENT_RESULT_EDITING_FIXTURE.initialFileIds,
    chooserArtifacts: CHOOSER_ARTIFACTS,
    administratorReplacementReason: STUDENT_RESULT_EDITING_FIXTURE.administratorReplacementReason,
    approvedConflictMessage: STUDENT_RESULT_EDITING_FIXTURE.approvedConflictMessage,
  };
}

export async function prepareStudentResultEditingFixture(
  pool: Pool,
  databaseIdentity: StudentResultEditingDatabaseIdentity,
) {
  let stateResult = await readState();
  if (stateResult.kind === "invalid") throw new Error(stateResult.reason);
  if (stateResult.kind === "absent") {
    const client = await pool.connect();
    try {
      await assertRequiredSchemaAndReferences(client);
      await assertReservedScopeAvailable(client);
    } finally {
      client.release();
    }
    const now = new Date().toISOString();
    await writeState({
      version: FIXTURE_VERSION,
      marker: FIXTURE_MARKER,
      databaseIdentity,
      storageRoot: STORAGE_ROOT,
      phase: "INITIALIZED",
      initializedAt: now,
      preparedAt: null,
      manifest: fixtureManifest(),
    });
    stateResult = await readState();
  }
  if (stateResult.kind !== "valid") throw new Error("Student result editing fixture state initialization failed.");
  let state = stateResult.value;
  assertMatchingStudentResultEditingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) {
    throw new Error("RESULT_UPLOAD_ROOT does not match the prepared student result editing fixture storage root.");
  }
  if (["MANIFESTED", "DATABASE_DELETED", "STORAGE_DELETED", "ARTIFACTS_DELETED"].includes(state.phase)) {
    throw new Error("Student result editing fixture cleanup is in progress; finish cleanup before prepare.");
  }

  const client = await pool.connect();
  try {
    await ensureFixtureDatabase(client);
  } finally {
    client.release();
  }
  state = { ...state, phase: "DATABASE_PREPARED" };
  await writeState(state);
  await ensurePrivateStorage();
  state = { ...state, phase: "STORAGE_PREPARED" };
  await writeState(state);
  await ensureChooserArtifacts();
  state = { ...state, phase: "PREPARED", preparedAt: state.preparedAt ?? new Date().toISOString() };
  await writeState(state);
  return getStudentResultEditingFixtureStatus(pool, databaseIdentity);
}

export async function getStudentResultEditingFixtureStatus(
  pool: Pool,
  databaseIdentity: StudentResultEditingDatabaseIdentity,
) {
  const state = await readState();
  if (state.kind === "invalid") throw new Error(state.reason);
  if (state.kind === "valid") {
    assertMatchingStudentResultEditingDatabaseIdentity(databaseIdentity, state.value.databaseIdentity);
    if (state.value.storageRoot !== STORAGE_ROOT) {
      throw new Error("RESULT_UPLOAD_ROOT does not match the prepared student result editing fixture storage root.");
    }
  }
  const client = await pool.connect();
  try {
    await assertRequiredSchemaAndReferences(client);
    const base = state.kind === "valid" ? state.value.manifest.owned : emptyOwnedManifest();
    const manifest = mergeOwnedManifests(base, await discoverOwnedManifest(client, base));
    const appointments = await client.query(
      `SELECT id::text,student_number AS "studentNumber",schedule_type AS "scheduleType",
              appointment_date::text AS "appointmentDate",status,is_published AS published
         FROM appointments
        WHERE student_number=ANY($1::varchar[]) OR id=ANY($2::uuid[])
        ORDER BY appointment_date,id`,
      [manifest.studentNumbers, manifest.appointmentIds],
    );
    const submissions = await client.query(
      `SELECT submission.id::text,submission.appointment_id::text AS "appointmentId",
              submission.result_type AS "resultType",submission.status,
              submission.based_on_submission_id::text AS "basedOnSubmissionId",
              submission.superseded_by_submission_id::text AS "supersededBySubmissionId",
              COUNT(file.id)::int AS "fileCount"
         FROM student_result_submissions submission
         LEFT JOIN student_result_files file
           ON file.submission_id=submission.id AND file.deleted_at IS NULL
        WHERE submission.student_number=ANY($1::varchar[])
           OR submission.appointment_id=ANY($2::uuid[])
           OR submission.id=ANY($3::uuid[])
        GROUP BY submission.id
        ORDER BY submission.created_at,submission.id`,
      [manifest.studentNumbers, manifest.appointmentIds, manifest.submissionIds],
    );
    return {
      mode: "status" as const,
      databaseIdentity,
      phase: state.kind === "valid" ? state.value.phase : "ABSENT" as const,
      preparedAt: state.kind === "valid" ? state.value.preparedAt : null,
      stateFile: STATE_FILE,
      storageRoot: STORAGE_ROOT,
      manifest: publicManifest(),
      owned: manifest,
      appointments: appointments.rows,
      submissions: submissions.rows,
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
    await client.query("DELETE FROM email_outbox WHERE id=ANY($1::uuid[])", [manifest.outboxIds]);
    await client.query("DELETE FROM student_portal_notifications WHERE id=ANY($1::uuid[])", [manifest.notificationIds]);
    await client.query(
      "DELETE FROM student_result_storage_cleanup_intents WHERE storage_key=ANY($1::text[])",
      [unique([...manifest.storageKeys, ...manifest.storageCleanupKeys])],
    );
    await client.query("DELETE FROM student_email_verifications WHERE id=ANY($1::uuid[])", [manifest.emailVerificationIds]);
    await client.query("DELETE FROM student_login_attempts WHERE id=ANY($1::uuid[])", [manifest.loginAttemptIds]);
    await client.query("DELETE FROM student_result_files WHERE id=ANY($1::uuid[])", [manifest.fileIds]);
    await client.query("DELETE FROM student_result_submissions WHERE id=ANY($1::uuid[])", [manifest.submissionIds]);
    await client.query("DELETE FROM exam_results WHERE id=ANY($1::uuid[])", [manifest.legacyExamResultIds]);
    await client.query("DELETE FROM laboratory_results WHERE id=ANY($1::uuid[])", [manifest.legacyLaboratoryResultIds]);
    await client.query("DELETE FROM appointment_status_logs WHERE id=ANY($1::uuid[])", [manifest.appointmentStatusLogIds]);
    await client.query("DELETE FROM appointments WHERE id=ANY($1::uuid[])", [manifest.appointmentIds]);
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [manifest.studentNumbers]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function removeOwnedStorage(
  manifest: OwnedManifest,
  removeStorageObject: (target: string) => Promise<void>,
) {
  const targets = unique([
    ...manifest.storageKeys,
    ...manifest.storageCleanupKeys,
  ].flatMap((key) => {
    const target = assertStudentResultEditingStorageTarget(STORAGE_ROOT, key);
    return [target, `${target}.uploading`];
  }));
  for (const target of targets) await removeStorageObject(target);
}

async function removeChooserArtifacts() {
  for (const path of Object.values(CHOOSER_ARTIFACTS)) {
    await rm(assertChooserArtifactTarget(path), { force: true });
  }
  try {
    await rmdir(ARTIFACT_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertFixtureDirectoryContainsOnlyState() {
  let entries: string[];
  try {
    entries = await readdir(FIXTURE_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The exact student result editing fixture state directory is missing before final proof.");
    }
    throw error;
  }
  const unexpected = entries.filter((entry) => entry !== "state.json");
  if (unexpected.length) {
    throw new Error(
      `Student result editing fixture directory contains unowned files; refusing directory removal: ${JSON.stringify(unexpected)}.`,
    );
  }
}

export async function cleanupStudentResultEditingFixture(
  pool: Pool,
  databaseIdentity: StudentResultEditingDatabaseIdentity,
  dependencies: StudentResultEditingCleanupDependencies = {},
) {
  let stateResult = await readState();
  if (stateResult.kind === "invalid") throw new Error(stateResult.reason);
  if (stateResult.kind === "absent") {
    const status = await getStudentResultEditingFixtureStatus(pool, databaseIdentity);
    return assertZeroStudentResultEditingResidue(status.residue);
  }
  let state = stateResult.value;
  assertMatchingStudentResultEditingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) {
    throw new Error("RESULT_UPLOAD_ROOT does not match the prepared student result editing fixture storage root.");
  }
  const client = await pool.connect();
  try {
    if (![
      "DATABASE_DELETED", "STORAGE_DELETED", "ARTIFACTS_DELETED",
    ].includes(state.phase)) {
      const discovered = await discoverOwnedManifest(client, state.manifest.owned);
      state = {
        ...state,
        phase: "MANIFESTED",
        manifest: {
          ...state.manifest,
          owned: mergeOwnedManifests(state.manifest.owned, discovered),
        },
      };
      await writeState(state);
      await deleteOwnedDatabaseRows(client, state.manifest.owned);
      state = { ...state, phase: "DATABASE_DELETED" };
      await writeState(state);
    }
    if (state.phase === "DATABASE_DELETED") {
      await removeOwnedStorage(
        state.manifest.owned,
        dependencies.removeStorageObject ?? (async (target) => rm(target, { force: true })),
      );
      state = { ...state, phase: "STORAGE_DELETED" };
      await writeState(state);
    }
    if (state.phase === "STORAGE_DELETED") {
      await removeChooserArtifacts();
      state = { ...state, phase: "ARTIFACTS_DELETED" };
      await writeState(state);
    }
    const beforeStateRemoval = await residue(client, state.manifest.owned);
    if (beforeStateRemoval.stateFiles !== 1) {
      throw new Error("The exact student result editing fixture state file is missing before final proof.");
    }
    assertZeroStudentResultEditingResidue({ ...beforeStateRemoval, stateFiles: 0 });
    await assertFixtureDirectoryContainsOnlyState();
    await rm(STATE_FILE, { force: true });
    await rmdir(FIXTURE_DIRECTORY);
  } finally {
    client.release();
  }
  stateResult = await readState();
  if (stateResult.kind !== "absent") {
    throw new Error("Student result editing fixture state remained after cleanup.");
  }
  const status = await getStudentResultEditingFixtureStatus(pool, databaseIdentity);
  return assertZeroStudentResultEditingResidue(status.residue);
}

async function run() {
  const mode = process.argv[2] as StudentResultEditingFixtureMode | undefined;
  if (!mode || !["prepare", "status", "cleanup"].includes(mode)) {
    throw new Error(
      "Use prepare, status, or cleanup with a loopback PostgreSQL DATABASE_URL. Prepare and cleanup also require STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1.",
    );
  }
  const databaseIdentity = assertSafeStudentResultEditingAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env.STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE,
    mode,
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const output = mode === "prepare"
      ? await prepareStudentResultEditingFixture(pool, databaseIdentity)
      : mode === "status"
        ? await getStudentResultEditingFixtureStatus(pool, databaseIdentity)
        : { mode: "cleanup" as const, residue: await cleanupStudentResultEditingFixture(pool, databaseIdentity) };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) await run();
