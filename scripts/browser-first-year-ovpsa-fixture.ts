import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "bcryptjs";
import { Pool, type PoolClient } from "pg";

const DIRECTORY = resolve(".data/browser-first-year-ovpsa");
const STATE_FILE = resolve(DIRECTORY, "state.json");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const LAB_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PE_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const MAIN_BATCH_ID = "bf190000-0000-4000-8000-000000000041";
const BLOCKED_BATCH_ID = "bf190000-0000-4000-8000-000000000042";
const MAIN_REVISION_ID = "bf190000-0000-4000-8000-000000000051";
const BLOCKED_REVISION_ID = "bf190000-0000-4000-8000-000000000052";
const LOWER_PRIORITY_BATCH_ID = "bf190000-0000-4000-8000-000000000033";

export const OVPSA_FIRST_YEAR_ACCEPTANCE = {
  marker: "B-OVPSA",
  cycleStart: 2026,
  mainCollege: { id: "bf190000-0000-4000-8000-000000000001", code: "BOVPM", name: "Browser OVPSA Main College" },
  blockedCollege: { id: "bf190000-0000-4000-8000-000000000002", code: "BOVPB", name: "Browser OVPSA Blocked College" },
  mainProgram: { id: "bf190000-0000-4000-8000-000000000011", code: "BOVPM-P", name: "Browser OVPSA Main Program" },
  blockedProgram: { id: "bf190000-0000-4000-8000-000000000012", code: "BOVPB-P", name: "Browser OVPSA Blocked Program" },
  dates: {
    mainLaboratory: "2026-09-14",
    mainPhysicalExam: "2026-09-21",
    blockedLaboratory: "2026-09-28",
    blockedPhysicalExam: "2026-10-05",
    replacementLaboratory: "2026-10-12",
    replacementPhysicalExam: "2026-10-19",
  },
  students: {
    member: { number: "B-OVPSA-M1", dateOfBirth: "2007-04-16", middleName: "Maria Angela" },
    secondMember: { number: "B-OVPSA-M2", dateOfBirth: "2007-05-17", middleName: "De la Cruz" },
    blockedMember: { number: "B-OVPSA-B1", dateOfBirth: "2007-06-18", middleName: "Louise" },
    displaced: "B-OVPSA-LOW",
    protected: "B-OVPSA-LOCK",
  },
  cpuStaff: {
    id: "bf190000-0000-4000-8000-000000000021",
    email: "browser.ovpsa.cpu@medclinic.local",
    password: "BrowserCPU123!",
  },
  closureReason: "B-OVPSA official closure acceptance",
  batches: { main: MAIN_BATCH_ID, blocked: BLOCKED_BATCH_ID },
} as const;

type DatabaseIdentity = { scheme: "postgresql"; host: string; port: string; database: string };
type State = { databaseIdentity: DatabaseIdentity; preparedAt: string };
type Residue = {
  students: number; batches: number; revisions: number; memberships: number;
  reservations: number; appointments: number; verifications: number; events: number;
  notifications: number; outbox: number; audits: number; stateFiles: number;
};

function identity(databaseUrl: string | undefined): DatabaseIdentity {
  if (!databaseUrl) throw new Error("DATABASE_URL is required (normally loaded from .env.local).");
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const database = decodeURI(parsed.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !host || !database) {
    throw new Error("DATABASE_URL must identify a PostgreSQL database.");
  }
  if ([...parsed.searchParams.keys()].some((key) => ["host", "port"].includes(key.toLowerCase()))) {
    throw new Error("DATABASE_URL must not override host or port through query parameters.");
  }
  if (!LOOPBACK.has(host)) throw new Error("First Year OVPSA acceptance requires a loopback PostgreSQL database.");
  if (process.env.OVPSA_FIRST_YEAR_ACCEPTANCE_EXCLUSIVE_DATABASE !== "1") {
    throw new Error("Set OVPSA_FIRST_YEAR_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a dedicated local acceptance database.");
  }
  return { scheme: "postgresql", host, port: parsed.port || "5432", database };
}

async function readState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertSame(current: DatabaseIdentity, state: State) {
  if (JSON.stringify(current) !== JSON.stringify(state.databaseIdentity)) {
    throw new Error("The prepared fixture belongs to a different database.");
  }
}

async function stateFileCount() {
  return (await readState()) ? 1 : 0;
}

