import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { cleanupTestFixtures } from "@/test/integration-fixtures";

const statePath = resolve(".data/browser-manual-resolution.json");
const students = ["BMR-20260928-0", "BMR-20260928-1"];
const year = 2098;
const importName = "BMR 20260928 browser import";
const batchName = "BMR 20260928 browser batch";
type State = { database: string; caseIds: string[]; importId: string; yearCreated: boolean };

function databaseIdentity() {
  assert.equal(process.env.BROWSER_MANUAL_ACCEPTANCE_LOCAL_TEST_DB, "1", "Set BROWSER_MANUAL_ACCEPTANCE_LOCAL_TEST_DB=1.");
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "A loopback database is required.");
  const name = decodeURIComponent(url.pathname.slice(1));
  assert.ok(name && !["postgres", "template0", "template1"].includes(name), "A named local application database is required.");
  return `${url.hostname}:${url.port || "5432"}/${name}`;
}

async function loadState(database: string): Promise<State> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as State;
  assert.equal(state.database, database);
  assert.equal(state.caseIds.length, 2);
  return state;
}

async function setup(database: string) {
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  const preexisting = await pool.query("SELECT student_number FROM students WHERE student_number=ANY($1::text[])", [students]);
  assert.equal(preexisting.rowCount, 0, "A fixture identity already exists.");
  const actor = (await pool.query<{ id: string }>("SELECT id::text FROM users WHERE role='ADMIN' AND deleted_at IS NULL AND email_verified_at IS NOT NULL AND must_change_password=FALSE ORDER BY id LIMIT 1")).rows[0];
  assert.ok(actor, "An active test Administrator is required.");
  const refs = (await pool.query<{ program_id: string; college_id: string; college_name: string; program_name: string; program_code: string }>(
    `SELECT program.id::text AS program_id,program.college_id::text AS college_id,college.name AS college_name,program.name AS program_name,program.code AS program_code
       FROM programs program JOIN colleges college ON college.id=program.college_id ORDER BY program.id LIMIT 1`,
  )).rows[0];
  assert.ok(refs);
  const clinics = (await pool.query<{ id: string; code: string }>("SELECT id::text,code FROM clinics WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')")).rows;
  const labClinic = clinics.find((row) => row.code === "KABALAKA_CLINIC")?.id;
  const peClinic = clinics.find((row) => row.code === "CPU_CLINIC")?.id;
  assert.ok(labClinic && peClinic);
  const result = await transaction(async (client) => {
    const insertedYear = await client.query("INSERT INTO academic_years(start_year,closing_date,created_by,updated_by) VALUES ($1,'2099-07-31',$2,$2) ON CONFLICT(start_year) DO NOTHING RETURNING start_year", [year, actor.id]);
    const importId = randomUUID(), labBatch = randomUUID(), peBatch = randomUUID();
    await client.query(`INSERT INTO schedule_import_groups(id,import_name,source_filename,total_rows,created_by,student_category,academic_year_start,accepted_at,import_mode)
      VALUES ($1,$2,$3,2,$4,'REGULAR',$5,NOW(),'STANDARD')`, [importId, importName, `${importName}.csv`, actor.id, year]);
    await client.query(`INSERT INTO schedule_batches(id,clinic_id,batch_name,status,created_by,import_group_id)
      VALUES ($1,$3,$5,'PUBLISHED',$6,$7),($2,$4,$5,'PUBLISHED',$6,$7)`, [labBatch, peBatch, labClinic, peClinic, batchName, actor.id, importId]);
    const caseIds: string[] = [];
    for (const [index, student] of students.entries()) {
      const pairId = randomUUID(), labId = randomUUID(), peId = randomUUID();
      await client.query(`INSERT INTO students(student_number,first_name,last_name,college_id,program_id,year_level,date_of_birth)
        VALUES ($1,$2,'Manual Fixture',$3,$4,2,'2000-01-01')`, [student, `Browser ${index + 1}`, refs.college_id, refs.program_id]);
      await client.query(`INSERT INTO student_academic_snapshots(student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,$9)`, [student, year, `Browser ${index + 1} Manual Fixture`, refs.college_id, refs.college_name, refs.program_id, refs.program_code, refs.program_name, importId]);
      await client.query(`INSERT INTO appointments(id,batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$3,$5,$7,'LABORATORY','2098-09-01','PENDING',TRUE,$8,$9,'REGULAR',$10,$10),($2,$4,$6,$7,'PHYSICAL_EXAM','2098-09-02','AWAITING_RESCHEDULE',FALSE,$8,$9,'REGULAR',$10,$10)`,
      [labId, peId, labBatch, peBatch, labClinic, peClinic, student, pairId, year, actor.id]);
      await linkPublishedLaboratoryAppointments(client, [labId]);
      const manual = await client.query<{ id: string }>(`INSERT INTO clinic_closure_manual_cases(student_number,case_source,schedule_pair_id,schedule_cycle_start,affected_laboratory_appointment_id,affected_physical_exam_appointment_id,reason_code,reason_message,policy_metadata)
        VALUES ($1,'AUTOMATIC_DISPLACEMENT',$2,$3,$4,$5,'NO_VALID_REPLACEMENT_WITHIN_CYCLE','Synthetic Browser batch fixture','{}') RETURNING id::text`, [student, pairId, year, labId, peId]);
      const caseId = manual.rows[0].id;
      caseIds.push(caseId);
      await client.query(`INSERT INTO appointment_reschedule_events(student_number,schedule_pair_id,cause,source_import_group_id,old_laboratory_appointment_id,old_physical_exam_appointment_id,actor_user_id,manual_case_id,schedule_cycle_start,outcome)
        VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,$5,$6,$7,$8,'AWAITING_RESCHEDULE')`, [student, pairId, importId, labId, peId, actor.id, caseId, year]);
    }
    return { database, caseIds, importId, yearCreated: insertedYear.rowCount === 1 };
  });
  await mkdir(resolve(".data"), { recursive: true });
  await writeFile(statePath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

async function status(database: string) {
  const state = await loadState(database);
  const result = await pool.query("SELECT status,count(*)::int AS count FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]) GROUP BY status ORDER BY status", [state.caseIds]);
  console.log(JSON.stringify({ ...state, cases: result.rows }));
}

async function cleanup(database: string) {
  const state = await loadState(database);
  await transaction(async (client) => {
    await client.query("DELETE FROM audit_logs WHERE entity_type IN ('clinic_closure_manual_case','manual_resolution_batch') AND (entity_id=ANY($1::text[]) OR metadata->>'requestId' IN (SELECT request_id::text FROM clinical_mutation_requests WHERE action='BULK_MANUAL_RESOLUTION' AND outcome->'caseIds' ?| $1::text[]))", [state.caseIds]);
    await client.query("ALTER TABLE clinical_mutation_requests DISABLE TRIGGER clinical_mutation_requests_immutable");
    await client.query("DELETE FROM clinical_mutation_requests WHERE action='BULK_MANUAL_RESOLUTION' AND outcome->'caseIds' ?| $1::text[]", [state.caseIds]);
    await client.query("ALTER TABLE clinical_mutation_requests ENABLE TRIGGER clinical_mutation_requests_immutable");
    await client.query("DELETE FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[])", [state.caseIds]);
    await client.query("DELETE FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])", [state.caseIds]);
  });
  await cleanupTestFixtures("BMR-20260928-%", batchName, importName);
  if (state.yearCreated) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
  const residue = await pool.query<{ count: string }>(`SELECT
    (SELECT count(*) FROM students WHERE student_number LIKE 'BMR-20260928-%')+
    (SELECT count(*) FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]))+
    (SELECT count(*) FROM schedule_import_groups WHERE id=$2)+
    (SELECT count(*) FROM academic_years WHERE start_year=$3 AND $4::boolean) AS count`, [state.caseIds, state.importId, year, state.yearCreated]);
  assert.equal(Number(residue.rows[0].count), 0, "Fixture residue remains.");
  await rm(statePath);
  console.log("Browser manual resolution fixture residue: 0");
}

const command = process.argv[2];
try {
  const database = databaseIdentity();
  if (command === "setup") await setup(database);
  else if (command === "status") await status(database);
  else if (command === "cleanup") await cleanup(database);
  else throw new Error("Usage: browser-manual-resolution-fixture.ts setup|status|cleanup");
} finally {
  await pool.end();
}
