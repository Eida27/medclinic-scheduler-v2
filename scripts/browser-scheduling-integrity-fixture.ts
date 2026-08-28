import bcrypt from "bcryptjs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

export const SCHEDULING_INTEGRITY_ACCEPTANCE_FLAG =
  "SCHEDULING_INTEGRITY_ACCEPTANCE_EXCLUSIVE_DATABASE";

const MARKER = "BROWSER-SCHEDULING-INTEGRITY-20260826";
const STATE_FILE = resolve(process.cwd(), ".data", "browser-scheduling-integrity.json");
const STORAGE_ROOT = resolve(
  process.env.RESULT_UPLOAD_ROOT ?? resolve(process.cwd(), ".data", "private-results"),
);
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const CAPACITY_STUDENT_COUNT = 150;

// Acceptance-only credentials. They are intentionally excluded from every
// setup/status/cleanup JSON response; Browser operators read them locally here.
const SCHEDULING_INTEGRITY_ADMIN_PASSWORD = "SihAdmin-2026!";
const SCHEDULING_INTEGRITY_STAFF_PASSWORD = "SihStaff-2026!";
const SCHEDULING_INTEGRITY_PORTAL_DATE_OF_BIRTH = "2004-05-06";
const SCHEDULING_INTEGRITY_PORTAL_MIDDLE_NAME = "Integrity";

const FIXED_IDS = {
  adminUser: "5a260826-0000-4000-8000-000000000001",
  staffUser: "5a260826-0000-4000-8000-000000000002",
  college: "5a260826-0000-4000-8000-000000000003",
  program: "5a260826-0000-4000-8000-000000000004",
  importGroup: "5a260826-0000-4000-8000-000000000005",
  scheduleBatch: "5a260826-0000-4000-8000-000000000006",
  scheduleItem: "5a260826-0000-4000-8000-000000000007",
  closureGroup: "5a260826-0000-4000-8000-000000000008",
  unavailableDate: "5a260826-0000-4000-8000-000000000009",
  ovpsaBatch: "5a260826-0000-4000-8000-00000000000a",
  ovpsaRevision: "5a260826-0000-4000-8000-00000000000b",
  reservation: "5a260826-0000-4000-8000-00000000000c",
  manualCase: "5a260826-0000-4000-8000-00000000000d",
  rescheduleEvent: "5a260826-0000-4000-8000-00000000000e",
} as const;

const APPOINTMENT_IDS = {
  lifecycleLaboratory: "5a260826-0000-4000-8000-000000000011",
  lifecyclePhysicalExam: "5a260826-0000-4000-8000-000000000012",
  manualLaboratory: "5a260826-0000-4000-8000-000000000013",
  manualPhysicalExam: "5a260826-0000-4000-8000-000000000014",
  displacementLaboratory: "5a260826-0000-4000-8000-000000000015",
  displacementPhysicalExam: "5a260826-0000-4000-8000-000000000016",
  portalLaboratory: "5a260826-0000-4000-8000-000000000017",
  portalPhysicalExam: "5a260826-0000-4000-8000-000000000018",
} as const;

const PAIR_IDS = {
  lifecycle: "5a260826-0000-4000-8000-000000000101",
  manual: "5a260826-0000-4000-8000-000000000102",
  displacement: "5a260826-0000-4000-8000-000000000103",
  portal: "5a260826-0000-4000-8000-000000000104",
} as const;

const DATES = {
  lifecycleLaboratory: "2027-04-05",
  lifecyclePhysicalExam: "2027-04-12",
  manualLaboratory: "2027-04-06",
  manualPhysicalExam: "2027-04-13",
  displacementLaboratory: "2027-04-07",
  displacementPhysicalExam: "2027-04-14",
  portalLaboratory: "2027-04-08",
  portalPhysicalExam: "2027-04-15",
  blockedClosure: "2027-04-19",
  manualValidReplacement: "2027-04-20",
  displacementReplacementLaboratory: "2027-04-21",
  exclusiveReservation: "2027-04-27",
  displacementReplacementPhysicalExam: "2027-04-28",
  capacityFull: "2027-04-29",
} as const;

const CORE_STUDENTS = {
  lifecycle: { studentNumber: "B-SIH-LIFE" },
  manual: { studentNumber: "B-SIH-MANUAL" },
  displacement: { studentNumber: "B-SIH-DISPLACE" },
  portal: { studentNumber: "B-SIH-PORTAL" },
  legacySentinel: { studentNumber: "B-SIH-LEGACY" },
} as const;

function capacityStudentNumber(position: number) {
  return `B-SIH-CAP-${String(position).padStart(3, "0")}`;
}

const CAPACITY_STUDENT_NUMBERS = Array.from(
  { length: CAPACITY_STUDENT_COUNT },
  (_, index) => capacityStudentNumber(index + 1),
);
const ALL_STUDENT_NUMBERS = [
  ...Object.values(CORE_STUDENTS).map((student) => student.studentNumber),
  ...CAPACITY_STUDENT_NUMBERS,
];

export const SCHEDULING_INTEGRITY_FIXTURE = {
  marker: MARKER,
  cycleStart: 2026,
  admin: {
    id: FIXED_IDS.adminUser,
    email: "browser-sih-admin@example.test",
    loginPath: "/login",
  },
  staff: {
    id: FIXED_IDS.staffUser,
    email: "browser-sih-staff@example.test",
  },
  students: CORE_STUDENTS,
  appointmentIds: APPOINTMENT_IDS,
  pairIds: PAIR_IDS,
  dates: DATES,
  capacityStudentCount: CAPACITY_STUDENT_COUNT,
  ids: FIXED_IDS,
  routes: {
    homepage: "/",
    studentLogin: "/student/login",
    retiredStudentLookup: "/student-lookup",
    studentPortal: "/student",
    lifecycleLaboratory: `/appointments/${APPOINTMENT_IDS.lifecycleLaboratory}`,
    lifecyclePhysicalExam: `/appointments/${APPOINTMENT_IDS.lifecyclePhysicalExam}`,
    manualAppointment: `/appointments/${APPOINTMENT_IDS.manualPhysicalExam}`,
    manualResolution: "/settings/clinic-unavailable-dates/manual-resolution",
  },
  retiredRequests: [
    { method: "POST", path: "/api/coordinator-schedules" },
    { method: "POST", path: "/api/coordinator-schedules/validate" },
    { method: "PATCH", path: `/api/coordinator-schedules/${FIXED_IDS.scheduleBatch}` },
    { method: "POST", path: "/api/appointments/generate" },
    { method: "POST", path: "/api/appointments/publish" },
  ],
  publicLookupRequests: [
    `/api/student-lookup?studentNumber=${CORE_STUDENTS.portal.studentNumber}&dateOfBirth=1900-01-01`,
    "/api/student-lookup?studentNumber=B-SIH-MISSING&dateOfBirth=1900-01-01",
    "/api/student-lookup?unexpected=%7Bmalformed%7D",
  ],
} as const;

export type SchedulingIntegrityDatabaseIdentity = {
  scheme: "postgres" | "postgresql";
  host: string;
  port: string;
  database: string;
};

export type RetiredRouteSentinelSnapshot = {
  importGroups: number;
  batches: number;
  items: number;
  batchStatus: string | null;
  itemStatus: string | null;
  batchUpdatedAt: string | null;
  itemUpdatedAt: string | null;
};