async function residue(client: PoolClient): Promise<Residue> {
  const result = await client.query<Omit<Residue, "stateFiles">>(
    `WITH tagged_batches AS (
       SELECT id FROM ovpsa_first_year_batches
        WHERE college_id IN ($1::uuid,$2::uuid)
     ), tagged_appointments AS (
       SELECT id FROM appointments WHERE student_number LIKE 'B-OVPSA-%'
     )
     SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE 'B-OVPSA-%') AS students,
       (SELECT COUNT(*)::int FROM tagged_batches) AS batches,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM tagged_batches)) AS revisions,
       ((SELECT COUNT(*) FROM ovpsa_first_year_membership_snapshots WHERE batch_id IN (SELECT id FROM tagged_batches))
        +(SELECT COUNT(*) FROM ovpsa_first_year_active_memberships WHERE batch_id IN (SELECT id FROM tagged_batches)))::int AS memberships,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM tagged_batches)) AS reservations,
       (SELECT COUNT(*)::int FROM tagged_appointments) AS appointments,
       (SELECT COUNT(*)::int FROM ovpsa_external_laboratory_verifications WHERE appointment_id IN (SELECT id FROM tagged_appointments)) AS verifications,
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number LIKE 'B-OVPSA-%' OR ovpsa_batch_id IN (SELECT id FROM tagged_batches)) AS events,
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number LIKE 'B-OVPSA-%') AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number LIKE 'B-OVPSA-%') AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs WHERE entity_id LIKE 'bf190000-%'
          OR metadata::text LIKE '%B-OVPSA%' OR metadata::text LIKE '%bf190000-%'
          OR actor_user_id=$3) AS audits`,
    [OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id,
      OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.id],
  );
  return { ...result.rows[0], stateFiles: await stateFileCount() };
}

