import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const CONFIRMATION = "DELETE_NON_WORKBOOK_REFERENCE_DATA";
const STATE_DIRECTORY = resolve(".data/reference-catalog-cleanup");
const STATE_FILE = resolve(STATE_DIRECTORY, "state.json");

export const CANONICAL_COLLEGE_IDS = Array.from(
  { length: 13 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
export const CANONICAL_PROGRAM_IDS = Array.from(
  { length: 48 },
  (_, index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

export type CleanupDatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
  storageRoot: string;
};

export type CatalogCleanupManifest = {
  obsoleteCollegeIds: string[];
  obsoleteProgramIds: string[];
  studentNumbers: string[];
  importGroupIds: string[];
  batchIds: string[];
  appointmentIds: string[];
  coordinatorItemIds: string[];
  submissionIds: string[];
  resultFiles: Array<{ id: string; storageKey: string }>;
  counts: Record<string, number>;
  rescheduleEventIds?: string[];
  notificationIds?: string[];
  verificationIds?: string[];
  loginAttemptIds?: string[];
  outboxIds?: string[];
  examResultIds?: string[];
  laboratoryResultIds?: string[];
  statusLogIds?: string[];
  auditIds?: string[];
};

export type CatalogCleanupProgress = {
  version: 1;
  phase: "MANIFESTED" | "DATABASE_DELETED" | "FILES_DELETED";
  identity: CleanupDatabaseIdentity;
  manifest: CatalogCleanupManifest;
  privateResultDirectories: string[];
};

type CleanupResidue = { databaseRows: number; privateStorageDirectories: number };
type CleanupActions = {
  captureManifest: () => Promise<CatalogCleanupManifest>;
  persist: (progress: CatalogCleanupProgress) => Promise<void>;
  deleteDatabase: (manifest: CatalogCleanupManifest) => Promise<void>;
  deletePrivateFiles: (directories: string[]) => Promise<void>;
  prove: (manifest: CatalogCleanupManifest, directories: string[]) => Promise<CleanupResidue>;
};

function normalizeDatabaseUrl(databaseUrl: string) {
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
  const host = parsed.hostname.replace(/^\[(.*)\]$/u, "$1").toLocaleLowerCase();
  let database: string;
  try {
    database = decodeURI(parsed.pathname.replace(/^\//u, ""));
  } catch {
    throw new Error("DATABASE_URL must contain a valid database name.");
  }
  if (!host || !database) throw new Error("DATABASE_URL must contain a host and database name.");
  return { scheme: "postgresql" as const, host, port: parsed.port || "5432", database };
}

export function assertSafeCleanupRequest({
  databaseUrl,
  storageRoot,
  exclusiveDatabase,
  confirmation,
}: {
  databaseUrl: string | undefined;
  storageRoot: string | undefined;
  exclusiveDatabase: string | undefined;
  confirmation: string | undefined;
}): CleanupDatabaseIdentity {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  if (exclusiveDatabase !== "1") {
    throw new Error("Set REFERENCE_CATALOG_CLEANUP_EXCLUSIVE_DATABASE=1 only during an exclusive maintenance window.");
  }
  if (confirmation !== CONFIRMATION) {
    throw new Error(`Set REFERENCE_CATALOG_CLEANUP_CONFIRM=${CONFIRMATION} to authorize destructive cleanup.`);
  }
  return { ...normalizeDatabaseUrl(databaseUrl), storageRoot: resolve(storageRoot ?? ".data/private-result-uploads") };
}

function cleanupReadIdentity(databaseUrl: string | undefined, storageRoot: string | undefined) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  return { ...normalizeDatabaseUrl(databaseUrl), storageRoot: resolve(storageRoot ?? ".data/private-result-uploads") };
}

export function assertMatchingCleanupIdentity(
  current: CleanupDatabaseIdentity,
  persisted: CleanupDatabaseIdentity,
) {
  if (Object.keys(current).some((key) => (
    current[key as keyof CleanupDatabaseIdentity] !== persisted[key as keyof CleanupDatabaseIdentity]
  ))) {
    throw new Error("Current database or result-storage identity does not match the cleanup state.");
  }
}

export function privateResultDirectories(storageKeys: string[]) {
  const directories = new Set<string>();
  for (const storageKey of storageKeys) {
    if (
      !storageKey
      || isAbsolute(storageKey)
      || storageKey.includes("..")
      || storageKey.includes("\\")
      || !storageKey.includes("/")
    ) {
      throw new Error(`Invalid result storage key: ${storageKey}`);
    }
    const [directory] = storageKey.split("/");
    if (!directory || directory === ".") throw new Error(`Invalid result storage key: ${storageKey}`);
    directories.add(directory);
  }
  return [...directories].sort();
}

function privateStorageTarget(storageRoot: string, directory: string) {
  const root = resolve(storageRoot);
  const target = resolve(root, directory);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to access result storage outside ${root}: ${target}`);
  }
  return target;
}

function assertZeroResidue(residue: CleanupResidue) {
  if (residue.databaseRows !== 0 || residue.privateStorageDirectories !== 0) {
    throw new Error(
      `Reference catalog cleanup residue remains: databaseRows=${residue.databaseRows}, privateStorageDirectories=${residue.privateStorageDirectories}.`,
    );
  }
}

export async function runPersistedCatalogCleanup(
  progress: CatalogCleanupProgress | undefined,
  identity: CleanupDatabaseIdentity,
  actions: CleanupActions,
) {
  let current = progress;
  if (current) assertMatchingCleanupIdentity(identity, current.identity);
  if (!current) {
    const manifest = await actions.captureManifest();
    current = {
      version: 1,
      phase: "MANIFESTED",
      identity,
      manifest,
      privateResultDirectories: privateResultDirectories(
        manifest.resultFiles.map((file) => file.storageKey),
      ),
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
  const residue = await actions.prove(current.manifest, current.privateResultDirectories);
  assertZeroResidue(residue);
  return residue;
}

async function idRows(client: PoolClient, sql: string, parameters: unknown[] = []) {
  const result = await client.query<{ id: string }>(sql, parameters);
  return result.rows.map((row) => row.id);
}

export async function assertEffectiveCleanupDatabase(
  client: PoolClient,
  identity: CleanupDatabaseIdentity,
) {
  const result = await client.query<{ database: string; port: number | null }>(
    "SELECT current_database() AS database, inet_server_port() AS port",
  );
  const effective = result.rows[0];
  if (effective.database !== identity.database || (effective.port !== null && String(effective.port) !== identity.port)) {
    throw new Error(
      `Effective PostgreSQL identity ${effective.database}:${effective.port ?? "local"} does not match DATABASE_URL ${identity.database}:${identity.port}.`,
    );
  }
}

export async function captureCleanupManifest(client: PoolClient): Promise<CatalogCleanupManifest> {
  const obsoleteCollegeIds = await idRows(
    client,
    "SELECT id::text AS id FROM colleges WHERE NOT (id=ANY($1::uuid[])) ORDER BY id",
    [CANONICAL_COLLEGE_IDS],
  );
  const obsoleteProgramIds = await idRows(
    client,
    "SELECT id::text AS id FROM programs WHERE NOT (id=ANY($1::uuid[])) ORDER BY id",
    [CANONICAL_PROGRAM_IDS],
  );
  const studentNumbers = await idRows(
    client,
    `SELECT student_number AS id
       FROM students
      WHERE NOT (college_id=ANY($1::uuid[]))
         OR NOT (program_id=ANY($2::uuid[]))
      ORDER BY student_number`,
    [CANONICAL_COLLEGE_IDS, CANONICAL_PROGRAM_IDS],
  );
  const importGroupIds = await idRows(
    client,
    `SELECT DISTINCT batch.import_group_id::text AS id
       FROM schedule_batches batch
       LEFT JOIN coordinator_schedule_items item ON item.batch_id=batch.id
      WHERE batch.import_group_id IS NOT NULL
        AND (NOT (batch.college_id=ANY($1::uuid[]))
          OR NOT (batch.program_id=ANY($2::uuid[]))
          OR item.student_number=ANY($3::varchar[]))
      ORDER BY id`,
    [CANONICAL_COLLEGE_IDS, CANONICAL_PROGRAM_IDS, studentNumbers],
  );
  const batchIds = await idRows(
    client,
    `SELECT DISTINCT batch.id::text AS id
       FROM schedule_batches batch
       LEFT JOIN coordinator_schedule_items item ON item.batch_id=batch.id
      WHERE batch.import_group_id=ANY($1::uuid[])
         OR NOT (batch.college_id=ANY($2::uuid[]))
         OR NOT (batch.program_id=ANY($3::uuid[]))
         OR item.student_number=ANY($4::varchar[])
      ORDER BY id`,
    [importGroupIds, CANONICAL_COLLEGE_IDS, CANONICAL_PROGRAM_IDS, studentNumbers],
  );
  const appointmentIds = await idRows(
    client,
    `WITH RECURSIVE targets AS (
       SELECT id
         FROM appointments
        WHERE batch_id=ANY($1::uuid[]) OR student_number=ANY($2::varchar[])
       UNION
       SELECT child.id
         FROM appointments child
         JOIN targets parent ON child.rescheduled_from=parent.id
     )
     SELECT id::text FROM targets ORDER BY id`,
    [batchIds, studentNumbers],
  );
  const coordinatorItemIds = await idRows(
    client,
    `SELECT id::text AS id
       FROM coordinator_schedule_items
      WHERE batch_id=ANY($1::uuid[]) OR student_number=ANY($2::varchar[])
      ORDER BY id`,
    [batchIds, studentNumbers],
  );
  const submissionIds = await idRows(
    client,
    `SELECT id::text AS id
       FROM student_result_submissions
      WHERE appointment_id=ANY($1::uuid[]) OR student_number=ANY($2::varchar[])
      ORDER BY id`,
    [appointmentIds, studentNumbers],
  );
  const resultFiles = submissionIds.length
    ? (await client.query<{ id: string; storageKey: string }>(
        `SELECT id::text AS id, storage_key AS "storageKey"
           FROM student_result_files
          WHERE submission_id=ANY($1::uuid[])
          ORDER BY id`,
        [submissionIds],
      )).rows
    : [];
  const rescheduleEventIds = await idRows(
    client,
    `SELECT id::text AS id FROM appointment_reschedule_events
      WHERE student_number=ANY($1::varchar[])
         OR old_laboratory_appointment_id=ANY($2::uuid[])
         OR new_laboratory_appointment_id=ANY($2::uuid[])
         OR old_physical_exam_appointment_id=ANY($2::uuid[])
         OR new_physical_exam_appointment_id=ANY($2::uuid[])
      ORDER BY id`,
    [studentNumbers, appointmentIds],
  );
  const notificationIds = await idRows(client, "SELECT id::text AS id FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const verificationIds = await idRows(client, "SELECT id::text AS id FROM student_email_verifications WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const loginAttemptIds = await idRows(client, "SELECT id::text AS id FROM student_login_attempts WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const outboxIds = await idRows(client, "SELECT id::text AS id FROM email_outbox WHERE student_number=ANY($1::varchar[]) ORDER BY id", [studentNumbers]);
  const examResultIds = await idRows(client, "SELECT id::text AS id FROM exam_results WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[]) ORDER BY id", [studentNumbers, appointmentIds]);
  const laboratoryResultIds = await idRows(client, "SELECT id::text AS id FROM laboratory_results WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[]) ORDER BY id", [studentNumbers, appointmentIds]);
  const statusLogIds = await idRows(client, "SELECT id::text AS id FROM appointment_status_logs WHERE appointment_id=ANY($1::uuid[]) ORDER BY id", [appointmentIds]);
  const auditIds = await idRows(
    client,
    `SELECT audit.id::text AS id
       FROM audit_logs audit
      WHERE (audit.entity_type='schedule_import_group' AND audit.entity_id=ANY($1::text[]))
         OR (audit.entity_type='schedule_batch' AND audit.entity_id=ANY($2::text[]))
         OR (audit.entity_type='student' AND audit.entity_id=ANY($3::text[]))
         OR (audit.entity_type='appointment' AND audit.entity_id=ANY($4::text[]))
         OR audit.metadata->>'studentNumber'=ANY($3::text[])
         OR audit.metadata->>'batchId'=ANY($2::text[])
         OR audit.metadata->>'replacementId'=ANY($4::text[])
      ORDER BY id`,
    [importGroupIds, batchIds, studentNumbers, appointmentIds],
  );

  const counts = {
    obsoleteColleges: obsoleteCollegeIds.length,
    obsoletePrograms: obsoleteProgramIds.length,
    students: studentNumbers.length,
    importGroups: importGroupIds.length,
    batches: batchIds.length,
    appointments: appointmentIds.length,
    coordinatorItems: coordinatorItemIds.length,
    submissions: submissionIds.length,
    resultFiles: resultFiles.length,
    rescheduleEvents: rescheduleEventIds.length,
    notifications: notificationIds.length,
    verificationTokens: verificationIds.length,
    loginAttempts: loginAttemptIds.length,
    outbox: outboxIds.length,
    examResults: examResultIds.length,
    laboratoryResults: laboratoryResultIds.length,
    statusLogs: statusLogIds.length,
    audits: auditIds.length,
  };
  return {
    obsoleteCollegeIds,
    obsoleteProgramIds,
    studentNumbers,
    importGroupIds,
    batchIds,
    appointmentIds,
    coordinatorItemIds,
    submissionIds,
    resultFiles,
    counts,
    rescheduleEventIds,
    notificationIds,
    verificationIds,
    loginAttemptIds,
    outboxIds,
    examResultIds,
    laboratoryResultIds,
    statusLogIds,
    auditIds,
  };
}

async function deleteIds(client: PoolClient, table: string, ids: string[]) {
  if (ids.length) await client.query(`DELETE FROM ${table} WHERE id=ANY($1::uuid[])`, [ids]);
}

export async function deleteManifestDatabaseRows(pool: Pool, manifest: CatalogCleanupManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cpu_reference_catalog_cleanup'))");
    await deleteIds(client, "audit_logs", manifest.auditIds ?? []);
    await deleteIds(client, "appointment_reschedule_events", manifest.rescheduleEventIds ?? []);
    await deleteIds(client, "student_result_submissions", manifest.submissionIds);
    await deleteIds(client, "student_portal_notifications", manifest.notificationIds ?? []);
    await deleteIds(client, "student_email_verifications", manifest.verificationIds ?? []);
    await deleteIds(client, "email_outbox", manifest.outboxIds ?? []);
    await deleteIds(client, "student_login_attempts", manifest.loginAttemptIds ?? []);
    await deleteIds(client, "exam_results", manifest.examResultIds ?? []);
    await deleteIds(client, "laboratory_results", manifest.laboratoryResultIds ?? []);
    await deleteIds(client, "appointment_status_logs", manifest.statusLogIds ?? []);
    await deleteIds(client, "appointments", manifest.appointmentIds);
    await deleteIds(client, "coordinator_schedule_items", manifest.coordinatorItemIds);
    await deleteIds(client, "schedule_batches", manifest.batchIds);
    await deleteIds(client, "schedule_import_groups", manifest.importGroupIds);
    if (manifest.studentNumbers.length) {
      await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [manifest.studentNumbers]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistProgress(progress: CatalogCleanupProgress) {
  await mkdir(STATE_DIRECTORY, { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(temporary, STATE_FILE);
}

async function readProgress() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as CatalogCleanupProgress;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function deletePrivateFiles(storageRoot: string, directories: string[]) {
  for (const directory of directories) {
    await rm(privateStorageTarget(storageRoot, directory), { recursive: true, force: true });
  }
}

async function proveCleanup(
  pool: Pool,
  manifest: CatalogCleanupManifest,
  storageRoot: string,
  directories: string[],
): Promise<CleanupResidue> {
  const client = await pool.connect();
  try {
    const checks: Array<[string, string[]]> = [
      ["students", manifest.studentNumbers],
      ["schedule_import_groups", manifest.importGroupIds],
      ["schedule_batches", manifest.batchIds],
      ["coordinator_schedule_items", manifest.coordinatorItemIds],
      ["appointments", manifest.appointmentIds],
      ["student_result_submissions", manifest.submissionIds],
      ["student_result_files", manifest.resultFiles.map((file) => file.id)],
    ];
    let databaseRows = 0;
    for (const [table, ids] of checks) {
      if (!ids.length) continue;
      const column = table === "students" ? "student_number" : "id";
      const cast = table === "students" ? "varchar[]" : "uuid[]";
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column}=ANY($1::${cast})`,
        [ids],
      );
      databaseRows += result.rows[0].count;
    }
    let privateStorageDirectories = 0;
    for (const directory of directories) {
      try {
        await access(privateStorageTarget(storageRoot, directory));
        privateStorageDirectories += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { databaseRows, privateStorageDirectories };
  } finally {
    client.release();
  }
}

async function run() {
  const mode = process.argv[2] ?? "plan";
  if (!new Set(["plan", "apply", "status"]).has(mode)) {
    throw new Error("Use plan, apply, or status.");
  }
  const identity = mode === "apply"
    ? assertSafeCleanupRequest({
        databaseUrl: process.env.DATABASE_URL,
        storageRoot: process.env.RESULT_UPLOAD_ROOT,
        exclusiveDatabase: process.env.REFERENCE_CATALOG_CLEANUP_EXCLUSIVE_DATABASE,
        confirmation: process.env.REFERENCE_CATALOG_CLEANUP_CONFIRM,
      })
    : cleanupReadIdentity(process.env.DATABASE_URL, process.env.RESULT_UPLOAD_ROOT);
  const progress = await readProgress();
  if (progress) assertMatchingCleanupIdentity(identity, progress.identity);
  if (mode === "status") {
    console.log(JSON.stringify(progress ?? { phase: "NOT_STARTED", identity }, null, 2));
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await assertEffectiveCleanupDatabase(client, identity);
    } finally {
      client.release();
    }
    if (mode === "plan") {
      const planClient = await pool.connect();
      try {
        const manifest = await captureCleanupManifest(planClient);
        console.log(JSON.stringify({ mode, identity, counts: manifest.counts, manifest }, null, 2));
      } finally {
        planClient.release();
      }
      return;
    }
    const residue = await runPersistedCatalogCleanup(progress, identity, {
      captureManifest: async () => {
        const manifestClient = await pool.connect();
        try {
          return await captureCleanupManifest(manifestClient);
        } finally {
          manifestClient.release();
        }
      },
      persist: persistProgress,
      deleteDatabase: (manifest) => deleteManifestDatabaseRows(pool, manifest),
      deletePrivateFiles: (directories) => deletePrivateFiles(identity.storageRoot, directories),
      prove: (manifest, directories) => proveCleanup(pool, manifest, identity.storageRoot, directories),
    });
    console.log(JSON.stringify({ mode, phase: "FILES_DELETED", identity, residue }, null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  await run();
}
