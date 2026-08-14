import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const STATE_FILE = resolve(process.cwd(), ".data", "browser-clinic-closure-recovery.json");
const MARKER = "BROWSER-CLINIC-CLOSURE-RECOVERY-20260814";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const LAB_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PE_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const COLLEGE_ID = "cc210000-0000-4000-8000-000000000001";
const PROGRAM_ID = "cc210000-0000-4000-8000-000000000002";
const OVPSA_BATCH_ID = "cc210000-0000-4000-8000-000000000003";
const OVPSA_REVISION_ID = "cc210000-0000-4000-8000-000000000004";
const OVPSA_SNAPSHOT_ID = "cc210000-0000-4000-8000-000000000005";
const OVPSA_LAB_RESERVATION_ID = "cc210000-0000-4000-8000-000000000006";
const OVPSA_PE_RESERVATION_ID = "cc210000-0000-4000-8000-000000000007";
const WARNING_FUNCTION = "browser_clinic_closure_recovery_fail_outbox";
const WARNING_TRIGGER = "browser_clinic_closure_recovery_fail_outbox_trigger";
const STUDENTS = [
  "B-CCR-A",
  "B-CCR-B",
  "B-CCR-C",
  "B-CCR-D",
  "B-CCR-E",
  "B-CCR-F",
] as const;
const CLOSURE_DATES = [
  "2026-09-10",
  "2026-09-11",
  "2026-09-14",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
] as const;

type State = {
  databaseIdentity: string;
  startedAt: string;
};

function databaseIdentity(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Clinic closure recovery acceptance requires loopback PostgreSQL.");
  }
  if (process.env.CLINIC_CLOSURE_RECOVERY_ACCEPTANCE_EXCLUSIVE_DATABASE !== "1") {
    throw new Error(
      "Set CLINIC_CLOSURE_RECOVERY_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a dedicated local acceptance database.",
    );
  }
  return `${parsed.protocol}//${host}:${parsed.port || "5432"}/${decodeURI(parsed.pathname.slice(1))}`;
}

