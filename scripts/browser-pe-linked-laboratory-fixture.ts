import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateTestDatabase } from "./test-database";
import type { SessionUser } from "../src/types/roles";

const stateFile = resolve(".data/browser-pe-linked-laboratory/state.json");
const marker = "BROWSER-PE-LINKED-LABORATORY-V1";
const cases = [
  { name: "OJT_READY", studentNumber: "99-9331-91", year: 4, category: "OJT" },
  { name: "OJT_MISSING", studentNumber: "99-9332-91", year: 4, category: "OJT" },
  { name: "FIRST_YEAR", studentNumber: "99-9333-91", year: 1, category: "REGULAR" },
  { name: "STANDARD", studentNumber: "99-9334-91", year: 2, category: "REGULAR" },
] as const;
type Identity = { database: string; address: string; port: number; oid: number; role: string };
type Case = { name: string; studentNumber: string; labId: string; peId: string };
type State = { marker: string; identity: Identity; createdYear: boolean; year: number; today: string;
  adminId: string; labStaffId: string; cpuStaffId: string; physicianId: string | null; cases: Case[]; capacity: unknown };

export function assertSafePeLinkedBrowserDatabase(url: string | undefined, consent: string | undefined) {
  if (consent !== "1") throw new Error("Set BROWSER_PE_LINKED_ACCEPTANCE_LOCAL_TEST_DB=1 for this disposable local fixture.");
  return validateTestDatabase(url, "1");
}
export function assertMatchingPeLinkedBrowserDatabase(saved: Identity, live: Identity) {
  if (JSON.stringify(saved) !== JSON.stringify(live)) throw new Error("Refusing fixture cleanup: saved database identity differs.");
}
function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function run(action: string) {
  const target = assertSafePeLinkedBrowserDatabase(process.env.DATABASE_URL, process.env.BROWSER_PE_LINKED_ACCEPTANCE_LOCAL_TEST_DB);
  if (!["setup", "status", "cleanup"].includes(action)) throw new Error("Use setup, status or cleanup.");
  // Keep the specified tsx commands while using Next's server-only resolution for service imports.
  if (!process.execArgv.includes("--conditions=react-server")) {
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", fileURLToPath(import.meta.url), action], { env: process.env, stdio: "inherit", windowsHide: true });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? done() : reject(new Error(`Fixture child failed: ${code}`)));
    });
    return;
  }
  const { pool, transaction } = await import("../src/server/db/pool");
  const { cleanupTestFixtures, insertTestStudent, insertTestAcademicSnapshot, TEST_REFERENCE_IDS: ids } = await import("../src/test/integration-fixtures");
  const { linkPublishedLaboratoryAppointments } = await import("../src/server/laboratory/laboratory-checklist.repository");
  const { acceptAndScheduleImport } = await import("../src/server/services/schedule-imports.service");
  const { savePhysicianRevision } = await import("../src/server/medical-certificates/physician.service");
  const live = (await pool.query<Identity>(`SELECT current_database() AS database,host(inet_server_addr()) AS address,
    inet_server_port() AS port,(SELECT oid FROM pg_database WHERE datname=current_database()) AS oid,current_user AS role`)).rows[0];
  if (live.database !== target.database || !["127.0.0.1", "::1"].includes(live.address)
      || live.port !== Number(new URL(target.targetUrl).port)) throw new Error("Live test database identity is invalid.");
  const capacity = async () => (await pool.query("SELECT clinic_id::text,schedule_type,max_daily_capacity FROM clinic_capacity_settings ORDER BY clinic_id,schedule_type")).rows;
  async function save(state: State) { await mkdir(dirname(stateFile), { recursive: true }); await writeFile(stateFile, JSON.stringify(state, null, 2)); }
  async function load(): Promise<State> {
    const state = JSON.parse(await readFile(stateFile, "utf8")) as State;
    if (state.marker !== marker || state.cases.some((c) => !cases.some((expected) => expected.studentNumber === c.studentNumber && expected.name === c.name))) throw new Error("Invalid fixture manifest.");
    assertMatchingPeLinkedBrowserDatabase(state.identity, live);
    return state;
  }
  async function residue(state: State) {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM students WHERE student_number=ANY($1::varchar[])) AS students,
      (SELECT count(*)::int FROM appointments WHERE student_number=ANY($1::varchar[])) AS appointments,
      (SELECT count(*)::int FROM student_result_submissions WHERE student_number=ANY($1::varchar[])) AS submissions,
      (SELECT count(*)::int FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])) AS notifications,
      (SELECT count(*)::int FROM users WHERE id=ANY($2::uuid[])) AS staff,
      (SELECT count(*)::int FROM medical_certificate_physicians WHERE id=$3) AS physicians`,
    [cases.map((c) => c.studentNumber), [state.adminId, state.labStaffId, state.cpuStaffId], state.physicianId])).rows[0];
  }
  async function cleanup(state: State) {
    for (const c of cases) await cleanupTestFixtures(c.studentNumber, `BPELC fixture ${c.name}`,
      c.name === "FIRST_YEAR" ? "BPELC fixture first-year%" : `BPELC fixture ${c.name}`);
    await transaction(async (client) => {
      if (state.physicianId) {
        const owned = (await client.query("SELECT 1 FROM medical_certificate_physician_revisions WHERE physician_id=$1 AND actor_user_id<>$2 LIMIT 1", [state.physicianId, state.adminId])).rowCount;
        if (owned) throw new Error("Refusing to delete a physician revision owned by another actor.");
        await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
        await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [state.physicianId]);
        await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [state.physicianId]);
        await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
      }
      await client.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[state.adminId, state.labStaffId, state.cpuStaffId]]);
      if (state.createdYear) await client.query("DELETE FROM academic_years WHERE start_year=$1", [state.year]);
      await client.query("DELETE FROM staff_login_failures WHERE scope='EMAIL' AND bucket_key IN ('admin@pe-linked.test','lab@pe-linked.test','cpu@pe-linked.test')");
      await client.query("DELETE FROM users WHERE id=ANY($1::uuid[]) AND email IN ('admin@pe-linked.test','lab@pe-linked.test','cpu@pe-linked.test')", [[state.adminId, state.labStaffId, state.cpuStaffId]]);
    });
    const remaining = await residue(state);
    if (Object.values(remaining).some((value) => value !== 0)) throw new Error(`Fixture residue remains: ${JSON.stringify(remaining)}`);
    if (JSON.stringify(await capacity()) !== JSON.stringify(state.capacity)) throw new Error("Clinic capacity settings changed during acceptance.");
    await rm(stateFile);
    console.log(JSON.stringify({ cleaned: true, residue: remaining, capacityUnchanged: true }));
  }
  try {
    if (action === "setup") {
      try { await readFile(stateFile); throw new Error("Fixture manifest exists; run status or cleanup first."); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      const collisions = await pool.query("SELECT 1 FROM students WHERE student_number=ANY($1::varchar[]) UNION ALL SELECT 1 FROM users WHERE email IN ('admin@pe-linked.test','lab@pe-linked.test','cpu@pe-linked.test')", [cases.map((c) => c.studentNumber)]);
      if (collisions.rowCount) throw new Error("Synthetic fixture identities already exist.");
      const today = (await pool.query<{ today: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today")).rows[0].today;
      const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 8 ? 1 : 0);
      let ordinaryLabDate = addDays(today, -1);
      while ([0, 6].includes(new Date(`${ordinaryLabDate}T00:00:00Z`).getUTCDay())
          || [0, 6].includes(new Date(`${addDays(ordinaryLabDate, 1)}T00:00:00Z`).getUTCDay())) ordinaryLabDate = addDays(ordinaryLabDate, -1);
      const state: State = { marker, identity: live, createdYear: false, year, today,
        adminId: randomUUID(), labStaffId: randomUUID(), cpuStaffId: randomUUID(), physicianId: null, cases: [], capacity: await capacity() };
      await save(state);
      try {
        const { default: bcrypt } = await import("bcryptjs");
        const password = "Browser123!";
        const hash = await bcrypt.hash(password, 10);
        await pool.query(`INSERT INTO users(id,full_name,email,password_hash,role,clinic_id,email_verified_at,must_change_password)
          VALUES($1,'Browser PE Admin','admin@pe-linked.test',$4,'ADMIN',NULL,clock_timestamp(),FALSE),
                ($2,'Browser KABALAKA Staff','lab@pe-linked.test',$4,'CLINIC_STAFF',$5,clock_timestamp(),FALSE),
                ($3,'Browser CPU Staff','cpu@pe-linked.test',$4,'CLINIC_STAFF',$6,clock_timestamp(),FALSE)`,
        [state.adminId, state.labStaffId, state.cpuStaffId, hash, ids.laboratoryClinic, ids.physicalExamClinic]);
        state.createdYear = Boolean((await pool.query("INSERT INTO academic_years(start_year,closing_date,created_by,updated_by) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING RETURNING start_year", [year, `${year + 1}-07-31`, state.adminId])).rowCount);
        await save(state);
        const admin: SessionUser = { userId: state.adminId, fullName: "Browser PE Admin", email: "admin@pe-linked.test", role: "ADMIN" };
        const { default: sharp } = await import("sharp");
        const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
        state.physicianId = (await savePhysicianRevision({ profile: { displayName: "Dr. Browser PE Fixture", licenseNumber: "SYNTHETIC PE 2026", specialty: "General Medicine", active: true }, signatureBytes, signatureMediaType: "image/png" }, admin)).id;
        await save(state);
        for (const c of cases) {
          let pair: { labId: string; peId: string };
          if (c.name === "FIRST_YEAR") {
            const contents = `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth\n${c.studentNumber},FirstYear,Browser,Maria,,College of Computer Studies,BSIT,1,2006-01-01`;
            await acceptAndScheduleImport({ fileName: `BPELC fixture first-year ${randomUUID()}.csv`, fileSize: Buffer.byteLength(contents), contents,
              importMode: "FIRST_YEAR_OVPSA", studentCategory: "REGULAR", academicYearStart: year, preferredMonth: null, firstYearLaboratoryDate: today }, admin);
            const rows = (await pool.query<{ id: string; schedule_type: string }>("SELECT id::text,schedule_type FROM appointments WHERE student_number=$1 AND is_published=TRUE", [c.studentNumber])).rows;
            pair = { labId: rows.find((a) => a.schedule_type === "LABORATORY")!.id, peId: rows.find((a) => a.schedule_type === "PHYSICAL_EXAM")!.id };
          } else {
            await insertTestStudent({ studentNumber: c.studentNumber, firstName: "Browser", middleName: "Maria", lastName: c.name, yearLevel: c.year, dateOfBirth: "2005-01-01" });
            pair = await transaction(async (client) => {
              await insertTestAcademicSnapshot(client, { studentNumber: c.studentNumber, academicYearStart: year, importName: `BPELC fixture ${c.name}`, actor: state.adminId });
              const rows = (await client.query<{ id: string; schedule_type: string }>(`INSERT INTO appointments
                (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
                VALUES($1,$3,'LABORATORY',$4,'PENDING',TRUE,$6,$7,$8,$9,$9),($2,$3,'PHYSICAL_EXAM',$5,'PENDING',TRUE,$6,$7,$8,$9,$9) RETURNING id::text,schedule_type`,
              [ids.laboratoryClinic, ids.physicalExamClinic, c.studentNumber, ordinaryLabDate, addDays(ordinaryLabDate, 1), randomUUID(), year, c.category, state.adminId])).rows;
              const labId = rows.find((a) => a.schedule_type === "LABORATORY")!.id;
              await linkPublishedLaboratoryAppointments(client, [labId]);
              return { labId, peId: rows.find((a) => a.schedule_type === "PHYSICAL_EXAM")!.id };
            });
          }
          state.cases.push({ name: c.name, studentNumber: c.studentNumber, ...pair }); await save(state);
        }
        console.log(JSON.stringify({ ...state, staffPassword: password, studentMiddleName: "Maria", studentDob: { OJT_READY: "2005-01-01", FIRST_YEAR: "2006-01-01" } }, null, 2));
      } catch (error) {
        try { await cleanup(state); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture setup and cleanup failed."); }
        throw error;
      }
    } else {
      let state: State;
      try { state = await load(); }
      catch (error) {
        if (action === "status" && error instanceof Error && "code" in error && error.code === "ENOENT") { console.log(JSON.stringify({ prepared: false, database: live.database })); return; }
        throw error;
      }
      if (action === "cleanup") { await cleanup(state); return; }
      const numbers = cases.map((c) => c.studentNumber);
      const appointments = (await pool.query(`SELECT a.id::text,a.student_number,a.schedule_type,a.appointment_date::text,a.status,
        a.ovpsa_batch_id::text,a.ovpsa_revision_id::text,a.ovpsa_service_reservation_id::text FROM appointments a WHERE student_number=ANY($1::varchar[]) ORDER BY student_number,schedule_type`, [numbers])).rows;
      const checklists = (await pool.query(`SELECT c.student_number,c.version,i.test_code,i.verified_at,i.verified_by::text,i.verification_source
        FROM laboratory_checklists c JOIN laboratory_checklist_items i ON i.checklist_id=c.id WHERE student_number=ANY($1::varchar[]) ORDER BY student_number,i.test_code`, [numbers])).rows;
      const certificates = (await pool.query("SELECT certificate_id::text,appointment_id::text,student_number,classification,status,sha256,examination_snapshot FROM medical_certificate_revisions WHERE student_number=ANY($1::varchar[]) ORDER BY student_number", [numbers])).rows;
      const counts = (await pool.query(`SELECT
        (SELECT count(*)::int FROM laboratory_checklist_events e JOIN appointments a ON a.id=e.appointment_id WHERE a.student_number=ANY($1::varchar[]) AND e.source='EXTERNAL') AS external_events,
        (SELECT count(*)::int FROM ovpsa_external_laboratory_verifications v JOIN appointments a ON a.id=v.appointment_id WHERE a.student_number=ANY($1::varchar[])) AS external_summaries,
        (SELECT count(*)::int FROM student_result_submissions WHERE student_number=ANY($1::varchar[])) AS upload_drafts,
        (SELECT count(*)::int FROM student_result_files f JOIN student_result_submissions s ON s.id=f.submission_id WHERE s.student_number=ANY($1::varchar[])) AS upload_files,
        (SELECT count(*)::int FROM student_portal_notifications WHERE student_number=ANY($1::varchar[]) AND notification_type='MEDICAL_CERTIFICATE_AVAILABLE') AS certificate_notices,
        (SELECT count(*)::int FROM email_outbox WHERE student_number=ANY($1::varchar[])) AS outbox`, [numbers])).rows[0];
      const results = (await pool.query("SELECT student_number,result_status,completed_at::text FROM laboratory_results WHERE student_number=ANY($1::varchar[]) ORDER BY student_number", [numbers])).rows;
      console.log(JSON.stringify({ prepared: true, today: state.today, cases: state.cases, appointments, checklists, certificates, results, counts,
        capacityUnchanged: JSON.stringify(await capacity()) === JSON.stringify(state.capacity) }, null, 2));
    }
  } finally { await pool.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv[2] ?? "status");
