import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { pool } from "../src/server/db/pool";
import { decryptEmailOutboxSensitiveBody } from "../src/server/email/verification-body-encryption";
import { bootstrapFirstAdministrator } from "../src/server/services/staff-bootstrap.service";

const EXCLUSIVE_FLAG = "STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE";
const STATE_FILE = resolve(process.cwd(), ".data", "browser-staff-account-security.json");
const FIXTURE_DOMAIN = "staff-security-acceptance.test";
const FULL_NAME_PREFIX = "Browser Security ";
const HISTORICAL_USER_ID = "fa250000-0000-4000-8000-000000000001";
const HISTORICAL_STUDENT_NUMBER = "B-STAFF-HISTORY";
const HISTORICAL_APPOINTMENT_ID = "fa250000-0000-4000-8000-000000000002";
const HISTORICAL_STATUS_LOG_ID = "fa250000-0000-4000-8000-000000000003";
const MARKER = "BROWSER-STAFF-SECURITY-20260825";

const browserAccounts = {
  bootstrapAdministrator: {
    fullName: `${FULL_NAME_PREFIX}Bootstrap Administrator`,
    email: `bootstrap@${FIXTURE_DOMAIN}`,
    temporaryPassword: "Bootstrap1!",
    replacementPassword: "Bootstrap2!",
    changedPassword: "Bootstrap3!",
  },
  coordinator: {
    fullName: `${FULL_NAME_PREFIX}Coordinator`,
    email: `coordinator@${FIXTURE_DOMAIN}`,
    temporaryPassword: "Coordinator1!",
    replacementPassword: "Coordinator2!",
  },
  clinicStaff: {
    fullName: `${FULL_NAME_PREFIX}Clinic Staff`,
    email: `clinic@${FIXTURE_DOMAIN}`,
    temporaryPassword: "ClinicStaff1!",
    replacementPassword: "ClinicStaff2!",
  },
  fallbackReset: {
    fullName: `${FULL_NAME_PREFIX}Fallback Reset`,
    email: `fallback@${FIXTURE_DOMAIN}`,
    temporaryPassword: "Fallback1!",
    replacementPassword: "Fallback2!",
  },
  reusableDeletion: {
    fullName: `${FULL_NAME_PREFIX}Reusable Deletion`,
    email: `reusable@${FIXTURE_DOMAIN}`,
    temporaryPassword: "Reusable1!",
  },
} as const;

type FixtureState = {
  phase: "PREPARING" | "PREPARED";
  startedAt: string;
  priorAdministratorIds: string[];
  bootstrapAdministratorId?: string;
  bootstrapVerificationToken?: string;
  duplicateBootstrapRejected?: boolean;
};

export type StaffAccountSecurityResidue = {
  users: number;
  emailVerifications: number;
  passwordResets: number;
  outbox: number;
  audits: number;
  historicalAppointments: number;
  historicalStatusLogs: number;
  historicalStudents: number;
  stateFiles: number;
};

export function assertSafeStaffAccountSecurityAcceptanceDatabase(
  databaseUrl: string | undefined,
  exclusiveFlag: string | undefined,
) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("The staff account security Browser fixture requires a loopback PostgreSQL database.");
  }
  if (exclusiveFlag !== "1") {
    throw new Error(`Set ${EXCLUSIVE_FLAG}=1 only after confirming this database is disposable and exclusively available.`);
  }
  return {
    database: parsed.pathname.replace(/^\//, ""),
    hostname: parsed.hostname,
  };
}