async function readState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function residue(client: pg.Client) {
  const result = await client.query<{
    students: number;
    colleges: number;
    batches: number;
    appointments: number;
    closures: number;
    cases: number;
    events: number;
    notifications: number;
    outbox: number;
    triggers: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM colleges WHERE id=$2) AS colleges,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batches WHERE id=$3) AS batches,
       (SELECT COUNT(*)::int FROM appointments WHERE student_number=ANY($1::varchar[])) AS appointments,
       (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE reason LIKE $4) AS closures,
       (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])) AS cases,
       (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])) AS events,
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=ANY($1::varchar[])) AS outbox,
       (SELECT COUNT(*)::int FROM pg_trigger WHERE tgname=$5 AND NOT tgisinternal) AS triggers`,
    [STUDENTS, COLLEGE_ID, OVPSA_BATCH_ID, `${MARKER}%`, WARNING_TRIGGER],
  );
  return result.rows[0];
}

function assertZero(value: Awaited<ReturnType<typeof residue>>) {
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`Clinic closure recovery fixture residue remains: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function setup(client: pg.Client, identity: string) {
  if (await readState()) throw new Error("Run cleanup before preparing this Browser fixture again.");
  assertZero(await residue(client));
  const collision = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM appointments
      WHERE appointment_date=ANY($1::date[])
        AND status IN ('PENDING','AWAITING_RESCHEDULE','COMPLETED')`,
    [CLOSURE_DATES],
  );
  if (collision.rows[0].count) {
    throw new Error("The acceptance dates already contain effective appointments; use a dedicated local database.");
  }
  const blocked = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM clinic_unavailable_dates
      WHERE blocked_date=ANY($1::date[]) AND reopened_at IS NULL`,
    [CLOSURE_DATES],
  );
  if (blocked.rows[0].count) throw new Error("An acceptance date is already unavailable.");

  const startedAt = new Date().toISOString();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO colleges (id,code,name) VALUES ($1,'BCCR','Browser Closure Recovery College')`,
      [COLLEGE_ID],
    );
    await client.query(
      `INSERT INTO programs (id,college_id,code,name) VALUES ($1,$2,'BCCR','Browser Closure Recovery Program')`,
      [PROGRAM_ID, COLLEGE_ID],
    );
    await client.query(
      `INSERT INTO students (
         student_number,first_name,middle_name,last_name,college_id,program_id,year_level,
         date_of_birth,email,email_verified_at,is_active
       ) SELECT row.student_number,'Recovery',row.letter,'Browser',$2,$3,row.year_level,
                '2004-01-02',LOWER(row.student_number)||'@example.test',clock_timestamp(),TRUE
           FROM jsonb_to_recordset($1::jsonb)
             AS row(student_number varchar,letter varchar,year_level integer)`,
      [
        JSON.stringify(STUDENTS.map((studentNumber, index) => ({
          student_number: studentNumber,
          letter: String.fromCharCode(65 + index),
          year_level: index === 3 ? 1 : 4,
        }))),
        COLLEGE_ID,
        PROGRAM_ID,
      ],
    );

    const regularPairs = [
      { student: STUDENTS[0], pair: "cc210000-0000-4000-8000-000000000011", lab: "2026-09-10", pe: "2026-09-17", category: "REGULAR", order: 1, lockedPe: false },
      { student: STUDENTS[1], pair: "cc210000-0000-4000-8000-000000000012", lab: "2026-09-11", pe: "2026-09-18", category: "OJT", order: 2, lockedPe: false },
      { student: STUDENTS[2], pair: "cc210000-0000-4000-8000-000000000013", lab: "2026-09-14", pe: "2026-09-21", category: "TOUR", order: 3, lockedPe: false },
      { student: STUDENTS[4], pair: "cc210000-0000-4000-8000-000000000015", lab: "2026-09-29", pe: "2026-10-06", category: "SPECIALIZED", order: 4, lockedPe: false },
      { student: STUDENTS[5], pair: "cc210000-0000-4000-8000-000000000016", lab: "2026-09-30", pe: "2026-10-07", category: "REGULAR", order: 5, lockedPe: true },
    ];
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,is_manually_locked,
         locked_by,locked_at,lock_reason
       )
       SELECT $2::uuid,row.student_number,'LABORATORY',row.lab_date,'PENDING',TRUE,
              row.pair_id,2026,$4::uuid,$4::uuid,row.category,
              '2026-08-01T00:00:00Z'::timestamptz + row.source_order * interval '1 second',
              row.source_order,FALSE,NULL,NULL,NULL
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number varchar,pair_id uuid,lab_date date,pe_date date,
           category varchar,source_order integer,locked_pe boolean
         )
       UNION ALL
       SELECT $3::uuid,row.student_number,'PHYSICAL_EXAM',row.pe_date,'PENDING',TRUE,
              row.pair_id,2026,$4::uuid,$4::uuid,row.category,
              '2026-08-01T00:00:00Z'::timestamptz + row.source_order * interval '1 second',
              row.source_order,row.locked_pe,
              CASE WHEN row.locked_pe THEN $4::uuid END,
              CASE WHEN row.locked_pe THEN clock_timestamp() END,
              CASE WHEN row.locked_pe THEN $5 END
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number varchar,pair_id uuid,lab_date date,pe_date date,
           category varchar,source_order integer,locked_pe boolean
         )`,
      [
        JSON.stringify(regularPairs.map((row) => ({
          student_number: row.student,
          pair_id: row.pair,
          lab_date: row.lab,
          pe_date: row.pe,
          category: row.category,
          source_order: row.order,
          locked_pe: row.lockedPe,
        }))),
        LAB_CLINIC_ID,
        PE_CLINIC_ID,
        ADMIN_ID,
        `${MARKER} locked Physical Examination`,
      ],
    );

    await client.query(
      `INSERT INTO student_academic_snapshots (
         id,student_number,academic_year_start,student_name,college_id,college_name,
         program_id,program_code,program_name,year_level,source_type,source_metadata
       ) VALUES ($1,$2,2026,'Recovery D Browser',$3,'Browser Closure Recovery College',
                 $4,'BCCR','Browser Closure Recovery Program',1,'VERIFIED_HISTORICAL',$5::jsonb)`,
      [OVPSA_SNAPSHOT_ID, STUDENTS[3], COLLEGE_ID, PROGRAM_ID, JSON.stringify({ marker: MARKER })],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batches (
         id,schedule_cycle_start,college_id,status,created_by,updated_by,published_by,published_at
       ) VALUES ($1,2026,$2,'PUBLISHED',$3,$3,$3,clock_timestamp())`,
      [OVPSA_BATCH_ID, COLLEGE_ID, ADMIN_ID],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         id,batch_id,revision_number,status,laboratory_date,physical_exam_date,
         validation_snapshot,validated_by,validated_at,published_by,published_at,created_by
       ) VALUES ($1,$2,1,'PUBLISHED','2026-10-05','2026-10-12',$3::jsonb,$4,clock_timestamp(),$4,clock_timestamp(),$4)`,
      [OVPSA_REVISION_ID, OVPSA_BATCH_ID, JSON.stringify({ marker: MARKER, memberCount: 1 }), ADMIN_ID],
    );
    await client.query(
      "UPDATE ovpsa_first_year_batches SET current_revision_id=$2 WHERE id=$1",
      [OVPSA_BATCH_ID, OVPSA_REVISION_ID],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_membership_snapshots (
         revision_id,batch_id,student_number,academic_snapshot_id,student_name,
         college_id,college_name,program_id,program_code,program_name,year_level
       ) VALUES ($1,$2,$3,$4,'Recovery D Browser',$5,'Browser Closure Recovery College',
                 $6,'BCCR','Browser Closure Recovery Program',1)`,
      [OVPSA_REVISION_ID, OVPSA_BATCH_ID, STUDENTS[3], OVPSA_SNAPSHOT_ID, COLLEGE_ID, PROGRAM_ID],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_active_memberships (
         batch_id,revision_id,student_number,schedule_cycle_start
       ) VALUES ($1,$2,$3,2026)`,
      [OVPSA_BATCH_ID, OVPSA_REVISION_ID, STUDENTS[3]],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_service_reservations (
         id,batch_id,revision_id,schedule_type,reservation_date,status,created_by,reservation_kind
       ) VALUES
         ($1,$3,$4,'LABORATORY','2026-10-05','ACTIVE',$5,'EXCLUSIVE'),
         ($2,$3,$4,'PHYSICAL_EXAM','2026-10-12','ACTIVE',$5,'EXCLUSIVE')`,
      [OVPSA_LAB_RESERVATION_ID, OVPSA_PE_RESERVATION_ID, OVPSA_BATCH_ID, OVPSA_REVISION_ID, ADMIN_ID],
    );
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,notes,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,ovpsa_batch_id,
         ovpsa_revision_id,ovpsa_service_reservation_id
       ) VALUES
         ($1,$3,'LABORATORY','2026-10-05','PENDING',TRUE,'External Laboratory at Iloilo Mission Hospital.',$4,2026,$5,$5,$6,$7,$8),
         ($2,$3,'PHYSICAL_EXAM','2026-10-12','PENDING',TRUE,'First Year OVPSA Physical Examination at CPU Clinic.',$4,2026,$5,$5,$6,$7,$9)`,
      [
        LAB_CLINIC_ID,
        PE_CLINIC_ID,
        STUDENTS[3],
        "cc210000-0000-4000-8000-000000000014",
        ADMIN_ID,
        OVPSA_BATCH_ID,
        OVPSA_REVISION_ID,
        OVPSA_LAB_RESERVATION_ID,
        OVPSA_PE_RESERVATION_ID,
      ],
    );
    await client.query(
      `CREATE OR REPLACE FUNCTION ${WARNING_FUNCTION}()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.student_number='B-CCR-C' THEN
           RAISE EXCEPTION '${MARKER} simulated queue failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await client.query(
      `CREATE TRIGGER ${WARNING_TRIGGER}
       BEFORE INSERT ON email_outbox FOR EACH ROW
       EXECUTE FUNCTION ${WARNING_FUNCTION}()`,
    );
    await client.query("COMMIT");
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify({ databaseIdentity: identity, startedAt }, null, 2)}\n`, "utf8");
    return {
      mode: "setup",
      login: { email: "admin@medclinic.local", password: "Admin123!" },
      students: STUDENTS,
      closureDates: CLOSURE_DATES,
      ovpsaBatchId: OVPSA_BATCH_ID,
      expected: { automatic: 2, manual: 4, notificationWarnings: 1 },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function status(client: pg.Client) {
  const state = await readState();
  if (!state) throw new Error("Run setup before status.");
  const appointments = await client.query(
    `SELECT student_number,schedule_type,appointment_date::text,status,is_published,
            rescheduled_from::text,ovpsa_revision_id::text
       FROM appointments WHERE student_number=ANY($1::varchar[])
      ORDER BY student_number,appointment_date,schedule_type`,
    [STUDENTS],
  );
  const cases = await client.query(
    `SELECT id::text,student_number,status,reason_code,policy_metadata->>'ovpsaBatchId' AS ovpsa_batch_id,
            optimistic_token::text,policy_metadata
       FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])
      ORDER BY student_number,created_at`,
    [STUDENTS],
  );
  const events = await client.query(
    `SELECT id::text,student_number,strategy,outcome,manual_case_id::text,
            old_laboratory_appointment_id::text,new_laboratory_appointment_id::text,
            old_physical_exam_appointment_id::text,new_physical_exam_appointment_id::text
       FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])
      ORDER BY student_number,created_at`,
    [STUDENTS],
  );
  const groups = await client.query(
    `SELECT closure.id::text,closure.start_date::text,closure.end_date::text,
            closure.category,closure.recovery_mode,closure.policy_effective_date::text,
            BOOL_AND(unavailable.reopened_at IS NOT NULL) AS fully_reopened
       FROM clinic_closure_groups closure
       JOIN clinic_unavailable_dates unavailable ON unavailable.closure_group_id=closure.id
      WHERE closure.reason LIKE $1
      GROUP BY closure.id
      ORDER BY closure.start_date`,
    [`${MARKER}%`],
  );
  const notifications = await client.query(
    `SELECT student_number,notification_type,event_key FROM student_portal_notifications
      WHERE student_number=ANY($1::varchar[]) ORDER BY student_number,created_at`,
    [STUDENTS],
  );
  const outbox = await client.query(
    `SELECT student_number,status,event_key FROM email_outbox
      WHERE student_number=ANY($1::varchar[]) ORDER BY student_number,created_at`,
    [STUDENTS],
  );
  const batch = await client.query(
    `SELECT batch.status,batch.optimistic_token::text,batch.current_revision_id::text,
            revision.revision_number,revision.laboratory_date::text,revision.physical_exam_date::text
       FROM ovpsa_first_year_batches batch
       JOIN ovpsa_first_year_batch_revisions revision ON revision.id=batch.current_revision_id
      WHERE batch.id=$1`,
    [OVPSA_BATCH_ID],
  );
  const requests = await client.query(
    `SELECT request_id::text,result FROM clinic_calendar_requests
      WHERE created_by=$1 AND created_at >= $2::timestamptz ORDER BY created_at`,
    [ADMIN_ID, state.startedAt],
  );
  return {
    mode: "status",
    appointments: appointments.rows,
    manualCases: cases.rows,
    rescheduleEvents: events.rows,
    closureGroups: groups.rows,
    notifications: notifications.rows,
    outbox: outbox.rows,
    ovpsaBatch: batch.rows[0] ?? null,
    requests: requests.rows,
  };
}

async function cleanup(client: pg.Client) {
  const state = await readState();
  if (!state) throw new Error("Fixture state is missing; refusing untracked cleanup.");
  await client.query("BEGIN");
  try {
    await client.query(`DROP TRIGGER IF EXISTS ${WARNING_TRIGGER} ON email_outbox`);
    await client.query(`DROP FUNCTION IF EXISTS ${WARNING_FUNCTION}()`);
    await client.query(
      `CREATE TEMP TABLE acceptance_appointments ON COMMIT DROP AS
       WITH RECURSIVE related AS (
         SELECT id FROM appointments WHERE student_number=ANY($1::varchar[])
         UNION
         SELECT child.id FROM appointments child JOIN related parent ON child.rescheduled_from=parent.id
       ) SELECT id FROM related`,
      [STUDENTS],
    );
    await client.query(
      `DELETE FROM audit_logs
        WHERE metadata::text LIKE $1
           OR metadata->>'studentNumber'=ANY($2::text[])
           OR entity_id=$3`,
      [`%${MARKER}%`, STUDENTS, OVPSA_BATCH_ID],
    );
    await client.query("DELETE FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM email_outbox WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM student_email_verifications WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM student_login_attempts WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query(
      `DELETE FROM appointment_reschedule_event_unavailable_dates
        WHERE event_id IN (SELECT id FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[]))`,
      [STUDENTS],
    );
    await client.query("DELETE FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM acceptance_appointments)");
    await client.query("DELETE FROM laboratory_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM acceptance_appointments)", [STUDENTS]);
    await client.query("DELETE FROM exam_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM acceptance_appointments)", [STUDENTS]);
    await client.query("DELETE FROM appointments WHERE id IN (SELECT id FROM acceptance_appointments)");
    await client.query("DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id=$1", [OVPSA_BATCH_ID]);
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id=$1", [OVPSA_BATCH_ID]);
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id=$1", [OVPSA_BATCH_ID]);
    await client.query("ALTER TABLE ovpsa_first_year_batches DISABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id=$1", [OVPSA_BATCH_ID]);
    await client.query("ALTER TABLE ovpsa_first_year_batches ENABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id=$1", [OVPSA_BATCH_ID]);
    await client.query("DELETE FROM ovpsa_first_year_batches WHERE id=$1", [OVPSA_BATCH_ID]);
    await client.query(
      `DELETE FROM clinic_calendar_requests
        WHERE created_by=$1 AND created_at >= $2::timestamptz`,
      [ADMIN_ID, state.startedAt],
    );
    await client.query(
      `DELETE FROM clinic_unavailable_dates
        WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE $1)`,
      [`${MARKER}%`],
    );
    await client.query("DELETE FROM clinic_closure_groups WHERE reason LIKE $1", [`${MARKER}%`]);
    await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM student_academic_snapshots WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [STUDENTS]);
    await client.query("DELETE FROM programs WHERE id=$1", [PROGRAM_ID]);
    await client.query("DELETE FROM colleges WHERE id=$1", [COLLEGE_ID]);
    await client.query("COMMIT");
    await rm(STATE_FILE, { force: true });
    return { mode: "cleanup", residue: assertZero(await residue(client)) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error("Use setup, status, or cleanup for the clinic closure recovery Browser fixture.");
  }
  const identity = databaseIdentity(process.env.DATABASE_URL);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const state = await readState();
    if (state && state.databaseIdentity !== identity) {
      throw new Error("The fixture state belongs to a different database.");
    }
    const result = mode === "setup"
      ? await setup(client, identity)
      : mode === "status"
        ? await status(client)
        : await cleanup(client);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

await main();