export type SchedulingIntegrityResidue = {
  users: number;
  students: number;
  colleges: number;
  programs: number;
  appointments: number;
  appointmentStatusLogs: number;
  laboratoryResults: number;
  examResults: number;
  resultSubmissions: number;
  resultFiles: number;
  storageCleanupIntents: number;
  importGroups: number;
  scheduleBatches: number;
  scheduleItems: number;
  manualCases: number;
  rescheduleEvents: number;
  closureGroups: number;
  unavailableDates: number;
  ovpsaBatches: number;
  ovpsaRevisions: number;
  reservations: number;
  calendarRequests: number;
  studentLoginAttempts: number;
  studentEmailVerifications: number;
  staffEmailVerifications: number;
  staffPasswordResets: number;
  notifications: number;
  outbox: number;
  auditLogs: number;
  storageFiles: number;
  stateFiles: number;
};

export type SchedulingIntegrityPreparedCounts = {
  users: number;
  coreStudents: number;
  capacityStudents: number;
  pairAppointments: number;
  capacityAppointments: number;
  importGroups: number;
  scheduleBatches: number;
  scheduleItems: number;
  manualCases: number;
  rescheduleEvents: number;
  closureGroups: number;
  unavailableDates: number;
  ovpsaBatches: number;
  ovpsaRevisions: number;
  reservations: number;
};

const EXPECTED_PREPARED_COUNTS: SchedulingIntegrityPreparedCounts = {
  users: 2,
  coreStudents: 5,
  capacityStudents: CAPACITY_STUDENT_COUNT,
  pairAppointments: 8,
  capacityAppointments: CAPACITY_STUDENT_COUNT,
  importGroups: 1,
  scheduleBatches: 1,
  scheduleItems: 1,
  manualCases: 1,
  rescheduleEvents: 1,
  closureGroups: 1,
  unavailableDates: 1,
  ovpsaBatches: 1,
  ovpsaRevisions: 1,
  reservations: 1,
};

type OwnedManifest = {
  appointmentIds: string[];
  statusLogIds: string[];
  laboratoryResultIds: string[];
  examResultIds: string[];
  submissionIds: string[];
  fileIds: string[];
  storageKeys: string[];
  manualCaseIds: string[];
  rescheduleEventIds: string[];
  calendarRequestIds: string[];
  studentLoginAttemptIds: string[];
  studentEmailVerificationIds: string[];
  staffEmailVerificationIds: string[];
  staffPasswordResetIds: string[];
  notificationIds: string[];
  outboxIds: string[];
  auditLogIds: string[];
};

type FixtureState = {
  databaseIdentity: SchedulingIntegrityDatabaseIdentity;
  storageRoot: string;
  preparedAt: string;
  phase: "PREPARING" | "PREPARED" | "MANIFESTED" | "DATABASE_DELETED" | "STORAGE_DELETED";
  retiredRouteSentinel: RetiredRouteSentinelSnapshot | null;
  manifest: OwnedManifest;
};

export function normalizeSchedulingIntegrityDatabaseIdentity(
  databaseUrl: string | undefined,
): SchedulingIntegrityDatabaseIdentity {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new Error("Scheduling integrity acceptance requires PostgreSQL.");
  }
  return {
    scheme,
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}

export function assertSafeSchedulingIntegrityAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveFlag: string | undefined,
) {
  const identity = normalizeSchedulingIntegrityDatabaseIdentity(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(identity.host)) {
    throw new Error("Scheduling integrity acceptance requires loopback PostgreSQL.");
  }
  if (exclusiveFlag !== "1") {
    throw new Error(
      `Set ${SCHEDULING_INTEGRITY_ACCEPTANCE_FLAG}=1 only for a dedicated local acceptance database.`,
    );
  }
  return identity;
}

export function assertMatchingSchedulingIntegrityDatabaseIdentity(
  current: SchedulingIntegrityDatabaseIdentity,
  persisted: SchedulingIntegrityDatabaseIdentity,
) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) {
    throw new Error(
      "The current database identity does not match the prepared scheduling integrity fixture database.",
    );
  }
}

export function assertSchedulingIntegrityStorageTarget(
  storageRoot: string,
  storageKey: string,
) {
  const root = resolve(storageRoot);
  if (isAbsolute(storageKey) || storageKey.includes("..") || storageKey.includes("\\")) {
    throw new Error("Invalid scheduling integrity storage key.");
  }
  const target = resolve(root, storageKey);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("Invalid scheduling integrity storage key.");
  }
  return target;
}

export function assertZeroSchedulingIntegrityResidue<T extends SchedulingIntegrityResidue>(
  residue: T,
) {
  const remaining = Object.entries(residue).filter(([, count]) => count !== 0);
  if (remaining.length) {
    throw new Error(
      `Scheduling integrity acceptance cleanup residue remains: ${remaining
        .map(([category, count]) => `${category}=${count}`)
        .join(", ")}.`,
    );
  }
  return residue;
}

export function assertSchedulingIntegrityPreparedCounts<
  T extends SchedulingIntegrityPreparedCounts,
>(counts: T) {
  if (JSON.stringify(counts) !== JSON.stringify(EXPECTED_PREPARED_COUNTS)) {
    throw new Error(
      `Scheduling integrity prepared state is incomplete: ${JSON.stringify({
        expected: EXPECTED_PREPARED_COUNTS,
        actual: counts,
      })}.`,
    );
  }
  return counts;
}

export function assertRetiredRouteSentinelUnchanged<T extends RetiredRouteSentinelSnapshot>(
  baseline: T,
  current: RetiredRouteSentinelSnapshot,
) {
  if (JSON.stringify(baseline) !== JSON.stringify(current)) {
    throw new Error(
      `Retired scheduling sentinel changed: ${JSON.stringify({ baseline, current })}.`,
    );
  }
  return baseline;
}

const FORBIDDEN_STATUS_KEYS = new Set([
  "password",
  "passwordhash",
  "dateofbirth",
  "middlename",
  "databaseurl",
  "connectionstring",
  "secret",
  "optimistictoken",
]);

export function assertSafeSchedulingIntegrityStatus<T>(value: T): T {
  const inspect = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) inspect(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_STATUS_KEYS.has(key.replaceAll("_", "").toLowerCase())) {
        throw new Error(`Unsafe credential field in scheduling integrity status: ${key}.`);
      }
      inspect(child);
    }
  };
  inspect(value);
  return value;
}

function emptyManifest(): OwnedManifest {
  return {
    appointmentIds: Object.values(APPOINTMENT_IDS),
    statusLogIds: [],
    laboratoryResultIds: [],
    examResultIds: [],
    submissionIds: [],
    fileIds: [],
    storageKeys: [],
    manualCaseIds: [FIXED_IDS.manualCase],
    rescheduleEventIds: [FIXED_IDS.rescheduleEvent],
    calendarRequestIds: [],
    studentLoginAttemptIds: [],
    studentEmailVerificationIds: [],
    staffEmailVerificationIds: [],
    staffPasswordResetIds: [],
    notificationIds: [],
    outboxIds: [],
    auditLogIds: [],
  };
}

