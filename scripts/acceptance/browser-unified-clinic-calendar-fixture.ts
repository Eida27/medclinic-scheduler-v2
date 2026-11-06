import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const stateFile = resolve(process.cwd(), ".data", "browser-unified-clinic-calendar.json");
const reasonPrefix = "BROWSER-UNIFIED-20260727";
const adminUserId = "00000000-0000-4000-8000-000000000001";
const laboratoryClinicId = "60000000-0000-4000-8000-000000000001";
const physicalExamClinicId = "60000000-0000-4000-8000-000000000002";
const collegeId = "10000000-0000-4000-8000-000000000003";
const programId = "20000000-0000-4000-8000-000000000003";
const students = ["B-UCAL-PAIR", "B-UCAL-PHYS", "B-UCAL-MANUAL"] as const;
const keepCurrentCaseId = "ba000000-0000-4000-8000-000000000051";

type FixtureState = { startedAt: string };

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("The Browser fixture requires a loopback PostgreSQL database.");
  }
  if (process.env.CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE !== "1") {
    throw new Error("Set CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE=1 after confirming database exclusivity.");
  }
  return value;
}

async function readState(): Promise<FixtureState | undefined> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as FixtureState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function setup(client: pg.Client) {
  if (await readState()) throw new Error("A Browser fixture state already exists. Run cleanup first.");
  const residue = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM students WHERE student_number=ANY($1::varchar[])`,
    [students],
  );
  if (residue.rows[0].count) throw new Error("Tagged Browser students already exist. Clean them before setup.");
  const startedAt = new Date().toISOString();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO students (
         student_number,first_name,last_name,college_id,program_id,year_level,date_of_birth,
         email,email_verified_at,is_active
       ) VALUES
         ($1,'Pair','Browser',$4,$5,4,'2004-01-02','browser-pair@example.test',NOW(),TRUE),
         ($2,'Physical','Browser',$4,$5,4,'2004-01-02','browser-physical@example.test',NOW(),TRUE),
         ($3,'Manual','Browser',$4,$5,4,'2004-01-02','browser-manual@example.test',NOW(),TRUE)`,
      [...students, collegeId, programId],
    );
    await client.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,
         is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES
         ('ba000000-0000-4000-8000-000000000001',$1,$3,'LABORATORY','2027-08-03','PENDING',TRUE,'ba000000-0000-4000-8000-000000000011',2027,$5,$5,FALSE,NULL,NULL,NULL),
         ('ba000000-0000-4000-8000-000000000002',$2,$3,'PHYSICAL_EXAM','2027-08-04','PENDING',TRUE,'ba000000-0000-4000-8000-000000000011',2027,$5,$5,FALSE,NULL,NULL,NULL),
         ('ba000000-0000-4000-8000-000000000003',$1,$4,'LABORATORY','2027-08-03','COMPLETED',TRUE,'ba000000-0000-4000-8000-000000000012',2027,$5,$5,FALSE,NULL,NULL,NULL),
         ('ba000000-0000-4000-8000-000000000004',$2,$4,'PHYSICAL_EXAM','2027-08-04','PENDING',TRUE,'ba000000-0000-4000-8000-000000000012',2027,$5,$5,FALSE,NULL,NULL,NULL),
         ('ba000000-0000-4000-8000-000000000005',$1,$6,'LABORATORY','2027-08-03','PENDING',TRUE,'ba000000-0000-4000-8000-000000000013',2027,$5,$5,FALSE,NULL,NULL,NULL),
         ('ba000000-0000-4000-8000-000000000006',$2,$6,'PHYSICAL_EXAM','2027-08-04','PENDING',TRUE,'ba000000-0000-4000-8000-000000000013',2027,$5,$5,TRUE,$5,NOW(),$7)`,
      [
        laboratoryClinicId,
        physicalExamClinicId,
        students[0],
        students[1],
        adminUserId,
        students[2],
        `${reasonPrefix} force manual resolution`,
      ],
    );
    await client.query("COMMIT");
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify({ startedAt }, null, 2)}\n`, "utf8");
    return { startedAt, students, closureDates: ["2027-08-03", "2027-08-04"] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedKeepCurrent(client: pg.Client) {
  const event = await client.query<{
    id: string;
    closure_group_id: string;
    schedule_pair_id: string;
    schedule_cycle_start: number;
    old_laboratory_appointment_id: string;
    old_physical_exam_appointment_id: string;
  }>(
    `SELECT id::text,closure_group_id::text,schedule_pair_id::text,schedule_cycle_start,
            old_laboratory_appointment_id::text,old_physical_exam_appointment_id::text
       FROM appointment_reschedule_events
      WHERE student_number=$1 AND outcome='REPLACED'
      ORDER BY created_at DESC LIMIT 1`,
    [students[0]],
  );
  if (!event.rows[0]) throw new Error("Block the paired Browser student before seeding keep-current review.");
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO clinic_closure_manual_cases (
         id,student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
         reason_code,reason_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'UNSAFE_RESTORATION',$8)`,
      [
        keepCurrentCaseId,
        students[0],
        event.rows[0].closure_group_id,
        event.rows[0].schedule_pair_id,
        event.rows[0].schedule_cycle_start,
        event.rows[0].old_laboratory_appointment_id,
        event.rows[0].old_physical_exam_appointment_id,
        `${reasonPrefix} review the safe current replacement`,
      ],
    );
    await client.query(
      "UPDATE appointment_reschedule_events SET manual_case_id=$2 WHERE id=$1",
      [event.rows[0].id, keepCurrentCaseId],
    );
    await client.query("COMMIT");
    return { manualCaseId: keepCurrentCaseId, studentNumber: students[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function status(client: pg.Client) {
  const state = await readState();
  const appointments = await client.query(
      `SELECT student_number,schedule_type,appointment_date::text,status,is_published,
              rescheduled_from::text,is_manually_locked
         FROM appointments WHERE student_number=ANY($1::varchar[])
        ORDER BY student_number,appointment_date,schedule_type`,
      [students],
    );
  const closures = await client.query(
      `SELECT unavailable.id::text,unavailable.blocked_date::text,unavailable.reopened_at,
              closure.start_date::text,closure.end_date::text,closure.reason
         FROM clinic_unavailable_dates unavailable
         JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
        WHERE closure.reason LIKE $1 ORDER BY unavailable.blocked_date`,
      [`${reasonPrefix}%`],
    );
  const cases = await client.query(
      `SELECT id::text,student_number,status,resolution_action,reason_code
         FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])
        ORDER BY created_at,id`,
      [students],
    );
  const requests = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM clinic_calendar_requests
        WHERE created_at >= COALESCE($1::timestamptz,NOW())`,
      [state?.startedAt ?? null],
    );
  const notifications = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])",
      [students],
    );
  const outbox = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM email_outbox WHERE student_number=ANY($1::varchar[])",
      [students],
    );
  return {
    appointments: appointments.rows,
    closures: closures.rows,
    manualCases: cases.rows,
    requestCount: requests.rows[0].count,
    notificationCount: notifications.rows[0].count,
    outboxCount: outbox.rows[0].count,
  };
}

