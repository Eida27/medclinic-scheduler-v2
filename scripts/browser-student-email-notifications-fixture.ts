import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { SCHEDULE_NOTICE } from "../src/lib/schedule-notice";
import { encryptVerificationEmailBody } from "../src/server/email/verification-body-encryption";

const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const EXCLUSIVE_FLAG = "STUDENT_EMAIL_NOTIFICATIONS_ACCEPTANCE_EXCLUSIVE_DATABASE";
const FIXTURE_DIRECTORY = resolve(".data/browser-student-email-notifications");
const STATE_FILE = resolve(FIXTURE_DIRECTORY, "state.json");
const MARKER = "BROWSER-STUDENT-EMAIL-NOTIFICATIONS-20260823";
const FAILURE_FUNCTION = "browser_student_email_notifications_force_failure";
const FAILURE_TRIGGER = "browser_student_email_notifications_force_failure_trigger";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PHYSICAL_EXAM_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const COLLEGE_ID = "ee230000-0000-4000-8000-000000000001";
const PROGRAM_ID = "ee230000-0000-4000-8000-000000000002";
const CLOSURE_GROUP_ID = "ee230000-0000-4000-8000-000000000601";
const UNAVAILABLE_DATE_ID = "ee230000-0000-4000-8000-000000000602";
const MANUAL_CASE_ID = "ee230000-0000-4000-8000-000000000603";
const RESCHEDULE_EVENT_ID = "ee230000-0000-4000-8000-000000000604";
const AWAITING_EVENT_ID = "ee230000-0000-4000-8000-000000000605";
const CONFIRMATION_VERIFICATION_ID = "ee230000-0000-4000-8000-000000000701";

const APPOINTMENT_IDS = {
  confirmationLaboratory: "ee230000-0000-4000-8000-000000000101",
  confirmationPhysicalExam: "ee230000-0000-4000-8000-000000000102",
  rescheduledOriginalLaboratory: "ee230000-0000-4000-8000-000000000201",
  rescheduledReplacementLaboratory: "ee230000-0000-4000-8000-000000000202",
  rescheduledPhysicalExam: "ee230000-0000-4000-8000-000000000203",
  awaitingLaboratory: "ee230000-0000-4000-8000-000000000301",
  awaitingPhysicalExam: "ee230000-0000-4000-8000-000000000302",
  deliveryCurrentLaboratory: "ee230000-0000-4000-8000-000000000401",
  deliveryStaleLaboratory: "ee230000-0000-4000-8000-000000000501",
} as const;
const PORTAL_NOTIFICATION_IDS = {
  rescheduled: "ee230000-0000-4000-8000-000000000711",
  awaiting: "ee230000-0000-4000-8000-000000000712",
  deliveryCurrent: "ee230000-0000-4000-8000-000000000713",
  deliveryStale: "ee230000-0000-4000-8000-000000000714",
} as const;
const OUTBOX_IDS = {
  confirmationVerification: "ee230000-0000-4000-8000-000000000721",
  rescheduled: "ee230000-0000-4000-8000-000000000722",
  awaiting: "ee230000-0000-4000-8000-000000000723",
  deliveryCurrent: "ee230000-0000-4000-8000-000000000724",
  deliveryStale: "ee230000-0000-4000-8000-000000000725",
} as const;
const AUDIT_IDS = [
  "ee230000-0000-4000-8000-000000000801",
  "ee230000-0000-4000-8000-000000000802",
  "ee230000-0000-4000-8000-000000000803",
  "ee230000-0000-4000-8000-000000000804",
  "ee230000-0000-4000-8000-000000000805",
] as const;
const SHARED_STUDENT_CREDENTIALS = { dateOfBirth: "2004-08-23", middleName: "Fixture" } as const;

export const STUDENT_EMAIL_NOTIFICATIONS_FIXTURE = {
  marker: MARKER,
  stateFile: STATE_FILE,
  staff: {
    admin: { id: "ee230000-0000-4000-8000-000000000011", email: "browser.email.admin@example.test", password: "BrowserAdmin123!", role: "ADMIN" },
    coordinator: { id: "ee230000-0000-4000-8000-000000000012", email: "browser.email.coordinator@example.test", password: "BrowserCoordinator123!", role: "COORDINATOR" },
  },
  sharedStudentCredentials: SHARED_STUDENT_CREDENTIALS,
  students: {
    onboarding: { studentNumber: "B-SEN-ONBOARD", firstName: "Onboarding", verifiedEmail: null, requestEmail: "browser.onboarding@example.test", correctedEmail: "browser.onboarding.corrected@example.test" },
    confirmationCatchUp: { studentNumber: "B-SEN-CONFIRM", firstName: "Confirmation", verifiedEmail: null, pendingEmail: "browser.confirmation@example.test" },
    rescheduled: { studentNumber: "B-SEN-RESCHED", firstName: "Rescheduled", verifiedEmail: "browser.rescheduled@example.test" },
    awaitingResolution: { studentNumber: "B-SEN-AWAIT", firstName: "Awaiting", verifiedEmail: "browser.awaiting@example.test" },
    deliveryCurrent: { studentNumber: "B-SEN-CURRENT", firstName: "Current", verifiedEmail: "browser.current@example.test" },
    deliveryStale: { studentNumber: "B-SEN-STALE", firstName: "Stale", verifiedEmail: "browser.stale@example.test" },
  },
  deliveryIds: { current: OUTBOX_IDS.deliveryCurrent, stale: OUTBOX_IDS.deliveryStale },
  confirmation: { verificationId: CONFIRMATION_VERIFICATION_ID, route: "/student/email-verification/confirm" },
} as const;