async function fileExists(path: string) {
  try {
    await stat(path);
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

type IdRow = { id: string };

async function queryIds(
  client: PoolClient,
  sql: string,
  parameters: unknown[] = [],
) {
  const result = await client.query<IdRow>(sql, parameters);
  return result.rows.map((row) => row.id);
}

async function retiredRouteSentinelSnapshot(
  client: PoolClient,
): Promise<RetiredRouteSentinelSnapshot> {
  const result = await client.query<{
    import_groups: number;
    batches: number;
    items: number;
    batch_status: string | null;
    item_status: string | null;
    batch_updated_at: Date | null;
    item_updated_at: Date | null;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$1) AS import_groups,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE id=$2) AS batches,
       (SELECT COUNT(*)::int FROM coordinator_schedule_items WHERE id=$3) AS items,
       (SELECT status FROM schedule_batches WHERE id=$2) AS batch_status,
       (SELECT status FROM coordinator_schedule_items WHERE id=$3) AS item_status,
       (SELECT updated_at FROM schedule_batches WHERE id=$2) AS batch_updated_at,
       (SELECT updated_at FROM coordinator_schedule_items WHERE id=$3) AS item_updated_at`,
    [FIXED_IDS.importGroup, FIXED_IDS.scheduleBatch, FIXED_IDS.scheduleItem],
  );
  const row = result.rows[0];
  return {
    importGroups: row.import_groups,
    batches: row.batches,
    items: row.items,
    batchStatus: row.batch_status,
    itemStatus: row.item_status,
    batchUpdatedAt: row.batch_updated_at?.toISOString() ?? null,
    itemUpdatedAt: row.item_updated_at?.toISOString() ?? null,
  };
}

async function preparedCounts(
  client: PoolClient,
): Promise<SchedulingIntegrityPreparedCounts> {
  const result = await client.query<{
    users: number;
    core_students: number;
    capacity_students: number;
    pair_appointments: number;
    capacity_appointments: number;
    import_groups: number;
    schedule_batches: number;
    schedule_items: number;
    manual_cases: number;
    reschedule_events: number;
    closure_groups: number;
    unavailable_dates: number;
    ovpsa_batches: number;
    ovpsa_revisions: number;
    reservations: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=ANY($1::uuid[])) AS users,
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($2::varchar[])) AS core_students,
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($3::varchar[])) AS capacity_students,
       (SELECT COUNT(*)::int FROM appointments WHERE id=ANY($4::uuid[])) AS pair_appointments,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($3::varchar[])) AS capacity_appointments,
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$5) AS import_groups,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE id=$6) AS schedule_batches,
       (SELECT COUNT(*)::int FROM coordinator_schedule_items WHERE id=$7) AS schedule_items,
       (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE id=$8) AS manual_cases,
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE id=$9) AS reschedule_events,
       (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE id=$10) AS closure_groups,
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates WHERE id=$11) AS unavailable_dates,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batches WHERE id=$12) AS ovpsa_batches,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions WHERE id=$13) AS ovpsa_revisions,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations WHERE id=$14) AS reservations`,
    [
      [FIXED_IDS.adminUser, FIXED_IDS.staffUser],
      Object.values(CORE_STUDENTS).map((student) => student.studentNumber),
      CAPACITY_STUDENT_NUMBERS,
      Object.values(APPOINTMENT_IDS),
      FIXED_IDS.importGroup,
      FIXED_IDS.scheduleBatch,
      FIXED_IDS.scheduleItem,
      FIXED_IDS.manualCase,
      FIXED_IDS.rescheduleEvent,
      FIXED_IDS.closureGroup,
      FIXED_IDS.unavailableDate,
      FIXED_IDS.ovpsaBatch,
      FIXED_IDS.ovpsaRevision,
      FIXED_IDS.reservation,
    ],
  );
  const row = result.rows[0];
  return {
    users: row.users,
    coreStudents: row.core_students,
    capacityStudents: row.capacity_students,
    pairAppointments: row.pair_appointments,
    capacityAppointments: row.capacity_appointments,
    importGroups: row.import_groups,
    scheduleBatches: row.schedule_batches,
    scheduleItems: row.schedule_items,
    manualCases: row.manual_cases,
    rescheduleEvents: row.reschedule_events,
    closureGroups: row.closure_groups,
    unavailableDates: row.unavailable_dates,
    ovpsaBatches: row.ovpsa_batches,
    ovpsaRevisions: row.ovpsa_revisions,
    reservations: row.reservations,
  };
}

async function discoverOwnedManifest(
  client: PoolClient,
  preparedAt: string,
): Promise<OwnedManifest> {
  const appointmentIds = await queryIds(
    client,
    "SELECT id::text FROM appointments WHERE student_number=ANY($1::varchar[]) ORDER BY id",
    [ALL_STUDENT_NUMBERS],
  );
  const statusLogIds = await queryIds(
    client,
    "SELECT id::text FROM appointment_status_logs WHERE appointment_id=ANY($1::uuid[]) ORDER BY id",
    [appointmentIds],
  );
  const laboratoryResultIds = await queryIds(
    client,
    `SELECT id::text FROM laboratory_results
      WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
      ORDER BY id`,
    [ALL_STUDENT_NUMBERS, appointmentIds],
  );
  const examResultIds = await queryIds(
    client,
    `SELECT id::text FROM exam_results
      WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
      ORDER BY id`,
    [ALL_STUDENT_NUMBERS, appointmentIds],
  );
  const submissionIds = await queryIds(
    client,
    `SELECT id::text FROM student_result_submissions
      WHERE student_number=ANY($1::varchar[]) OR appointment_id=ANY($2::uuid[])
      ORDER BY id`,
    [ALL_STUDENT_NUMBERS, appointmentIds],
  );
  const files = await client.query<{ id: string; storage_key: string }>(
    `SELECT id::text,storage_key FROM student_result_files
      WHERE submission_id=ANY($1::uuid[]) ORDER BY id`,
    [submissionIds],
  );
  const manualCaseIds = await queryIds(
    client,
    `SELECT id::text FROM clinic_closure_manual_cases
      WHERE student_number=ANY($1::varchar[]) OR id=$2 ORDER BY id`,
    [ALL_STUDENT_NUMBERS, FIXED_IDS.manualCase],
  );
  const rescheduleEventIds = await queryIds(
    client,
    `SELECT id::text FROM appointment_reschedule_events
      WHERE student_number=ANY($1::varchar[]) OR id=$2 ORDER BY id`,
    [ALL_STUDENT_NUMBERS, FIXED_IDS.rescheduleEvent],
  );
  const calendarRequestIds = await queryIds(
    client,
    `SELECT request_id::text AS id FROM clinic_calendar_requests
      WHERE created_by=ANY($1::uuid[]) AND created_at >= $2::timestamptz ORDER BY request_id`,
    [[FIXED_IDS.adminUser, FIXED_IDS.staffUser], preparedAt],
  );
  const studentLoginAttemptIds = await queryIds(
    client,
    "SELECT id::text FROM student_login_attempts WHERE student_number=ANY($1::varchar[]) ORDER BY id",
    [ALL_STUDENT_NUMBERS],
  );
  const studentEmailVerificationIds = await queryIds(
    client,
    "SELECT id::text FROM student_email_verifications WHERE student_number=ANY($1::varchar[]) ORDER BY id",
    [ALL_STUDENT_NUMBERS],
  );
  const staffEmailVerificationIds = await queryIds(
    client,
    "SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[]) ORDER BY id",
    [[FIXED_IDS.adminUser, FIXED_IDS.staffUser]],
  );
  const staffPasswordResetIds = await queryIds(
    client,
    "SELECT id::text FROM staff_password_resets WHERE user_id=ANY($1::uuid[]) ORDER BY id",
    [[FIXED_IDS.adminUser, FIXED_IDS.staffUser]],
  );
  const notificationIds = await queryIds(
    client,
    "SELECT id::text FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) ORDER BY id",
    [ALL_STUDENT_NUMBERS],
  );
  const outboxIds = await queryIds(
    client,
    `SELECT id::text FROM email_outbox
      WHERE student_number=ANY($1::varchar[])
         OR LOWER(BTRIM(to_email))=ANY($2::varchar[])
         OR source_id=ANY($3::text[])
      ORDER BY id`,
    [
      ALL_STUDENT_NUMBERS,
      [SCHEDULING_INTEGRITY_FIXTURE.admin.email, SCHEDULING_INTEGRITY_FIXTURE.staff.email],
      [FIXED_IDS.adminUser, FIXED_IDS.staffUser],
    ],
  );
  const ownedEntityIds = [
    ...appointmentIds,
    ...submissionIds,
    ...files.rows.map((row) => row.id),
    ...manualCaseIds,
    ...rescheduleEventIds,
    FIXED_IDS.importGroup,
    FIXED_IDS.scheduleBatch,
    FIXED_IDS.scheduleItem,
    FIXED_IDS.closureGroup,
    FIXED_IDS.unavailableDate,
    FIXED_IDS.ovpsaBatch,
    FIXED_IDS.ovpsaRevision,
    FIXED_IDS.reservation,
  ];
  const auditLogIds = await queryIds(
    client,
    `SELECT id::text FROM audit_logs
      WHERE actor_user_id=ANY($1::uuid[])
         OR entity_id=ANY($2::text[])
         OR metadata->>'studentNumber'=ANY($3::text[])
         OR metadata::text LIKE $4
      ORDER BY id`,
    [
      [FIXED_IDS.adminUser, FIXED_IDS.staffUser],
      ownedEntityIds,
      ALL_STUDENT_NUMBERS,
      `%${MARKER}%`,
    ],
  );
  return {
    appointmentIds,
    statusLogIds,
    laboratoryResultIds,
    examResultIds,
    submissionIds,
    fileIds: files.rows.map((row) => row.id),
    storageKeys: files.rows.map((row) => row.storage_key),
    manualCaseIds,
    rescheduleEventIds,
    calendarRequestIds,
    studentLoginAttemptIds,
    studentEmailVerificationIds,
    staffEmailVerificationIds,
    staffPasswordResetIds,
    notificationIds,
    outboxIds,
    auditLogIds,
  };
}