function assertZero(value: Residue) {
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`First Year OVPSA acceptance cleanup residue remains: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function deleteFixture(client: PoolClient) {
  await client.query("BEGIN");
  try {
    const batchIds = (await client.query<{ id: string }>(
      `SELECT id::text FROM ovpsa_first_year_batches
        WHERE college_id IN ($1::uuid,$2::uuid)`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id],
    )).rows.map((row) => row.id);
    const appointmentIds = (await client.query<{ id: string }>(
      "SELECT id::text FROM appointments WHERE student_number LIKE 'B-OVPSA-%'",
    )).rows.map((row) => row.id);
    const closureIds = (await client.query<{ id: string }>(
      "SELECT id::text FROM clinic_closure_groups WHERE reason LIKE 'B-OVPSA%'",
    )).rows.map((row) => row.id);
    await client.query("DELETE FROM audit_logs WHERE entity_id LIKE 'bf190000-%' OR metadata::text LIKE '%B-OVPSA%' OR metadata::text LIKE '%bf190000-%' OR actor_user_id=$1", [OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.id]);
    await client.query("DELETE FROM email_outbox WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM student_portal_notifications WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications DISABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query("DELETE FROM ovpsa_external_laboratory_verifications WHERE appointment_id=ANY($1::uuid[])", [appointmentIds]);
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications ENABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query("DELETE FROM laboratory_results WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM exam_results WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM appointment_reschedule_event_unavailable_dates WHERE event_id IN (SELECT id FROM appointment_reschedule_events WHERE student_number LIKE 'B-OVPSA-%' OR ovpsa_batch_id=ANY($1::uuid[]))", [batchIds]);
    await client.query("DELETE FROM appointment_reschedule_events WHERE student_number LIKE 'B-OVPSA-%' OR ovpsa_batch_id=ANY($1::uuid[])", [batchIds]);
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id=ANY($1::uuid[])", [appointmentIds]);
    await client.query("DELETE FROM appointments WHERE id=ANY($1::uuid[])", [appointmentIds]);
    await client.query("DELETE FROM coordinator_schedule_items WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM schedule_batches WHERE batch_name LIKE 'B-OVPSA%'");
    await client.query("DELETE FROM schedule_import_groups WHERE import_name LIKE 'B-OVPSA%' OR source_filename LIKE 'B-OVPSA%'");
    await client.query("DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id=ANY($1::uuid[])", [batchIds]);
    await client.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id=ANY($1::uuid[])", [batchIds]);
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id=ANY($1::uuid[])", [batchIds]);
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("ALTER TABLE ovpsa_first_year_batches DISABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id=ANY($1::uuid[])", [batchIds]);
    await client.query("ALTER TABLE ovpsa_first_year_batches ENABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id=ANY($1::uuid[])", [batchIds]);
    await client.query("DELETE FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])", [batchIds]);
    await client.query("DELETE FROM clinic_calendar_requests WHERE batch_id IN (SELECT creation_batch_id FROM clinic_closure_groups WHERE id=ANY($1::uuid[]))", [closureIds]);
    await client.query("DELETE FROM clinic_unavailable_dates WHERE closure_group_id=ANY($1::uuid[])", [closureIds]);
    await client.query("DELETE FROM clinic_closure_groups WHERE id=ANY($1::uuid[])", [closureIds]);
    await client.query("DELETE FROM student_login_attempts WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM student_email_verifications WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM student_academic_snapshots WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM students WHERE student_number LIKE 'B-OVPSA-%'");
    await client.query("DELETE FROM users WHERE id=$1", [OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.id]);
    await client.query("DELETE FROM programs WHERE id IN ($1::uuid,$2::uuid)", [OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedProgram.id]);
    await client.query("DELETE FROM colleges WHERE id IN ($1::uuid,$2::uuid)", [OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function setup(client: PoolClient, databaseIdentity: DatabaseIdentity) {
  const existingState = await readState();
  if (existingState) {
    assertSame(databaseIdentity, existingState);
    await deleteFixture(client);
  } else {
    const before = await residue(client);
    if (Object.entries(before).some(([key, count]) => key !== "stateFiles" && count !== 0)) {
      throw new Error(`Refusing to overwrite untracked First Year OVPSA fixtures: ${JSON.stringify(before)}.`);
    }
  }
  await mkdir(DIRECTORY, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify({ databaseIdentity, preparedAt: new Date().toISOString() } satisfies State, null, 2)}\n`, "utf8");
  const passwordHash = await hash(OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.password, 10);
  await client.query("BEGIN");
  try {
    const academicYear = await client.query(
      `SELECT 1 FROM academic_years WHERE start_year=$1 AND closing_date >= '2026-08-12'`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.cycleStart],
    );
    if (!academicYear.rowCount) {
      throw new Error("Configure the open 2026 academic year before preparing the fixture.");
    }
    await client.query(
      `INSERT INTO colleges (id,code,name) VALUES ($1,$2,$3),($4,$5,$6)`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.code, OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.name,
        OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.code, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.name],
    );
    await client.query(
      `INSERT INTO programs (id,college_id,code,name) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.id, OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.code, OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.name,
        OVPSA_FIRST_YEAR_ACCEPTANCE.blockedProgram.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedProgram.code, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedProgram.name],
    );
    await client.query(
      `INSERT INTO students (student_number,first_name,middle_name,last_name,college_id,program_id,year_level,date_of_birth)
       VALUES
        ($1,'Acceptance','Maria Angela','Member One',$6,$7,1,$10),
        ($2,'Acceptance','De la Cruz','Member Two',$6,$7,1,$11),
        ($3,'Acceptance','Louise','Blocked Member',$8,$9,1,$12),
        ($4,'Acceptance','Lower','Displaced',$6,$7,4,'2004-01-01'),
        ($5,'Acceptance','Protected','Conflict',$8,$9,4,'2004-01-02')`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.students.member.number, OVPSA_FIRST_YEAR_ACCEPTANCE.students.secondMember.number,
        OVPSA_FIRST_YEAR_ACCEPTANCE.students.blockedMember.number, OVPSA_FIRST_YEAR_ACCEPTANCE.students.displaced,
        OVPSA_FIRST_YEAR_ACCEPTANCE.students.protected, OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id,
        OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id,
        OVPSA_FIRST_YEAR_ACCEPTANCE.blockedProgram.id,
        OVPSA_FIRST_YEAR_ACCEPTANCE.students.member.dateOfBirth, OVPSA_FIRST_YEAR_ACCEPTANCE.students.secondMember.dateOfBirth,
        OVPSA_FIRST_YEAR_ACCEPTANCE.students.blockedMember.dateOfBirth],
    );
    await client.query(
      `INSERT INTO users (id,full_name,email,password_hash,role,clinic_id)
       VALUES ($1,'Browser OVPSA CPU Staff',$2,$3,'CLINIC_STAFF',$4)`,
      [OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.id, OVPSA_FIRST_YEAR_ACCEPTANCE.cpuStaff.email, passwordHash, PE_CLINIC_ID],
    );
    await client.query(
      `INSERT INTO schedule_batches (
         id,clinic_id,batch_name,college_id,program_id,status,created_by,published_by,published_at
       ) VALUES ($1,$2,'B-OVPSA lower-priority acceptance',$3,$4,'PUBLISHED',$5,$5,clock_timestamp())`,
      [LOWER_PRIORITY_BATCH_ID, LAB_CLINIC_ID, OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id,
        OVPSA_FIRST_YEAR_ACCEPTANCE.mainProgram.id, ADMIN_ID],
    );
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,batch_id,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,scheduling_window_start,scheduling_window_end,
         is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES
        ($1,$3,'LABORATORY',$5,'PENDING',TRUE,$7,$8,$9,$9,$11,'REGULAR','2026-08-01T00:00:00Z',1,'2026-08-01','2027-07-31',FALSE,NULL,NULL,NULL),
        ($2,$3,'PHYSICAL_EXAM','2026-09-15','PENDING',TRUE,$7,$8,$9,$9,$11,'REGULAR','2026-08-01T00:00:00Z',1,'2026-08-01','2027-07-31',FALSE,NULL,NULL,NULL),
        ($1,$4,'LABORATORY',$6,'PENDING',TRUE,$10,$8,$9,$9,$11,'REGULAR','2026-08-02T00:00:00Z',2,'2026-08-01','2027-07-31',TRUE,$9,clock_timestamp(),'B-OVPSA protected conflict'),
        ($2,$4,'PHYSICAL_EXAM','2026-09-29','PENDING',TRUE,$10,$8,$9,$9,$11,'REGULAR','2026-08-02T00:00:00Z',2,'2026-08-01','2027-07-31',FALSE,NULL,NULL,NULL)`,
      [LAB_CLINIC_ID, PE_CLINIC_ID, OVPSA_FIRST_YEAR_ACCEPTANCE.students.displaced, OVPSA_FIRST_YEAR_ACCEPTANCE.students.protected,
        OVPSA_FIRST_YEAR_ACCEPTANCE.dates.mainLaboratory, OVPSA_FIRST_YEAR_ACCEPTANCE.dates.blockedLaboratory,
        "bf190000-0000-4000-8000-000000000031", OVPSA_FIRST_YEAR_ACCEPTANCE.cycleStart, ADMIN_ID,
        "bf190000-0000-4000-8000-000000000032", LOWER_PRIORITY_BATCH_ID],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batches (
         id,schedule_cycle_start,college_id,status,optimistic_token,created_by,updated_by,current_revision_id
       ) VALUES
        ($1,$3,$4,'DRAFT','bf190000-0000-4000-8000-000000000061',$6,$6,NULL),
        ($2,$3,$5,'DRAFT','bf190000-0000-4000-8000-000000000062',$6,$6,NULL)`,
      [MAIN_BATCH_ID, BLOCKED_BATCH_ID, OVPSA_FIRST_YEAR_ACCEPTANCE.cycleStart,
        OVPSA_FIRST_YEAR_ACCEPTANCE.mainCollege.id, OVPSA_FIRST_YEAR_ACCEPTANCE.blockedCollege.id, ADMIN_ID],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         id,batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by
       ) VALUES
        ($1,$3,1,'DRAFT',$5,$6,$9),
        ($2,$4,1,'DRAFT',$7,$8,$9)`,
      [MAIN_REVISION_ID, BLOCKED_REVISION_ID, MAIN_BATCH_ID, BLOCKED_BATCH_ID,
        OVPSA_FIRST_YEAR_ACCEPTANCE.dates.mainLaboratory, OVPSA_FIRST_YEAR_ACCEPTANCE.dates.mainPhysicalExam,
        OVPSA_FIRST_YEAR_ACCEPTANCE.dates.blockedLaboratory, OVPSA_FIRST_YEAR_ACCEPTANCE.dates.blockedPhysicalExam,
        ADMIN_ID],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batches
          SET current_revision_id=CASE id WHEN $1::uuid THEN $3::uuid ELSE $4::uuid END
        WHERE id IN ($1::uuid,$2::uuid)`,
      [MAIN_BATCH_ID, BLOCKED_BATCH_ID, MAIN_REVISION_ID, BLOCKED_REVISION_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { mode: "setup", databaseIdentity, fixture: OVPSA_FIRST_YEAR_ACCEPTANCE, residue: await residue(client) };
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error("Use setup, status, or cleanup for the First Year OVPSA acceptance fixture.");
  }
  const databaseIdentity = identity(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const state = await readState();
      if (mode !== "setup") {
        if (!state) throw new Error("Run setup before status or cleanup.");
        assertSame(databaseIdentity, state);
      }
      if (mode === "setup") console.log(JSON.stringify(await setup(client, databaseIdentity), null, 2));
      if (mode === "status") console.log(JSON.stringify({ mode, databaseIdentity, fixture: OVPSA_FIRST_YEAR_ACCEPTANCE, residue: await residue(client) }, null, 2));
      if (mode === "cleanup") {
        await deleteFixture(client);
        await rm(DIRECTORY, { recursive: true, force: true });
        console.log(JSON.stringify({ mode, databaseIdentity, residue: assertZero(await residue(client)) }, null, 2));
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) await run();