const STUDENT_NUMBERS = Object.values(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students).map((student) => student.studentNumber);
const STAFF_IDS = Object.values(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff).map((staff) => staff.id);

export type StudentEmailNotificationsDatabaseIdentity = { scheme: "postgresql"; host: string; port: string; database: string };
export type StudentEmailNotificationsResidue = {
  users: number; colleges: number; programs: number; students: number; loginAttempts: number;
  emailVerifications: number; appointments: number; closureGroups: number; unavailableDates: number;
  manualCases: number; rescheduleEvents: number; eventUnavailableDates: number; notifications: number;
  outbox: number; audits: number; triggers: number; triggerFunctions: number; stateFiles: number;
};
type FixtureState = {
  databaseIdentity: StudentEmailNotificationsDatabaseIdentity;
  phase: "PREPARING" | "PREPARED";
  createdAt: string;
  rawVerificationToken: string;
};

export function normalizeStudentEmailNotificationsDatabaseIdentity(databaseUrl: string): StudentEmailNotificationsDatabaseIdentity {
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL must be a valid PostgreSQL URL."); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("DATABASE_URL must use the PostgreSQL scheme.");
  if ([...parsed.searchParams.keys()].some((parameter) => ["host", "port"].includes(parameter.toLowerCase()))) {
    throw new Error("DATABASE_URL must not use host or port query parameters.");
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  let database: string;
  try { database = decodeURI(parsed.pathname.replace(/^\//, "")); } catch { throw new Error("DATABASE_URL must contain a valid database name."); }
  if (!host || !database) throw new Error("DATABASE_URL must contain a host and database name.");
  return { scheme: "postgresql", host, port: parsed.port || "5432", database };
}

export function assertSafeStudentEmailNotificationsAcceptanceDatabase(databaseUrl: string | undefined, exclusiveDatabase: string | undefined) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  const identity = normalizeStudentEmailNotificationsDatabaseIdentity(databaseUrl);
  if (!LOOPBACK_DATABASE_HOSTS.has(identity.host)) throw new Error("Student email notifications acceptance requires loopback PostgreSQL.");
  if (exclusiveDatabase !== "1") throw new Error(`Set ${EXCLUSIVE_FLAG}=1 only for a dedicated local student email notifications acceptance database.`);
  return identity;
}

function assertMatchingDatabaseIdentity(current: StudentEmailNotificationsDatabaseIdentity, persisted: StudentEmailNotificationsDatabaseIdentity) {
  if (JSON.stringify(current) !== JSON.stringify(persisted)) throw new Error("The current acceptance database does not match the prepared fixture database.");
}
async function stateFileCount() {
  try { await readFile(STATE_FILE, "utf8"); return 1; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
async function readState(): Promise<FixtureState | null> {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")) as FixtureState; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function writeState(state: FixtureState) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
function fingerprint(appointments: Array<[string, string, string, string | null, string | null, string]>, manualIds: string[] = []) {
  return createHash("sha256").update(JSON.stringify({ appointments, openManualResolutionIds: [...manualIds].sort() })).digest("hex");
}
function maskEmail(value: string | null) {
  if (!value) return null;
  const separator = value.indexOf("@");
  return separator > 0 ? `${value.slice(0, 1)}***${value.slice(separator)}` : "***";
}

async function databaseResidue(client: PoolClient): Promise<Omit<StudentEmailNotificationsResidue, "stateFiles">> {
  const result = await client.query<Omit<StudentEmailNotificationsResidue, "stateFiles">>(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE id=ANY($1::uuid[])) AS users,
       (SELECT COUNT(*)::int FROM colleges WHERE id=$2) AS colleges,
       (SELECT COUNT(*)::int FROM programs WHERE id=$3) AS programs,
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($4::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM student_login_attempts WHERE student_number=ANY($4::varchar[])) AS "loginAttempts",
       (SELECT COUNT(*)::int FROM student_email_verifications WHERE student_number=ANY($4::varchar[])) AS "emailVerifications",
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($4::varchar[])) AS appointments,
       (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE id=$5 OR reason LIKE $6) AS "closureGroups",
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates WHERE closure_group_id=$5) AS "unavailableDates",
       (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number=ANY($4::varchar[])) AS "manualCases",
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=ANY($4::varchar[])) AS "rescheduleEvents",
       (SELECT COUNT(*)::int FROM appointment_reschedule_event_unavailable_dates link JOIN appointment_reschedule_events event ON event.id=link.event_id WHERE event.student_number=ANY($4::varchar[])) AS "eventUnavailableDates",
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=ANY($4::varchar[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=ANY($4::varchar[])) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs WHERE id=ANY($7::uuid[]) OR metadata->>'studentNumber'=ANY($4::text[]) OR (entity_type='student_email_verification' AND entity_id=ANY($4::text[]))) AS audits,
       (SELECT COUNT(*)::int FROM pg_trigger WHERE tgname=$8 AND NOT tgisinternal) AS triggers,
       (SELECT COUNT(*)::int FROM pg_proc WHERE proname=$9) AS "triggerFunctions"`,
    [STAFF_IDS, COLLEGE_ID, PROGRAM_ID, STUDENT_NUMBERS, CLOSURE_GROUP_ID, `${MARKER}%`, AUDIT_IDS, FAILURE_TRIGGER, FAILURE_FUNCTION],
  );
  return result.rows[0];
}
async function residue(client: PoolClient): Promise<StudentEmailNotificationsResidue> { return { ...await databaseResidue(client), stateFiles: await stateFileCount() }; }
export function assertZeroStudentEmailNotificationsResidue(value: StudentEmailNotificationsResidue) {
  if (Object.values(value).some((count) => count !== 0)) throw new Error(`Student email notifications acceptance cleanup residue remains: ${JSON.stringify(value)}.`);
  return value;
}
function assertZeroDatabaseResidue(value: Omit<StudentEmailNotificationsResidue, "stateFiles">) {
  if (Object.values(value).some((count) => count !== 0)) throw new Error(`Student email notifications acceptance database residue remains: ${JSON.stringify(value)}.`);
}

async function removeOwnedRows(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await client.query(`DROP TRIGGER IF EXISTS ${FAILURE_TRIGGER} ON email_outbox`);
    await client.query(`DROP FUNCTION IF EXISTS ${FAILURE_FUNCTION}()`);
    await client.query(`DELETE FROM audit_logs WHERE id=ANY($1::uuid[]) OR metadata->>'studentNumber'=ANY($2::text[]) OR (entity_type='student_email_verification' AND entity_id=ANY($2::text[]))`, [AUDIT_IDS, STUDENT_NUMBERS]);
    await client.query("DELETE FROM email_outbox WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM student_email_verifications WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM student_login_attempts WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query(`DELETE FROM appointment_reschedule_event_unavailable_dates WHERE event_id IN (SELECT id FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[]))`, [STUDENT_NUMBERS]);
    await client.query("DELETE FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query(`DELETE FROM student_result_submissions WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM appointments WHERE student_number=ANY($1::varchar[]))`, [STUDENT_NUMBERS]);
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number=ANY($1::varchar[]))", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM exam_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM appointments WHERE student_number=ANY($1::varchar[]))", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM laboratory_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM appointments WHERE student_number=ANY($1::varchar[]))", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM appointments WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM clinic_unavailable_dates WHERE closure_group_id=$1", [CLOSURE_GROUP_ID]);
    await client.query("DELETE FROM clinic_closure_groups WHERE id=$1 OR reason LIKE $2", [CLOSURE_GROUP_ID, `${MARKER}%`]);
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [STUDENT_NUMBERS]);
    await client.query("DELETE FROM programs WHERE id=$1", [PROGRAM_ID]);
    await client.query("DELETE FROM colleges WHERE id=$1", [COLLEGE_ID]);
    await client.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [STAFF_IDS]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function seedDatabase(client: PoolClient, rawToken: string, encryptionKey: string) {
  const students = STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students;
  const currentFingerprint = fingerprint([["LABORATORY", APPOINTMENT_IDS.deliveryCurrentLaboratory, "PENDING", "2026-10-20", null, "KABALAKA Clinic"]]);
  const staleFingerprint = createHash("sha256").update(`${MARKER}:stale`).digest("hex");
  const verificationBody = encryptVerificationEmailBody(`Verify your email within 30 minutes: http://localhost:3000${STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.confirmation.route}?token=${encodeURIComponent(rawToken)}`, encryptionKey);
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO users (id,full_name,email,password_hash,role) VALUES ($1,'Browser Email Administrator',$2,crypt($3,gen_salt('bf',10)),'ADMIN'),($4,'Browser Email Coordinator',$5,crypt($6,gen_salt('bf',10)),'COORDINATOR')`, [STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.email, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.password, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.coordinator.id, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.coordinator.email, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.coordinator.password]);
    await client.query("INSERT INTO colleges (id,code,name) VALUES ($1,'BSEN','Browser Student Email Notifications College')", [COLLEGE_ID]);
    await client.query("INSERT INTO programs (id,college_id,code,name) VALUES ($1,$2,'BSEN','Browser Student Email Notifications Program')", [PROGRAM_ID, COLLEGE_ID]);
    await client.query(
      `INSERT INTO students (student_number,first_name,middle_name,last_name,college_id,program_id,year_level,date_of_birth,email,email_verified_at,is_active)
       SELECT row.student_number,row.first_name,$2,'Browser',$3,$4,3,$5::date,row.email,CASE WHEN row.email IS NULL THEN NULL ELSE clock_timestamp() END,TRUE
       FROM jsonb_to_recordset($1::jsonb) AS row(student_number varchar,first_name varchar,email varchar)`,
      [JSON.stringify(Object.values(students).map((student) => ({ student_number: student.studentNumber, first_name: student.firstName, email: student.verifiedEmail }))), SHARED_STUDENT_CREDENTIALS.middleName, COLLEGE_ID, PROGRAM_ID, SHARED_STUDENT_CREDENTIALS.dateOfBirth],
    );
    await client.query(`INSERT INTO student_email_verifications (id,student_number,pending_email,token_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()+INTERVAL '30 minutes',clock_timestamp())`, [CONFIRMATION_VERIFICATION_ID, students.confirmationCatchUp.studentNumber, students.confirmationCatchUp.pendingEmail, createHash("sha256").update(rawToken).digest("hex")]);
    const appointments = [
      [APPOINTMENT_IDS.confirmationLaboratory, LABORATORY_CLINIC_ID, students.confirmationCatchUp.studentNumber, "LABORATORY", "2026-09-21", "PENDING", "ee230000-0000-4000-8000-000000000111", null],
      [APPOINTMENT_IDS.confirmationPhysicalExam, PHYSICAL_EXAM_CLINIC_ID, students.confirmationCatchUp.studentNumber, "PHYSICAL_EXAM", "2026-09-28", "PENDING", "ee230000-0000-4000-8000-000000000111", null],
      [APPOINTMENT_IDS.rescheduledOriginalLaboratory, LABORATORY_CLINIC_ID, students.rescheduled.studentNumber, "LABORATORY", "2026-09-08", "RESCHEDULED", "ee230000-0000-4000-8000-000000000211", null],
      [APPOINTMENT_IDS.rescheduledReplacementLaboratory, LABORATORY_CLINIC_ID, students.rescheduled.studentNumber, "LABORATORY", "2026-09-15", "PENDING", "ee230000-0000-4000-8000-000000000211", APPOINTMENT_IDS.rescheduledOriginalLaboratory],
      [APPOINTMENT_IDS.rescheduledPhysicalExam, PHYSICAL_EXAM_CLINIC_ID, students.rescheduled.studentNumber, "PHYSICAL_EXAM", "2026-09-22", "PENDING", "ee230000-0000-4000-8000-000000000211", null],
      [APPOINTMENT_IDS.awaitingLaboratory, LABORATORY_CLINIC_ID, students.awaitingResolution.studentNumber, "LABORATORY", "2026-09-10", "AWAITING_RESCHEDULE", "ee230000-0000-4000-8000-000000000311", null],
      [APPOINTMENT_IDS.awaitingPhysicalExam, PHYSICAL_EXAM_CLINIC_ID, students.awaitingResolution.studentNumber, "PHYSICAL_EXAM", "2026-09-24", "PENDING", "ee230000-0000-4000-8000-000000000311", null],
      [APPOINTMENT_IDS.deliveryCurrentLaboratory, LABORATORY_CLINIC_ID, students.deliveryCurrent.studentNumber, "LABORATORY", "2026-10-20", "PENDING", "ee230000-0000-4000-8000-000000000411", null],
      [APPOINTMENT_IDS.deliveryStaleLaboratory, LABORATORY_CLINIC_ID, students.deliveryStale.studentNumber, "LABORATORY", "2026-10-21", "PENDING", "ee230000-0000-4000-8000-000000000511", null],
    ].map(([id, clinicId, studentNumber, scheduleType, appointmentDate, status, pairId, rescheduledFrom]) => ({ id, clinic_id: clinicId, student_number: studentNumber, schedule_type: scheduleType, appointment_date: appointmentDate, status, pair_id: pairId, rescheduled_from: rescheduledFrom }));
    await client.query(
      `INSERT INTO appointments (id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,rescheduled_from,created_by,updated_by)
       SELECT row.id,row.clinic_id,row.student_number,row.schedule_type,row.appointment_date,row.status,TRUE,row.pair_id,2026,row.rescheduled_from,$2,$2
       FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,clinic_id uuid,student_number varchar,schedule_type varchar,appointment_date date,status varchar,pair_id uuid,rescheduled_from uuid)`,
      [JSON.stringify(appointments), STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id],
    );
    await client.query(`INSERT INTO clinic_closure_groups (id,start_date,end_date,category,reason,created_by,creation_batch_id,recovery_mode,policy_effective_date) VALUES ($1,'2026-09-08','2026-09-10','CLOSURE',$2,$3,$4,'MANUAL_ALL','2026-08-23')`, [CLOSURE_GROUP_ID, `${MARKER} representative closure`, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id, "ee230000-0000-4000-8000-000000000606"]);
    await client.query("INSERT INTO clinic_unavailable_dates (id,closure_group_id,blocked_date) VALUES ($1,$2,'2026-09-10')", [UNAVAILABLE_DATE_ID, CLOSURE_GROUP_ID]);
    await client.query(`INSERT INTO clinic_closure_manual_cases (id,student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,affected_laboratory_appointment_id,reason_code,reason_message,status,policy_metadata) VALUES ($1,$2,$3,$4,2026,$5,'ADMIN_CHOSE_MANUAL_RECOVERY','Browser acceptance Manual Resolution remains open.','OPEN',$6::jsonb)`, [MANUAL_CASE_ID, students.awaitingResolution.studentNumber, CLOSURE_GROUP_ID, "ee230000-0000-4000-8000-000000000311", APPOINTMENT_IDS.awaitingLaboratory, JSON.stringify({ marker: MARKER })]);
    await client.query(
      `INSERT INTO appointment_reschedule_events (id,student_number,schedule_pair_id,cause,old_laboratory_appointment_id,new_laboratory_appointment_id,actor_user_id,closure_group_id,schedule_cycle_start,strategy,outcome,manual_case_id,policy_reason_code,policy_metadata)
       VALUES ($1,$3,$4,'CLINIC_CLOSURE',$5,$6,$7,$8,2026,'MOVE_LABORATORY_ONLY','REPLACED',NULL,'ADMIN_CHOSE_MANUAL_RECOVERY',$9::jsonb),
              ($2,$10,$11,'CLINIC_CLOSURE',$12,NULL,$7,$8,2026,'MANUAL_RESOLUTION_REQUIRED','AWAITING_RESCHEDULE',$13,'ADMIN_CHOSE_MANUAL_RECOVERY',$9::jsonb)`,
      [RESCHEDULE_EVENT_ID, AWAITING_EVENT_ID, students.rescheduled.studentNumber, "ee230000-0000-4000-8000-000000000211", APPOINTMENT_IDS.rescheduledOriginalLaboratory, APPOINTMENT_IDS.rescheduledReplacementLaboratory, STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id, CLOSURE_GROUP_ID, JSON.stringify({ marker: MARKER }), students.awaitingResolution.studentNumber, "ee230000-0000-4000-8000-000000000311", APPOINTMENT_IDS.awaitingLaboratory, MANUAL_CASE_ID],
    );
    await client.query("INSERT INTO appointment_reschedule_event_unavailable_dates (event_id,unavailable_date_id) VALUES ($1,$3),($2,$3)", [RESCHEDULE_EVENT_ID, AWAITING_EVENT_ID, UNAVAILABLE_DATE_ID]);
    await client.query(`CREATE FUNCTION ${FAILURE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_key IN ('fixture:delivery:current','fixture:delivery:stale') THEN NEW.status := 'PERMANENT_FAILURE'; NEW.attempts := 10; NEW.last_error := 'Fixture simulated email service timeout.'; NEW.last_attempt_at := clock_timestamp(); NEW.last_attempt_status := 'PERMANENT_FAILURE'; END IF; RETURN NEW; END $$`);
    await client.query(`CREATE TRIGGER ${FAILURE_TRIGGER} BEFORE INSERT ON email_outbox FOR EACH ROW EXECUTE FUNCTION ${FAILURE_FUNCTION}()`);
    const notifications = [
      { id: PORTAL_NOTIFICATION_IDS.rescheduled, studentNumber: students.rescheduled.studentNumber, type: "SCHEDULE_CLOSURE_RESCHEDULED", title: "Schedule changed for a clinic closure", message: "A clinic closure changed your Laboratory schedule from 2026-09-08 to 2026-09-15.", eventKey: `schedule:event:${RESCHEDULE_EVENT_ID}:${students.rescheduled.studentNumber}`, sourceType: "APPOINTMENT_RESCHEDULE_EVENT", sourceId: RESCHEDULE_EVENT_ID, fingerprint: fingerprint([["LABORATORY", APPOINTMENT_IDS.rescheduledReplacementLaboratory, "PENDING", "2026-09-15", null, "KABALAKA Clinic"], ["PHYSICAL_EXAM", APPOINTMENT_IDS.rescheduledPhysicalExam, "PENDING", "2026-09-22", null, "CPU Clinic"]]) },
      { id: PORTAL_NOTIFICATION_IDS.awaiting, studentNumber: students.awaitingResolution.studentNumber, type: "SCHEDULE_AWAITING_RESOLUTION", title: "Schedule awaiting administrator resolution", message: "Your prior 2026-09-10 Laboratory schedule was affected. No replacement date is authorized yet.", eventKey: `schedule:event:${AWAITING_EVENT_ID}:${students.awaitingResolution.studentNumber}`, sourceType: "CLINIC_CLOSURE_MANUAL_CASE", sourceId: MANUAL_CASE_ID, fingerprint: fingerprint([["LABORATORY", APPOINTMENT_IDS.awaitingLaboratory, "AWAITING_RESCHEDULE", null, "2026-09-10", "KABALAKA Clinic"], ["PHYSICAL_EXAM", APPOINTMENT_IDS.awaitingPhysicalExam, "PENDING", "2026-09-24", null, "CPU Clinic"]], [MANUAL_CASE_ID]) },
      { id: PORTAL_NOTIFICATION_IDS.deliveryCurrent, studentNumber: students.deliveryCurrent.studentNumber, type: "SCHEDULE_CURRENT_STATE", title: "Current schedule", message: "Your current Laboratory appointment is 2026-10-20 at KABALAKA Clinic.", eventKey: "fixture:delivery:current", sourceType: "CURRENT_SCHEDULE_STATE", sourceId: currentFingerprint, fingerprint: currentFingerprint },
      { id: PORTAL_NOTIFICATION_IDS.deliveryStale, studentNumber: students.deliveryStale.studentNumber, type: "SCHEDULE_CLOSURE_RESCHEDULED", title: "Earlier schedule delivery", message: "This delivery represents an earlier schedule state for stale-retry acceptance.", eventKey: "fixture:delivery:stale", sourceType: "APPOINTMENT_RESCHEDULE_EVENT", sourceId: AWAITING_EVENT_ID, fingerprint: staleFingerprint },
    ];
    await client.query(
      `INSERT INTO student_portal_notifications (id,student_number,notification_type,title,message,metadata,event_key)
       SELECT row.id,row.student_number,row.notification_type,row.title,row.message,jsonb_build_object('sourceType',row.source_type,'sourceId',row.source_id,'scheduleFingerprint',row.schedule_fingerprint),row.event_key
       FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,student_number varchar,notification_type varchar,title varchar,message text,event_key text,source_type text,source_id text,schedule_fingerprint text)`,
      [JSON.stringify(notifications.map((row) => ({ id: row.id, student_number: row.studentNumber, notification_type: row.type, title: row.title, message: row.message, event_key: row.eventKey, source_type: row.sourceType, source_id: row.sourceId, schedule_fingerprint: row.fingerprint })))],
    );
    const outbox = [
      { id: OUTBOX_IDS.confirmationVerification, studentNumber: students.confirmationCatchUp.studentNumber, email: students.confirmationCatchUp.pendingEmail, subject: "Verify your MedClinic notification email", body: "Verification email content is encrypted.", eventKey: "fixture:verification:confirmation", kind: "VERIFICATION", type: "EMAIL_VERIFICATION", sourceType: "STUDENT_EMAIL_VERIFICATION", sourceId: CONFIRMATION_VERIFICATION_ID, portalId: null, scheduleFingerprint: null, encrypted: verificationBody, status: "PENDING", attempts: 0 },
      { id: OUTBOX_IDS.rescheduled, studentNumber: students.rescheduled.studentNumber, email: students.rescheduled.verifiedEmail, subject: "Your MedClinic schedule changed due to a clinic closure", body: `Your Laboratory appointment moved from 2026-09-08 to 2026-09-15.\n\n${SCHEDULE_NOTICE}`, eventKey: notifications[0].eventKey, kind: "SCHEDULE", type: notifications[0].type, sourceType: notifications[0].sourceType, sourceId: notifications[0].sourceId, portalId: notifications[0].id, scheduleFingerprint: notifications[0].fingerprint, encrypted: null, status: "SENT", attempts: 1 },
      { id: OUTBOX_IDS.awaiting, studentNumber: students.awaitingResolution.studentNumber, email: students.awaitingResolution.verifiedEmail, subject: "Your MedClinic schedule needs administrator resolution", body: `Your Laboratory appointment is awaiting administrator resolution.\n\n${SCHEDULE_NOTICE}`, eventKey: notifications[1].eventKey, kind: "SCHEDULE", type: notifications[1].type, sourceType: notifications[1].sourceType, sourceId: notifications[1].sourceId, portalId: notifications[1].id, scheduleFingerprint: notifications[1].fingerprint, encrypted: null, status: "SENT", attempts: 1 },
      { id: OUTBOX_IDS.deliveryCurrent, studentNumber: students.deliveryCurrent.studentNumber, email: students.deliveryCurrent.verifiedEmail, subject: "Your current MedClinic schedule", body: `Your current Laboratory appointment is 2026-10-20.\n\n${SCHEDULE_NOTICE}`, eventKey: notifications[2].eventKey, kind: "SCHEDULE", type: notifications[2].type, sourceType: notifications[2].sourceType, sourceId: notifications[2].sourceId, portalId: notifications[2].id, scheduleFingerprint: notifications[2].fingerprint, encrypted: null, status: "PENDING", attempts: 0 },
      { id: OUTBOX_IDS.deliveryStale, studentNumber: students.deliveryStale.studentNumber, email: students.deliveryStale.verifiedEmail, subject: "Earlier MedClinic schedule", body: `This earlier schedule delivery is intentionally stale.\n\n${SCHEDULE_NOTICE}`, eventKey: notifications[3].eventKey, kind: "SCHEDULE", type: notifications[3].type, sourceType: notifications[3].sourceType, sourceId: notifications[3].sourceId, portalId: notifications[3].id, scheduleFingerprint: notifications[3].fingerprint, encrypted: null, status: "PENDING", attempts: 0 },
    ];
    await client.query(
      `INSERT INTO email_outbox (id,student_number,to_email,subject,text_body,event_key,message_kind,notification_type,source_type,source_id,portal_notification_id,schedule_fingerprint,verification_body_encrypted,status,attempts,next_attempt_at,sent_at)
       SELECT row.id,row.student_number,row.to_email,row.subject,row.text_body,row.event_key,row.message_kind,row.notification_type,row.source_type,row.source_id,row.portal_notification_id,row.schedule_fingerprint,row.verification_body_encrypted,row.status,row.attempts,clock_timestamp(),CASE WHEN row.status='SENT' THEN clock_timestamp() ELSE NULL END
       FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,student_number varchar,to_email varchar,subject varchar,text_body text,event_key text,message_kind varchar,notification_type varchar,source_type varchar,source_id text,portal_notification_id uuid,schedule_fingerprint char(64),verification_body_encrypted text,status varchar,attempts integer)`,
      [JSON.stringify(outbox.map((row) => ({ id: row.id, student_number: row.studentNumber, to_email: row.email, subject: row.subject, text_body: row.body, event_key: row.eventKey, message_kind: row.kind, notification_type: row.type, source_type: row.sourceType, source_id: row.sourceId, portal_notification_id: row.portalId, schedule_fingerprint: row.scheduleFingerprint, verification_body_encrypted: row.encrypted, status: row.status, attempts: row.attempts })))],
    );
    await client.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       SELECT row.audit_id,$2,'EMAIL_OUTBOX_QUEUED','email_outbox',row.outbox_id,jsonb_build_object('studentNumber',row.student_number,'messageKind',row.message_kind,'marker',$3::text)
       FROM jsonb_to_recordset($1::jsonb) AS row(audit_id uuid,outbox_id text,student_number text,message_kind text)`,
      [JSON.stringify(outbox.map((row, index) => ({ audit_id: AUDIT_IDS[index], outbox_id: row.id, student_number: row.studentNumber, message_kind: row.kind }))), STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff.admin.id, MARKER],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function statusWithClient(client: PoolClient, phase: "PREPARED" | "ABSENT") {
  const students = await client.query<{ studentNumber: string; email: string | null; verified: boolean }>(`SELECT student_number AS "studentNumber",email,email_verified_at IS NOT NULL AS verified FROM students WHERE student_number=ANY($1::varchar[]) ORDER BY student_number`, [STUDENT_NUMBERS]);
  const appointments = await client.query(`SELECT id::text,student_number,schedule_type,appointment_date::text,status,rescheduled_from::text,is_published FROM appointments WHERE student_number=ANY($1::varchar[]) ORDER BY student_number,appointment_date,id`, [STUDENT_NUMBERS]);
  const manualCases = await client.query(`SELECT id::text,student_number,status,reason_code,optimistic_token::text FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[]) ORDER BY id`, [STUDENT_NUMBERS]);
  const notifications = await client.query(`SELECT id::text,student_number,notification_type,title,event_key,read_at FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) ORDER BY created_at,id`, [STUDENT_NUMBERS]);
  const deliveries = await client.query<{ id: string; studentNumber: string; toEmail: string; messageKind: string; notificationType: string | null; status: string; attempts: number }>(`SELECT id::text,student_number AS "studentNumber",to_email AS "toEmail",message_kind AS "messageKind",notification_type AS "notificationType",status,attempts FROM email_outbox WHERE student_number=ANY($1::varchar[]) ORDER BY created_at,id`, [STUDENT_NUMBERS]);
  return {
    phase,
    browser: {
      staff: STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.staff,
      sharedStudentCredentials: SHARED_STUDENT_CREDENTIALS,
      students: STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students,
      confirmation: { route: STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.confirmation.route, tokenStateFile: STATE_FILE, pendingEmailMasked: maskEmail(STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.students.confirmationCatchUp.pendingEmail) },
      deliveryIds: STUDENT_EMAIL_NOTIFICATIONS_FIXTURE.deliveryIds,
    },
    expected: { unverifiedStudents: 2, confirmationCatchUpNotificationsBeforeConfirmation: 0, actionableDeliveryFailures: 2, openManualCases: 1 },
    observed: {
      students: students.rows.map((student) => ({ studentNumber: student.studentNumber, verified: student.verified, emailMasked: maskEmail(student.email) })),
      appointments: appointments.rows,
      manualCases: manualCases.rows,
      notifications: notifications.rows,
      deliveries: deliveries.rows.map((delivery) => ({ id: delivery.id, studentNumber: delivery.studentNumber, destination: maskEmail(delivery.toEmail), messageKind: delivery.messageKind, notificationType: delivery.notificationType, status: delivery.status, attempts: delivery.attempts })),
    },
    residue: await residue(client),
  };
}