export function assertZeroStaffAccountSecurityResidue(value: StaffAccountSecurityResidue) {
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`Staff account security acceptance cleanup residue remains: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function fileExists(path: string) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readState(): Promise<FixtureState | undefined> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as FixtureState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(state: FixtureState) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function fixtureUserIds(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `SELECT id::text FROM users
      WHERE full_name LIKE $1 OR email LIKE $2 OR id=$3
      ORDER BY id`,
    [`${FULL_NAME_PREFIX}%`, `%@${FIXTURE_DOMAIN}`, HISTORICAL_USER_ID],
  );
  return result.rows.map((row) => row.id);
}

async function residue(client: PoolClient): Promise<StaffAccountSecurityResidue> {
  const userIds = await fixtureUserIds(client);
  const result = await client.query<Omit<StaffAccountSecurityResidue, "stateFiles">>(
    `SELECT
       (SELECT COUNT(*)::int FROM users
         WHERE full_name LIKE $1 OR email LIKE $2 OR id=$3) AS users,
       (SELECT COUNT(*)::int FROM staff_email_verifications
         WHERE user_id=ANY($4::uuid[])) AS "emailVerifications",
       (SELECT COUNT(*)::int FROM staff_password_resets
         WHERE user_id=ANY($4::uuid[])) AS "passwordResets",
       (SELECT COUNT(*)::int FROM email_outbox outbox
         WHERE outbox.message_kind='STAFF_SECURITY'
           AND (
             outbox.to_email LIKE $2
             OR outbox.source_id IN (
               SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($4::uuid[])
               UNION ALL
               SELECT id::text FROM staff_password_resets WHERE user_id=ANY($4::uuid[])
             )
           )) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs audit
         WHERE audit.actor_user_id=ANY($4::uuid[])
            OR (audit.entity_type='user' AND audit.entity_id=ANY($5::text[]))
            OR audit.metadata->>'userId'=ANY($5::text[])
            OR audit.metadata->>'marker'=$6) AS audits,
       (SELECT COUNT(*)::int FROM appointments WHERE id=$7) AS "historicalAppointments",
       (SELECT COUNT(*)::int FROM appointment_status_logs WHERE id=$8 OR appointment_id=$7) AS "historicalStatusLogs",
       (SELECT COUNT(*)::int FROM students WHERE student_number=$9) AS "historicalStudents"`,
    [
      `${FULL_NAME_PREFIX}%`,
      `%@${FIXTURE_DOMAIN}`,
      HISTORICAL_USER_ID,
      userIds,
      userIds,
      MARKER,
      HISTORICAL_APPOINTMENT_ID,
      HISTORICAL_STATUS_LOG_ID,
      HISTORICAL_STUDENT_NUMBER,
    ],
  );
  return { ...result.rows[0], stateFiles: await fileExists(STATE_FILE) ? 1 : 0 };
}

function extractSecurityToken(encryptedBody: string) {
  const key = process.env.EMAIL_OUTBOX_ENCRYPTION_KEY;
  if (!key) throw new Error("EMAIL_OUTBOX_ENCRYPTION_KEY is required.");
  const body = decryptEmailOutboxSensitiveBody(encryptedBody, key);
  const token = new URL(body.match(/https?:\/\/\S+/)?.[0] ?? "").searchParams.get("token");
  if (!token) throw new Error("The queued staff security message did not contain a token URL.");
  return token;
}

async function latestSecurityLinks(client: PoolClient) {
  const result = await client.query<{
    toEmail: string;
    sourceType: string;
    encryptedBody: string;
  }>(
    `SELECT to_email AS "toEmail",source_type AS "sourceType",
            verification_body_encrypted AS "encryptedBody"
       FROM email_outbox
      WHERE message_kind='STAFF_SECURITY' AND to_email LIKE $1
        AND verification_body_encrypted IS NOT NULL
      ORDER BY created_at DESC,id DESC`,
    [`%@${FIXTURE_DOMAIN}`],
  );
  const links: Record<string, { verificationToken?: string; resetToken?: string }> = {};
  for (const row of result.rows) {
    const current = links[row.toEmail] ?? {};
    if (row.sourceType === "STAFF_EMAIL_VERIFICATION" && !current.verificationToken) {
      current.verificationToken = extractSecurityToken(row.encryptedBody);
    }
    if (row.sourceType === "STAFF_PASSWORD_RESET" && !current.resetToken) {
      current.resetToken = extractSecurityToken(row.encryptedBody);
    }
    links[row.toEmail] = current;
  }
  return links;
}

async function restoreAdministrators(client: PoolClient, administratorIds: string[]) {
  if (!administratorIds.length) return;
  await client.query(
    `UPDATE users SET role='ADMIN',clinic_id=NULL
      WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`,
    [administratorIds],
  );
}

async function removeFixtureRows(client: PoolClient) {
  const userIds = await fixtureUserIds(client);
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM appointment_status_logs WHERE id=$1 OR appointment_id=$2 OR changed_by=ANY($3::uuid[])",
      [HISTORICAL_STATUS_LOG_ID, HISTORICAL_APPOINTMENT_ID, userIds],
    );
    await client.query("DELETE FROM appointments WHERE id=$1", [HISTORICAL_APPOINTMENT_ID]);
    await client.query("DELETE FROM students WHERE student_number=$1", [HISTORICAL_STUDENT_NUMBER]);
    await client.query(
      `DELETE FROM email_outbox outbox
        WHERE outbox.message_kind='STAFF_SECURITY'
          AND (
            outbox.to_email LIKE $1
            OR outbox.source_id IN (
              SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($2::uuid[])
              UNION ALL
              SELECT id::text FROM staff_password_resets WHERE user_id=ANY($2::uuid[])
            )
          )`,
      [`%@${FIXTURE_DOMAIN}`, userIds],
    );
    await client.query("DELETE FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])", [userIds]);
    await client.query("DELETE FROM staff_password_resets WHERE user_id=ANY($1::uuid[])", [userIds]);
    await client.query(
      `DELETE FROM audit_logs audit
        WHERE audit.actor_user_id=ANY($1::uuid[])
           OR (audit.entity_type='user' AND audit.entity_id=ANY($2::text[]))
           OR audit.metadata->>'userId'=ANY($2::text[])
           OR audit.metadata->>'marker'=$3`,
      [userIds, userIds, MARKER],
    );
    await client.query(
      "DELETE FROM users WHERE id=ANY($1::uuid[]) AND deleted_at IS NOT NULL",
      [userIds],
    );
    await client.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedHistoricalAttribution(client: PoolClient, bootstrapAdministratorId: string) {
  const references = await client.query<{
    collegeId: string;
    programId: string;
    clinicId: string;
  }>(
    `SELECT college.id::text AS "collegeId",program.id::text AS "programId",clinic.id::text AS "clinicId"
       FROM programs program
       JOIN colleges college ON college.id=program.college_id AND college.is_active=TRUE
       CROSS JOIN LATERAL (
         SELECT id FROM clinics WHERE code='CPU_CLINIC' LIMIT 1
       ) clinic
      WHERE program.is_active=TRUE
      ORDER BY college.id,program.id
      LIMIT 1`,
  );
  const reference = references.rows[0];
  if (!reference) throw new Error("Active reference data is required for the historical attribution fixture.");
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO users (
         id,full_name,email,password_hash,role,email_verified_at,must_change_password,
         credential_version,deleted_at,deleted_by
       ) VALUES ($1,$2,NULL,NULL,'COORDINATOR',NULL,FALSE,2,clock_timestamp(),$3)`,
      [HISTORICAL_USER_ID, `${FULL_NAME_PREFIX}Former Coordinator`, bootstrapAdministratorId],
    );
    await client.query(
      `INSERT INTO students (
         student_number,first_name,last_name,college_id,program_id,year_level,date_of_birth,is_active
       ) VALUES ($1,'Historical','Attribution',$2,$3,4,'2004-01-01',TRUE)`,
      [HISTORICAL_STUDENT_NUMBER, reference.collegeId, reference.programId],
    );
    await client.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,created_by,updated_by,is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES (
         $1,$2,$3,'PHYSICAL_EXAM','2026-09-30','PENDING',TRUE,2026,$4,$4,
         TRUE,$5,clock_timestamp(),'Historical Browser attribution'
       )`,
      [
        HISTORICAL_APPOINTMENT_ID,
        reference.clinicId,
        HISTORICAL_STUDENT_NUMBER,
        bootstrapAdministratorId,
        HISTORICAL_USER_ID,
      ],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (
         id,appointment_id,old_status,new_status,notes,changed_by
       ) VALUES ($1,$2,'DRAFT','PENDING','Historical Browser attribution',$3)`,
      [HISTORICAL_STATUS_LOG_ID, HISTORICAL_APPOINTMENT_ID, HISTORICAL_USER_ID],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'STAFF_USER_DELETED','user',$2,$3::jsonb)`,
      [
        bootstrapAdministratorId,
        HISTORICAL_USER_ID,
        JSON.stringify({ marker: MARKER, fullName: `${FULL_NAME_PREFIX}Former Coordinator`, role: "COORDINATOR" }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function setup(client: PoolClient) {
  if (await readState()) throw new Error("A staff account security Browser fixture state already exists. Run cleanup first.");
  const currentResidue = await residue(client);
  if (Object.entries(currentResidue).some(([key, count]) => key !== "stateFiles" && count !== 0)) {
    throw new Error(`Untracked staff account security fixture residue exists: ${JSON.stringify(currentResidue)}.`);
  }
  const priorAdministrators = await client.query<{ id: string }>(
    "SELECT id::text FROM users WHERE role='ADMIN' AND deleted_at IS NULL ORDER BY id",
  );
  const state: FixtureState = {
    phase: "PREPARING",
    startedAt: new Date().toISOString(),
    priorAdministratorIds: priorAdministrators.rows.map((row) => row.id),
  };
  await writeState(state);
  try {
    await client.query(
      "UPDATE users SET role='COORDINATOR',clinic_id=NULL WHERE role='ADMIN' AND deleted_at IS NULL",
    );
    const administrator = await bootstrapFirstAdministrator({
      fullName: browserAccounts.bootstrapAdministrator.fullName,
      email: browserAccounts.bootstrapAdministrator.email,
      temporaryPassword: browserAccounts.bootstrapAdministrator.temporaryPassword,
    });
    let duplicateBootstrapRejected = false;
    try {
      await bootstrapFirstAdministrator({
        fullName: `${FULL_NAME_PREFIX}Duplicate Bootstrap`,
        email: `duplicate@${FIXTURE_DOMAIN}`,
        temporaryPassword: "Duplicate1!",
      });
    } catch (error) {
      duplicateBootstrapRejected = (error as { code?: string }).code === "STAFF_ADMIN_EXISTS";
      if (!duplicateBootstrapRejected) throw error;
    }
    const verification = await client.query<{ encryptedBody: string }>(
      `SELECT verification_body_encrypted AS "encryptedBody"
         FROM email_outbox
        WHERE message_kind='STAFF_SECURITY'
          AND notification_type='STAFF_EMAIL_VERIFICATION'
          AND to_email=$1
        ORDER BY created_at DESC,id DESC LIMIT 1`,
      [administrator.email],
    );
    if (!verification.rows[0]?.encryptedBody) throw new Error("Bootstrap did not queue an encrypted verification message.");
    await seedHistoricalAttribution(client, administrator.id);
    const prepared: FixtureState = {
      ...state,
      phase: "PREPARED",
      bootstrapAdministratorId: administrator.id,
      bootstrapVerificationToken: extractSecurityToken(verification.rows[0].encryptedBody),
      duplicateBootstrapRejected,
    };
    await writeState(prepared);
    return status(client, prepared);
  } catch (error) {
    await removeFixtureRows(client);
    await restoreAdministrators(client, state.priorAdministratorIds);
    await rm(STATE_FILE, { force: true });
    throw error;
  }
}

async function status(client: PoolClient, suppliedState?: FixtureState) {
  const state = suppliedState ?? await readState();
  const accounts = await client.query<{
    id: string;
    fullName: string;
    email: string | null;
    role: string;
    status: string;
    deleted: boolean;
  }>(
    `SELECT id::text,full_name AS "fullName",email,role,
            CASE
              WHEN deleted_at IS NOT NULL THEN 'DELETED'
              WHEN email_verified_at IS NULL THEN 'PENDING_VERIFICATION'
              WHEN must_change_password THEN 'PASSWORD_CHANGE_REQUIRED'
              ELSE 'ACTIVE'
            END AS status,
            deleted_at IS NOT NULL AS deleted
       FROM users
      WHERE full_name LIKE $1 OR email LIKE $2 OR id=$3
      ORDER BY full_name,id`,
    [`${FULL_NAME_PREFIX}%`, `%@${FIXTURE_DOMAIN}`, HISTORICAL_USER_ID],
  );
  return {
    phase: state?.phase ?? "ABSENT",
    database: assertSafeStaffAccountSecurityAcceptanceDatabase(
      process.env.DATABASE_URL,
      process.env[EXCLUSIVE_FLAG],
    ),
    browser: {
      accounts: browserAccounts,
      bootstrapVerificationToken: state?.bootstrapVerificationToken,
      duplicateBootstrapRejected: state?.duplicateBootstrapRejected ?? false,
      historicalAppointmentRoute: `/physical-exam/${HISTORICAL_APPOINTMENT_ID}`,
      securityLinks: await latestSecurityLinks(client),
    },
    records: accounts.rows,
    residue: await residue(client),
  };
}

async function cleanup(client: PoolClient) {
  const state = await readState();
  await removeFixtureRows(client);
  if (state) await restoreAdministrators(client, state.priorAdministratorIds);
  await rm(STATE_FILE, { force: true });
  const clean = await residue(client);
  return {
    phase: "ABSENT",
    residue: assertZeroStaffAccountSecurityResidue(clean),
    restoredAdministratorIds: state?.priorAdministratorIds ?? [],
  };
}

async function main() {
  assertSafeStaffAccountSecurityAcceptanceDatabase(
    process.env.DATABASE_URL,
    process.env[EXCLUSIVE_FLAG],
  );
  const command = process.argv[2];
  if (!(["setup", "status", "cleanup"] as const).includes(command as "setup" | "status" | "cleanup")) {
    throw new Error("Use setup, status, or cleanup.");
  }
  const client = await pool.connect();
  try {
    const result = command === "setup"
      ? await setup(client)
      : command === "status"
        ? await status(client)
        : await cleanup(client);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  await main();
}