async function schedulingIntegrityResidue(
  client: PoolClient,
  manifest: OwnedManifest,
): Promise<SchedulingIntegrityResidue> {
  const result = await client.query<Omit<
    SchedulingIntegrityResidue,
    "storageFiles" | "stateFiles"
  >>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=ANY($1::uuid[])) AS users,
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($2::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM colleges WHERE id=$3) AS colleges,
       (SELECT COUNT(*)::int FROM programs WHERE id=$4) AS programs,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($2::varchar[]) OR id=ANY($5::uuid[])) AS appointments,
       (SELECT COUNT(*)::int FROM appointment_status_logs WHERE appointment_id=ANY($5::uuid[]) OR id=ANY($6::uuid[])) AS "appointmentStatusLogs",
       (SELECT COUNT(*)::int FROM laboratory_results WHERE student_number=ANY($2::varchar[]) OR id=ANY($7::uuid[])) AS "laboratoryResults",
       (SELECT COUNT(*)::int FROM exam_results WHERE student_number=ANY($2::varchar[]) OR id=ANY($8::uuid[])) AS "examResults",
       (SELECT COUNT(*)::int FROM student_result_submissions WHERE student_number=ANY($2::varchar[]) OR id=ANY($9::uuid[])) AS "resultSubmissions",
       (SELECT COUNT(*)::int FROM student_result_files WHERE id=ANY($10::uuid[]) OR submission_id=ANY($9::uuid[])) AS "resultFiles",
       (SELECT COUNT(*)::int FROM student_result_storage_cleanup_intents WHERE storage_key=ANY($31::text[])) AS "storageCleanupIntents",
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$11) AS "importGroups",
       (SELECT COUNT(*)::int FROM schedule_batches WHERE id=$12) AS "scheduleBatches",
       (SELECT COUNT(*)::int FROM coordinator_schedule_items WHERE id=$13) AS "scheduleItems",
       (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number=ANY($2::varchar[]) OR id=ANY($14::uuid[])) AS "manualCases",
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=ANY($2::varchar[]) OR id=ANY($15::uuid[])) AS "rescheduleEvents",
       (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE id=$16 OR reason LIKE $17) AS "closureGroups",
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates WHERE closure_group_id=$16 OR id=$18) AS "unavailableDates",
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batches WHERE id=$19) AS "ovpsaBatches",
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions WHERE id=$20) AS "ovpsaRevisions",
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations WHERE id=$21) AS reservations,
       (SELECT COUNT(*)::int FROM clinic_calendar_requests WHERE request_id=ANY($22::uuid[])) AS "calendarRequests",
       (SELECT COUNT(*)::int FROM student_login_attempts WHERE student_number=ANY($2::varchar[]) OR id=ANY($23::uuid[])) AS "studentLoginAttempts",
       (SELECT COUNT(*)::int FROM student_email_verifications WHERE student_number=ANY($2::varchar[]) OR id=ANY($24::uuid[])) AS "studentEmailVerifications",
       (SELECT COUNT(*)::int FROM staff_email_verifications WHERE user_id=ANY($1::uuid[]) OR id=ANY($25::uuid[])) AS "staffEmailVerifications",
       (SELECT COUNT(*)::int FROM staff_password_resets WHERE user_id=ANY($1::uuid[]) OR id=ANY($26::uuid[])) AS "staffPasswordResets",
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=ANY($2::varchar[]) OR id=ANY($27::uuid[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=ANY($2::varchar[]) OR id=ANY($28::uuid[]) OR LOWER(BTRIM(to_email))=ANY($29::varchar[])) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs WHERE id=ANY($30::uuid[]) OR actor_user_id=ANY($1::uuid[]) OR metadata->>'studentNumber'=ANY($2::text[]) OR metadata::text LIKE $17) AS "auditLogs"`,
    [
      [FIXED_IDS.adminUser, FIXED_IDS.staffUser],
      ALL_STUDENT_NUMBERS,
      FIXED_IDS.college,
      FIXED_IDS.program,
      manifest.appointmentIds,
      manifest.statusLogIds,
      manifest.laboratoryResultIds,
      manifest.examResultIds,
      manifest.submissionIds,
      manifest.fileIds,
      FIXED_IDS.importGroup,
      FIXED_IDS.scheduleBatch,
      FIXED_IDS.scheduleItem,
      manifest.manualCaseIds,
      manifest.rescheduleEventIds,
      FIXED_IDS.closureGroup,
      `%${MARKER}%`,
      FIXED_IDS.unavailableDate,
      FIXED_IDS.ovpsaBatch,
      FIXED_IDS.ovpsaRevision,
      FIXED_IDS.reservation,
      manifest.calendarRequestIds,
      manifest.studentLoginAttemptIds,
      manifest.studentEmailVerificationIds,
      manifest.staffEmailVerificationIds,
      manifest.staffPasswordResetIds,
      manifest.notificationIds,
      manifest.outboxIds,
      [SCHEDULING_INTEGRITY_FIXTURE.admin.email, SCHEDULING_INTEGRITY_FIXTURE.staff.email],
      manifest.auditLogIds,
      manifest.storageKeys,
    ],
  );
  const storageTargets = manifest.storageKeys.map((key) =>
    assertSchedulingIntegrityStorageTarget(STORAGE_ROOT, key));
  return {
    ...result.rows[0],
    storageFiles: (await Promise.all(storageTargets.map(fileExists))).filter(Boolean).length,
    stateFiles: await fileExists(STATE_FILE) ? 1 : 0,
  };
}

async function setup(
  client: PoolClient,
  databaseIdentity: SchedulingIntegrityDatabaseIdentity,
) {
  if (await readState()) {
    throw new Error(
      "A scheduling integrity fixture state already exists. Run acceptance:scheduling-integrity:cleanup first.",
    );
  }
  assertZeroSchedulingIntegrityResidue(
    await schedulingIntegrityResidue(client, emptyManifest()),
  );
  const references = await client.query<{
    clinics: number;
    academic_years: number;
    closing_date: string | null;
    today: string;
    pe_capacity: number | null;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM clinics WHERE id=ANY($1::uuid[])) AS clinics,
       (SELECT COUNT(*)::int FROM academic_years WHERE start_year=2026) AS academic_years,
       (SELECT closing_date::text FROM academic_years WHERE start_year=2026) AS closing_date,
       (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today,
       (SELECT max_daily_capacity FROM clinic_capacity_settings
         WHERE clinic_id=$2 AND schedule_type='PHYSICAL_EXAM' AND is_active=TRUE) AS pe_capacity`,
    [[LABORATORY_CLINIC_ID, PHYSICAL_EXAM_CLINIC_ID], PHYSICAL_EXAM_CLINIC_ID],
  );
  const reference = references.rows[0];
  if (
    reference.clinics !== 2
    || reference.academic_years !== 1
    || !reference.closing_date
    || reference.closing_date < DATES.capacityFull
    || reference.pe_capacity !== CAPACITY_STUDENT_COUNT
  ) {
    throw new Error(
      `Required clinics, 2026 scheduling cycle, or Physical Examination capacity are unavailable: ${JSON.stringify(reference)}.`,
    );
  }
  if (DATES.lifecycleLaboratory <= reference.today) {
    throw new Error(
      `The fixed acceptance dates are no longer future Manila dates (today is ${reference.today}).`,
    );
  }
  const collisions = await client.query<{
    appointments: number;
    closures: number;
    reservations: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM appointments
         WHERE appointment_date=ANY($1::date[])
           AND is_published=TRUE
           AND status NOT IN ('RESCHEDULED','CANCELLED')) AS appointments,
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates
         WHERE blocked_date=$2 AND reopened_at IS NULL) AS closures,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
         WHERE schedule_type='PHYSICAL_EXAM' AND reservation_date=$3
           AND status IN ('ACTIVE','INVALIDATED') AND reservation_kind='EXCLUSIVE') AS reservations`,
    [Object.values(DATES), DATES.blockedClosure, DATES.exclusiveReservation],
  );
  if (Object.values(collisions.rows[0]).some((count) => count !== 0)) {
    throw new Error(
      `Scheduling integrity acceptance dates are not exclusive: ${JSON.stringify(collisions.rows[0])}.`,
    );
  }

  const preparedAt = new Date().toISOString();
  let state: FixtureState = {
    databaseIdentity,
    storageRoot: STORAGE_ROOT,
    preparedAt,
    phase: "PREPARING",
    retiredRouteSentinel: null,
    manifest: emptyManifest(),
  };
  await writeState(state);
  const [adminPasswordHash, staffPasswordHash] = await Promise.all([
    bcrypt.hash(SCHEDULING_INTEGRITY_ADMIN_PASSWORD, 4),
    bcrypt.hash(SCHEDULING_INTEGRITY_STAFF_PASSWORD, 4),
  ]);

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO colleges (id,code,name)
       VALUES ($1,'BSIH','Browser Scheduling Integrity College')`,
      [FIXED_IDS.college],
    );
    await client.query(
      `INSERT INTO programs (id,college_id,code,name)
       VALUES ($1,$2,'BSIH','Browser Scheduling Integrity Program')`,
      [FIXED_IDS.program, FIXED_IDS.college],
    );
    await client.query(
      `INSERT INTO users (
         id,full_name,email,password_hash,role,clinic_id,email_verified_at,
         must_change_password,credential_version
       ) VALUES
         ($1,'Browser Scheduling Integrity Admin',$2,$3,'ADMIN',NULL,clock_timestamp(),FALSE,1),
         ($4,'Browser Scheduling Integrity Staff',$5,$6,'CLINIC_STAFF',$7,clock_timestamp(),FALSE,1)`,
      [
        FIXED_IDS.adminUser,
        SCHEDULING_INTEGRITY_FIXTURE.admin.email,
        adminPasswordHash,
        FIXED_IDS.staffUser,
        SCHEDULING_INTEGRITY_FIXTURE.staff.email,
        staffPasswordHash,
        LABORATORY_CLINIC_ID,
      ],
    );
    const coreStudents = [
      {
        student_number: CORE_STUDENTS.lifecycle.studentNumber,
        first_name: "Lifecycle",
        middle_name: "Integrity",
        last_name: "Browser",
        date_of_birth: "2004-05-02",
        email: "browser-sih-life@example.test",
      },
      {
        student_number: CORE_STUDENTS.manual.studentNumber,
        first_name: "Manual",
        middle_name: "Integrity",
        last_name: "Browser",
        date_of_birth: "2004-05-03",
        email: "browser-sih-manual@example.test",
      },
      {
        student_number: CORE_STUDENTS.displacement.studentNumber,
        first_name: "Displacement",
        middle_name: "Integrity",
        last_name: "Browser",
        date_of_birth: "2004-05-04",
        email: "browser-sih-displacement@example.test",
      },
      {
        student_number: CORE_STUDENTS.portal.studentNumber,
        first_name: "Portal",
        middle_name: SCHEDULING_INTEGRITY_PORTAL_MIDDLE_NAME,
        last_name: "Browser",
        date_of_birth: SCHEDULING_INTEGRITY_PORTAL_DATE_OF_BIRTH,
        email: "browser-sih-portal@example.test",
      },
      {
        student_number: CORE_STUDENTS.legacySentinel.studentNumber,
        first_name: "Legacy",
        middle_name: "Integrity",
        last_name: "Browser",
        date_of_birth: "2004-05-07",
        email: "browser-sih-legacy@example.test",
      },
    ];
    await client.query(
      `INSERT INTO students (
         student_number,first_name,middle_name,last_name,college_id,program_id,
         year_level,date_of_birth,email,email_verified_at,is_active
       ) SELECT row.student_number,row.first_name,row.middle_name,row.last_name,$2,$3,
                4,row.date_of_birth,row.email,clock_timestamp(),TRUE
           FROM jsonb_to_recordset($1::jsonb) AS row(
             student_number varchar,first_name varchar,middle_name varchar,
             last_name varchar,date_of_birth date,email varchar
           )`,
      [JSON.stringify(coreStudents), FIXED_IDS.college, FIXED_IDS.program],
    );
    await client.query(
      `INSERT INTO students (
         student_number,first_name,middle_name,last_name,college_id,program_id,
         year_level,date_of_birth,is_active
       ) SELECT row.student_number,'Capacity',row.position::text,'Browser',$2,$3,
                4,'2004-06-01',TRUE
           FROM jsonb_to_recordset($1::jsonb) AS row(
             student_number varchar,position integer
           )`,
      [
        JSON.stringify(CAPACITY_STUDENT_NUMBERS.map((studentNumber, index) => ({
          student_number: studentNumber,
          position: index + 1,
        }))),
        FIXED_IDS.college,
        FIXED_IDS.program,
      ],
    );
    await client.query(
      `INSERT INTO schedule_import_groups (
         id,import_name,source_filename,total_rows,matched_student_count,
         description,created_by,student_category,academic_year_start,accepted_at,import_mode
       ) VALUES ($1,$2::varchar,'browser-scheduling-integrity.csv',1,1,$2::text,$3,'REGULAR',2026,
                 '2026-08-26T00:00:00.000Z','STANDARD')`,
      [FIXED_IDS.importGroup, MARKER, FIXED_IDS.adminUser],
    );
    await client.query(
      `INSERT INTO schedule_batches (
         id,clinic_id,batch_name,college_id,program_id,status,created_by,import_group_id
       ) VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7)`,
      [
        FIXED_IDS.scheduleBatch,
        LABORATORY_CLINIC_ID,
        MARKER,
        FIXED_IDS.college,
        FIXED_IDS.program,
        FIXED_IDS.adminUser,
        FIXED_IDS.importGroup,
      ],
    );
    await client.query(
      `INSERT INTO coordinator_schedule_items (
         id,batch_id,clinic_id,student_number,schedule_type,target_date,
         remarks,status,source_row_order,schedule_cycle_start
       ) VALUES ($1,$2,$3,$4,'LABORATORY',$5,$6,'PENDING',2,2026)`,
      [
        FIXED_IDS.scheduleItem,
        FIXED_IDS.scheduleBatch,
        LABORATORY_CLINIC_ID,
        CORE_STUDENTS.legacySentinel.studentNumber,
        DATES.lifecycleLaboratory,
        MARKER,
      ],
    );

    const pairAppointments = [
      {
        id: APPOINTMENT_IDS.lifecycleLaboratory,
        clinic_id: LABORATORY_CLINIC_ID,
        student_number: CORE_STUDENTS.lifecycle.studentNumber,
        schedule_type: "LABORATORY",
        appointment_date: DATES.lifecycleLaboratory,
        status: "PENDING",
        pair_id: PAIR_IDS.lifecycle,
        source_order: 1,
      },
      {
        id: APPOINTMENT_IDS.lifecyclePhysicalExam,
        clinic_id: PHYSICAL_EXAM_CLINIC_ID,
        student_number: CORE_STUDENTS.lifecycle.studentNumber,
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: DATES.lifecyclePhysicalExam,
        status: "PENDING",
        pair_id: PAIR_IDS.lifecycle,
        source_order: 1,
      },
      {
        id: APPOINTMENT_IDS.manualLaboratory,
        clinic_id: LABORATORY_CLINIC_ID,
        student_number: CORE_STUDENTS.manual.studentNumber,
        schedule_type: "LABORATORY",
        appointment_date: DATES.manualLaboratory,
        status: "COMPLETED",
        pair_id: PAIR_IDS.manual,
        source_order: 2,
      },
      {
        id: APPOINTMENT_IDS.manualPhysicalExam,
        clinic_id: PHYSICAL_EXAM_CLINIC_ID,
        student_number: CORE_STUDENTS.manual.studentNumber,
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: DATES.manualPhysicalExam,
        status: "PENDING",
        pair_id: PAIR_IDS.manual,
        source_order: 2,
      },
      {
        id: APPOINTMENT_IDS.displacementLaboratory,
        clinic_id: LABORATORY_CLINIC_ID,
        student_number: CORE_STUDENTS.displacement.studentNumber,
        schedule_type: "LABORATORY",
        appointment_date: DATES.displacementLaboratory,
        status: "AWAITING_RESCHEDULE",
        pair_id: PAIR_IDS.displacement,
        source_order: 3,
      },
      {
        id: APPOINTMENT_IDS.displacementPhysicalExam,
        clinic_id: PHYSICAL_EXAM_CLINIC_ID,
        student_number: CORE_STUDENTS.displacement.studentNumber,
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: DATES.displacementPhysicalExam,
        status: "AWAITING_RESCHEDULE",
        pair_id: PAIR_IDS.displacement,
        source_order: 3,
      },
      {
        id: APPOINTMENT_IDS.portalLaboratory,
        clinic_id: LABORATORY_CLINIC_ID,
        student_number: CORE_STUDENTS.portal.studentNumber,
        schedule_type: "LABORATORY",
        appointment_date: DATES.portalLaboratory,
        status: "PENDING",
        pair_id: PAIR_IDS.portal,
        source_order: 4,
      },
      {
        id: APPOINTMENT_IDS.portalPhysicalExam,
        clinic_id: PHYSICAL_EXAM_CLINIC_ID,
        student_number: CORE_STUDENTS.portal.studentNumber,
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: DATES.portalPhysicalExam,
        status: "PENDING",
        pair_id: PAIR_IDS.portal,
        source_order: 4,
      },
    ];
    await client.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,scheduling_window_start,
         scheduling_window_end,notes
       ) SELECT row.id,row.clinic_id,row.student_number,row.schedule_type,row.appointment_date,
                row.status,TRUE,row.pair_id,2026,$2,$2,'REGULAR',
                '2026-08-26T00:00:00.000Z',row.source_order,'2026-08-01','2027-03-31',$3
           FROM jsonb_to_recordset($1::jsonb) AS row(
             id uuid,clinic_id uuid,student_number varchar,schedule_type varchar,
             appointment_date date,status varchar,pair_id uuid,source_order integer
           )`,
      [JSON.stringify(pairAppointments), FIXED_IDS.adminUser, MARKER],
    );
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,scheduling_window_start,
         scheduling_window_end,notes
       ) SELECT $2,row.student_number,'PHYSICAL_EXAM',$3,'PENDING',TRUE,
                gen_random_uuid(),2026,$4,$4,'REGULAR','2026-08-26T00:00:00.000Z',
                row.source_order,'2026-08-01','2027-03-31',$5
           FROM jsonb_to_recordset($1::jsonb) AS row(
             student_number varchar,source_order integer
           )`,
      [
        JSON.stringify(CAPACITY_STUDENT_NUMBERS.map((studentNumber, index) => ({
          student_number: studentNumber,
          source_order: index + 100,
        }))),
        PHYSICAL_EXAM_CLINIC_ID,
        DATES.capacityFull,
        FIXED_IDS.adminUser,
        MARKER,
      ],
    );
    await client.query(
      `INSERT INTO clinic_closure_groups (
         id,start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ($1,$2,$2,'CLOSURE',$3,$4,$1)`,
      [FIXED_IDS.closureGroup, DATES.blockedClosure, MARKER, FIXED_IDS.adminUser],
    );
    await client.query(
      `INSERT INTO clinic_unavailable_dates (id,closure_group_id,blocked_date)
       VALUES ($1,$2,$3)`,
      [FIXED_IDS.unavailableDate, FIXED_IDS.closureGroup, DATES.blockedClosure],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batches (
         id,schedule_cycle_start,college_id,status,created_by,updated_by
       ) VALUES ($1,2026,$2,'DRAFT',$3,$3)`,
      [FIXED_IDS.ovpsaBatch, FIXED_IDS.college, FIXED_IDS.adminUser],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         id,batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by
       ) VALUES ($1,$2,1,'DRAFT',$3,$4,$5)`,
      [
        FIXED_IDS.ovpsaRevision,
        FIXED_IDS.ovpsaBatch,
        DATES.manualValidReplacement,
        DATES.exclusiveReservation,
        FIXED_IDS.adminUser,
      ],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_service_reservations (
         id,batch_id,revision_id,schedule_type,reservation_date,status,
         reservation_kind,created_by
       ) VALUES ($1,$2,$3,'PHYSICAL_EXAM',$4,'ACTIVE','EXCLUSIVE',$5)`,
      [
        FIXED_IDS.reservation,
        FIXED_IDS.ovpsaBatch,
        FIXED_IDS.ovpsaRevision,
        DATES.exclusiveReservation,
        FIXED_IDS.adminUser,
      ],
    );
    await client.query(
      `INSERT INTO clinic_closure_manual_cases (
         id,student_number,case_source,closure_group_id,schedule_pair_id,
         schedule_cycle_start,affected_laboratory_appointment_id,
         affected_physical_exam_appointment_id,reason_code,reason_message,policy_metadata
       ) VALUES ($1,$2,'AUTOMATIC_DISPLACEMENT',NULL,$3,2026,$4,$5,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',
                 'No valid replacement remained within the scheduling cycle.',
                 jsonb_build_object('marker',$6::text,'sourceImportGroupId',$7::text))`,
      [
        FIXED_IDS.manualCase,
        CORE_STUDENTS.displacement.studentNumber,
        PAIR_IDS.displacement,
        APPOINTMENT_IDS.displacementLaboratory,
        APPOINTMENT_IDS.displacementPhysicalExam,
        MARKER,
        FIXED_IDS.importGroup,
      ],
    );
    await client.query(
      `INSERT INTO appointment_reschedule_events (
         id,student_number,schedule_pair_id,cause,source_import_group_id,
         old_laboratory_appointment_id,old_physical_exam_appointment_id,actor_user_id,
         schedule_cycle_start,strategy,outcome,manual_case_id,policy_reason_code,policy_metadata
       ) VALUES ($1,$2,$3,'PRIORITY_DISPLACEMENT',$4,$5,$6,$7,2026,
                 'MANUAL_RESOLUTION_REQUIRED','AWAITING_RESCHEDULE',$8,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE',jsonb_build_object('marker',$9::text))`,
      [
        FIXED_IDS.rescheduleEvent,
        CORE_STUDENTS.displacement.studentNumber,
        PAIR_IDS.displacement,
        FIXED_IDS.importGroup,
        APPOINTMENT_IDS.displacementLaboratory,
        APPOINTMENT_IDS.displacementPhysicalExam,
        FIXED_IDS.adminUser,
        FIXED_IDS.manualCase,
        MARKER,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const retiredRouteSentinel = await retiredRouteSentinelSnapshot(client);
  assertRetiredRouteSentinelUnchanged({
    ...retiredRouteSentinel,
    importGroups: 1,
    batches: 1,
    items: 1,
    batchStatus: "DRAFT",
    itemStatus: "PENDING",
  }, retiredRouteSentinel);
  const counts = assertSchedulingIntegrityPreparedCounts(await preparedCounts(client));
  state = {
    ...state,
    phase: "PREPARED",
    retiredRouteSentinel,
  };
  await writeState(state);
  return assertSafeSchedulingIntegrityStatus({
    mode: "setup" as const,
    phase: state.phase,
    databaseIdentity,
    fixture: SCHEDULING_INTEGRITY_FIXTURE,
    preparedCounts: counts,
    retiredRouteSentinel: { unchanged: true, snapshot: retiredRouteSentinel },
  });
}

async function status(
  client: PoolClient,
  databaseIdentity: SchedulingIntegrityDatabaseIdentity,
) {
  const state = await readState();
  if (!state) {
    throw new Error("Run acceptance:scheduling-integrity:setup before requesting status.");
  }
  assertMatchingSchedulingIntegrityDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) {
    throw new Error("RESULT_UPLOAD_ROOT does not match the prepared scheduling integrity fixture.");
  }
  if (state.phase === "PREPARING" || !state.retiredRouteSentinel) {
    throw new Error(
      "Scheduling integrity setup did not finish. Run acceptance:scheduling-integrity:cleanup before retrying setup.",
    );
  }
  const currentSentinel = await retiredRouteSentinelSnapshot(client);
  assertRetiredRouteSentinelUnchanged(state.retiredRouteSentinel, currentSentinel);
  const manifest = state.phase === "PREPARED"
    ? await discoverOwnedManifest(client, state.preparedAt)
    : state.manifest;
  const appointments = await client.query<{
    id: string;
    student_number: string;
    schedule_type: string;
    appointment_date: string;
    status: string;
    is_published: boolean;
    rescheduled_from: string | null;
    updated_at: Date;
  }>(
    `SELECT id::text,student_number,schedule_type,appointment_date::text,status,is_published,
            rescheduled_from::text,updated_at
       FROM appointments
      WHERE student_number=ANY($1::varchar[])
      ORDER BY student_number,created_at,id`,
    [Object.values(CORE_STUDENTS).map((student) => student.studentNumber)],
  );
  const manualCases = await client.query<{
    id: string;
    student_number: string;
    case_source: string;
    status: string;
    reason_code: string;
    resolution_action: string | null;
    updated_at: Date;
  }>(
    `SELECT id::text,student_number,case_source,status,reason_code,
            resolution_action,updated_at
       FROM clinic_closure_manual_cases
      WHERE student_number=ANY($1::varchar[])
      ORDER BY created_at,id`,
    [ALL_STUDENT_NUMBERS],
  );
  const serviceStates = await client.query<{
    manila_today: string;
    closure_active: number;
    reservation_active: number;
    owned_capacity_load: number;
    total_capacity_load: number;
  }>(
    `SELECT
       (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS manila_today,
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates
         WHERE id=$1 AND reopened_at IS NULL) AS closure_active,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
         WHERE id=$2 AND status='ACTIVE' AND reservation_kind='EXCLUSIVE') AS reservation_active,
       (SELECT COUNT(*)::int FROM appointments
         WHERE student_number=ANY($3::varchar[]) AND schedule_type='PHYSICAL_EXAM'
           AND appointment_date=$4 AND is_published=TRUE
           AND status NOT IN ('RESCHEDULED','CANCELLED')) AS owned_capacity_load,
       (SELECT COUNT(*)::int FROM appointments
         WHERE clinic_id=$5 AND schedule_type='PHYSICAL_EXAM'
           AND appointment_date=$4 AND is_published=TRUE
           AND status NOT IN ('RESCHEDULED','CANCELLED')) AS total_capacity_load`,
    [
      FIXED_IDS.unavailableDate,
      FIXED_IDS.reservation,
      CAPACITY_STUDENT_NUMBERS,
      DATES.capacityFull,
      PHYSICAL_EXAM_CLINIC_ID,
    ],
  );
  const serviceState = serviceStates.rows[0];
  return assertSafeSchedulingIntegrityStatus({
    mode: "status" as const,
    databaseIdentity,
    phase: state.phase,
    fixture: SCHEDULING_INTEGRITY_FIXTURE,
    invalidManualDestinations: {
      today: serviceState.manila_today,
      closure: DATES.blockedClosure,
      reservation: DATES.exclusiveReservation,
      capacity: DATES.capacityFull,
    },
    validManualDestination: DATES.manualValidReplacement,
    automaticDisplacementResolution: {
      laboratoryDate: DATES.displacementReplacementLaboratory,
      physicalExamDate: DATES.displacementReplacementPhysicalExam,
    },
    serviceStates: {
      closureActive: serviceState.closure_active,
      exclusiveReservationActive: serviceState.reservation_active,
      ownedCapacityLoad: serviceState.owned_capacity_load,
      totalCapacityLoad: serviceState.total_capacity_load,
      maximumCapacity: CAPACITY_STUDENT_COUNT,
    },
    retiredRouteSentinel: {
      unchanged: true,
      snapshot: currentSentinel,
    },
    appointments: appointments.rows.map((appointment) => ({
      id: appointment.id,
      studentNumber: appointment.student_number,
      scheduleType: appointment.schedule_type,
      appointmentDate: appointment.appointment_date,
      status: appointment.status,
      isPublished: appointment.is_published,
      rescheduledFrom: appointment.rescheduled_from,
      updatedAt: appointment.updated_at.toISOString(),
    })),
    manualCases: manualCases.rows.map((manualCase) => ({
      id: manualCase.id,
      studentNumber: manualCase.student_number,
      caseSource: manualCase.case_source,
      status: manualCase.status,
      reasonCode: manualCase.reason_code,
      resolutionAction: manualCase.resolution_action,
      updatedAt: manualCase.updated_at.toISOString(),
    })),
    counts: {
      students: ALL_STUDENT_NUMBERS.length,
      ownedAppointments: manifest.appointmentIds.length,
      manualCases: manifest.manualCaseIds.length,
      rescheduleEvents: manifest.rescheduleEventIds.length,
      notifications: manifest.notificationIds.length,
      outbox: manifest.outboxIds.length,
      audits: manifest.auditLogIds.length,
    },
    residue: await schedulingIntegrityResidue(client, manifest),
  });
}

async function deleteOwnedDatabaseRows(
  client: PoolClient,
  manifest: OwnedManifest,
) {
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM audit_logs WHERE id=ANY($1::uuid[])",
      [manifest.auditLogIds],
    );
    await client.query(
      "DELETE FROM email_outbox WHERE id=ANY($1::uuid[])",
      [manifest.outboxIds],
    );
    await client.query(
      "DELETE FROM student_portal_notifications WHERE id=ANY($1::uuid[])",
      [manifest.notificationIds],
    );
    await client.query(
      "DELETE FROM staff_email_verifications WHERE id=ANY($1::uuid[])",
      [manifest.staffEmailVerificationIds],
    );
    await client.query(
      "DELETE FROM staff_password_resets WHERE id=ANY($1::uuid[])",
      [manifest.staffPasswordResetIds],
    );
    await client.query(
      "DELETE FROM student_email_verifications WHERE id=ANY($1::uuid[])",
      [manifest.studentEmailVerificationIds],
    );
    await client.query(
      "DELETE FROM student_login_attempts WHERE id=ANY($1::uuid[])",
      [manifest.studentLoginAttemptIds],
    );
    await client.query(
      "DELETE FROM appointment_reschedule_event_unavailable_dates WHERE event_id=ANY($1::uuid[])",
      [manifest.rescheduleEventIds],
    );
    await client.query(
      "DELETE FROM appointment_reschedule_events WHERE id=ANY($1::uuid[])",
      [manifest.rescheduleEventIds],
    );
    await client.query(
      "DELETE FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])",
      [manifest.manualCaseIds],
    );
    await client.query(
      "DELETE FROM student_result_storage_cleanup_intents WHERE storage_key=ANY($1::text[])",
      [manifest.storageKeys],
    );
    await client.query(
      "DELETE FROM student_result_files WHERE id=ANY($1::uuid[])",
      [manifest.fileIds],
    );
    await client.query(
      "DELETE FROM student_result_submissions WHERE id=ANY($1::uuid[])",
      [manifest.submissionIds],
    );
    await client.query(
      "DELETE FROM exam_results WHERE id=ANY($1::uuid[])",
      [manifest.examResultIds],
    );
    await client.query(
      "DELETE FROM laboratory_results WHERE id=ANY($1::uuid[])",
      [manifest.laboratoryResultIds],
    );
    await client.query(
      "DELETE FROM appointment_status_logs WHERE id=ANY($1::uuid[])",
      [manifest.statusLogIds],
    );
    await client.query(
      "DELETE FROM appointments WHERE id=ANY($1::uuid[])",
      [manifest.appointmentIds],
    );
    await client.query(
      "DELETE FROM coordinator_schedule_items WHERE id=$1",
      [FIXED_IDS.scheduleItem],
    );
    await client.query(
      "DELETE FROM schedule_batches WHERE id=$1",
      [FIXED_IDS.scheduleBatch],
    );
    await client.query(
      "DELETE FROM ovpsa_first_year_service_reservations WHERE id=$1",
      [FIXED_IDS.reservation],
    );
    await client.query(
      "DELETE FROM ovpsa_first_year_batch_revisions WHERE id=$1",
      [FIXED_IDS.ovpsaRevision],
    );
    await client.query(
      "DELETE FROM ovpsa_first_year_batches WHERE id=$1",
      [FIXED_IDS.ovpsaBatch],
    );
    await client.query(
      "DELETE FROM schedule_import_groups WHERE id=$1",
      [FIXED_IDS.importGroup],
    );
    await client.query(
      "DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])",
      [manifest.calendarRequestIds],
    );
    await client.query(
      "DELETE FROM clinic_unavailable_dates WHERE id=$1",
      [FIXED_IDS.unavailableDate],
    );
    await client.query(
      "DELETE FROM clinic_closure_groups WHERE id=$1",
      [FIXED_IDS.closureGroup],
    );
    await client.query(
      "DELETE FROM students WHERE student_number=ANY($1::varchar[])",
      [ALL_STUDENT_NUMBERS],
    );
    await client.query(
      "DELETE FROM programs WHERE id=$1",
      [FIXED_IDS.program],
    );
    await client.query(
      "DELETE FROM colleges WHERE id=$1",
      [FIXED_IDS.college],
    );
    await client.query(
      "DELETE FROM users WHERE id=ANY($1::uuid[])",
      [[FIXED_IDS.adminUser, FIXED_IDS.staffUser]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function deleteOwnedStorage(manifest: OwnedManifest) {
  for (const storageKey of manifest.storageKeys) {
    await rm(assertSchedulingIntegrityStorageTarget(STORAGE_ROOT, storageKey), {
      force: true,
    });
  }
  for (const submissionId of manifest.submissionIds) {
    const sentinel = assertSchedulingIntegrityStorageTarget(
      STORAGE_ROOT,
      `${submissionId}/sentinel`,
    );
    await rm(dirname(sentinel), { recursive: true, force: true });
  }
}

async function cleanup(
  client: PoolClient,
  databaseIdentity: SchedulingIntegrityDatabaseIdentity,
) {
  let state = await readState();
  if (!state) {
    const residue = assertZeroSchedulingIntegrityResidue(
      await schedulingIntegrityResidue(client, emptyManifest()),
    );
    return {
      mode: "cleanup" as const,
      phase: "ABSENT" as const,
      databaseIdentity,
      residue,
    };
  }
  assertMatchingSchedulingIntegrityDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  if (state.storageRoot !== STORAGE_ROOT) {
    throw new Error("RESULT_UPLOAD_ROOT does not match the prepared scheduling integrity fixture.");
  }
  if (state.phase === "PREPARING" || state.phase === "PREPARED") {
    state = {
      ...state,
      phase: "MANIFESTED",
      manifest: await discoverOwnedManifest(client, state.preparedAt),
    };
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
  const beforeStateRemoval = await schedulingIntegrityResidue(client, state.manifest);
  if (beforeStateRemoval.stateFiles !== 1) {
    throw new Error(
      "The exact scheduling integrity fixture state file is missing before final proof.",
    );
  }
  assertZeroSchedulingIntegrityResidue({ ...beforeStateRemoval, stateFiles: 0 });
  await rm(STATE_FILE, { force: true });
  const residue = assertZeroSchedulingIntegrityResidue(
    await schedulingIntegrityResidue(client, state.manifest),
  );
  return {
    mode: "cleanup" as const,
    phase: "ABSENT" as const,
    databaseIdentity,
    residue,
  };
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error(
      `Use setup, status, or cleanup with a loopback PostgreSQL DATABASE_URL and ${SCHEDULING_INTEGRITY_ACCEPTANCE_FLAG}=1.`,
    );
  }
  const databaseIdentity = assertSafeSchedulingIntegrityAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env[SCHEDULING_INTEGRITY_ACCEPTANCE_FLAG],
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const output = mode === "setup"
        ? await setup(client, databaseIdentity)
        : mode === "status"
          ? await status(client, databaseIdentity)
          : await cleanup(client, databaseIdentity);
      console.log(JSON.stringify(assertSafeSchedulingIntegrityStatus(output), null, 2));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) await run();