export async function prepareStudentEmailNotificationsFixture(pool: Pool, databaseIdentity: StudentEmailNotificationsDatabaseIdentity, options: { encryptionKey?: string } = {}) {
  const encryptionKey = options.encryptionKey ?? process.env.EMAIL_OUTBOX_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("EMAIL_OUTBOX_ENCRYPTION_KEY is required for fixture verification mail.");
  const client = await pool.connect();
  try {
    const previous = await readState();
    if (previous) {
      assertMatchingDatabaseIdentity(databaseIdentity, previous.databaseIdentity);
      await removeOwnedRows(client);
      await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
      assertZeroStudentEmailNotificationsResidue(await residue(client));
    } else {
      const existing = await residue(client);
      if (Object.values(existing).some((count) => count !== 0)) throw new Error(`Refusing to overwrite untracked student email notifications fixture data: ${JSON.stringify(existing)}.`);
    }
    const rawVerificationToken = randomBytes(32).toString("base64url");
    const state: FixtureState = { databaseIdentity, phase: "PREPARING", createdAt: new Date().toISOString(), rawVerificationToken };
    await writeState(state);
    try {
      await seedDatabase(client, rawVerificationToken, encryptionKey);
      await writeState({ ...state, phase: "PREPARED" });
    } catch (error) {
      await removeOwnedRows(client).catch(() => undefined);
      await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
      throw error;
    }
    return { ...await statusWithClient(client, "PREPARED"), mode: "setup" as const, databaseIdentity };
  } finally { client.release(); }
}