async function cleanup(client: pg.Client) {
  const state = await readState();
  if (!state) throw new Error("Fixture state is missing; refusing broad time-based cleanup.");
  await client.query("BEGIN");
  try {
    const requestRows = await client.query<{ request_id: string; batch_id: string }>(
      `SELECT request_id::text,batch_id::text FROM clinic_calendar_requests
        WHERE created_at >= $1::timestamptz AND created_by=$2`,
      [state.startedAt, adminUserId],
    );
    const requestIds = requestRows.rows.map((row) => row.request_id);
    const batchIds = requestRows.rows.map((row) => row.batch_id);
    await client.query(
      `DELETE FROM audit_logs
        WHERE metadata->>'studentNumber'=ANY($1::text[])
           OR metadata->>'requestId'=ANY($2::text[])
           OR metadata->>'batchId'=ANY($3::text[])
           OR (created_at >= $4::timestamptz AND action LIKE 'UNIFIED_CLINIC_CALENDAR%')`,
      [students, requestIds, batchIds, state.startedAt],
    );
    await client.query("DELETE FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM email_outbox WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM student_email_verifications WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM student_login_attempts WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM appointment_reschedule_events WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM clinic_closure_manual_cases WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query(
      "DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number=ANY($1::varchar[]))",
      [students],
    );
    await client.query("DELETE FROM exam_results WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM laboratory_results WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM student_result_submissions WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM appointments WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])", [requestIds]);
    await client.query(
      `DELETE FROM clinic_unavailable_dates
        WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE $1)`,
      [`${reasonPrefix}%`],
    );
    await client.query("DELETE FROM clinic_closure_groups WHERE reason LIKE $1", [`${reasonPrefix}%`]);
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [students]);
    await client.query("COMMIT");
    await rm(stateFile, { force: true });
    return { cleaned: true, students: students.length, requests: requestIds.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const result = command === "setup"
      ? await setup(client)
      : command === "seed-keep-current"
        ? await seedKeepCurrent(client)
        : command === "status"
          ? await status(client)
          : command === "cleanup"
            ? await cleanup(client)
            : undefined;
    if (!result) throw new Error("Use setup, seed-keep-current, status, or cleanup.");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

await main();