export async function getStudentEmailNotificationsFixtureStatus(pool: Pool, databaseIdentity: StudentEmailNotificationsDatabaseIdentity) {
  const state = await readState();
  if (state) assertMatchingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
  const client = await pool.connect();
  try { return { ...await statusWithClient(client, state?.phase === "PREPARED" ? "PREPARED" : "ABSENT"), mode: "status" as const, databaseIdentity }; }
  finally { client.release(); }
}

export async function cleanupStudentEmailNotificationsFixture(pool: Pool, databaseIdentity: StudentEmailNotificationsDatabaseIdentity) {
  const state = await readState();
  const client = await pool.connect();
  try {
    if (!state) {
      const proof = assertZeroStudentEmailNotificationsResidue(await residue(client));
      return { mode: "cleanup" as const, phase: "ABSENT" as const, databaseIdentity, residue: proof };
    }
    assertMatchingDatabaseIdentity(databaseIdentity, state.databaseIdentity);
    await removeOwnedRows(client);
    assertZeroDatabaseResidue(await databaseResidue(client));
    await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
    const proof = assertZeroStudentEmailNotificationsResidue(await residue(client));
    return { mode: "cleanup" as const, phase: "ABSENT" as const, databaseIdentity, residue: proof };
  } finally { client.release(); }
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) throw new Error(`Use setup, status, or cleanup with loopback PostgreSQL and ${EXCLUSIVE_FLAG}=1.`);
  const databaseIdentity = assertSafeStudentEmailNotificationsAcceptanceDatabase(process.env.DATABASE_URL, process.env[EXCLUSIVE_FLAG]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const output = mode === "setup" ? await prepareStudentEmailNotificationsFixture(pool, databaseIdentity) : mode === "status" ? await getStudentEmailNotificationsFixtureStatus(pool, databaseIdentity) : await cleanupStudentEmailNotificationsFixture(pool, databaseIdentity);
    console.log(JSON.stringify(output, null, 2));
  } finally { await pool.end(); }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) await run();
