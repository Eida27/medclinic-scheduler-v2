import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import bcrypt from "bcryptjs";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { getLaboratoryChecklist, setLaboratoryTestVerification } from "@/server/laboratory/laboratory-checklist.service";
import { savePhysicianRevision } from "@/server/medical-certificates/physician.service";
import {
  cleanupTestFixtures,
  insertTestScheduleImportGroup,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { TEST_STAFF_ACCOUNTS } from "@/test/staff-fixtures";
import type { SessionUser } from "@/types/roles";

const statePath = resolve(".data/browser-pe-completion.json");
const studentNumber = "B-PE-20260928";
const year = 2026;
const labDate = "2026-09-25";
const peDate = "2026-09-28";
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "Test Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

type State = {
  database: string;
  studentNumber: string;
  labId: string;
  peId: string;
  physicianId: string;
  createdYear: boolean;
  createdTestAdmin?: boolean;
};

function databaseIdentity() {
  if (process.env.BROWSER_PE_ACCEPTANCE_LOCAL_TEST_DB !== "1") {
    throw new Error("Set BROWSER_PE_ACCEPTANCE_LOCAL_TEST_DB=1 for this local test fixture.");
  }
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!(["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("This fixture requires a loopback PostgreSQL server.");
  }
  if (!url.pathname.slice(1) || ["postgres", "template0", "template1"].includes(url.pathname.slice(1))) {
    throw new Error("This fixture requires a named local application test database.");
  }
  return `${url.hostname}:${url.port || "5432"}/${url.pathname.slice(1)}`;
}

async function cleanupRows(physicianId: string, createdYear: boolean) {
  await cleanupTestFixtures("B-PE-20260928", "BPE fixture%", "BPE fixture%");
  await transaction(async (client) => {
    await client.query("DELETE FROM audit_logs WHERE entity_type='physician' AND entity_id=$1", [physicianId]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
    await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [physicianId]);
    await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [physicianId]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
  });
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
}

async function setup(database: string) {
  try {
    await readFile(statePath);
    throw new Error("Fixture state already exists. Run status or cleanup first.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const existing = await pool.query("SELECT 1 FROM students WHERE student_number=$1", [studentNumber]);
  if (existing.rowCount) throw new Error("Fixture student number already exists.");
  const current = await pool.query<{ today: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today");
  if (current.rows[0].today !== peDate) {
    throw new Error(`This dated Browser fixture is for ${peDate} Manila; today is ${current.rows[0].today}.`);
  }
  const owner = await pool.query<{ id: string }>(
    "SELECT id::text FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1",
  );
  if (!owner.rows[0]) throw new Error("The local test database needs an Administrator.");
  admin.userId = owner.rows[0].id;

  let createdYear = false;
  let physicianId = "";
  try {
    const insertedYear = await pool.query(
      "INSERT INTO academic_years (start_year,closing_date,created_by,updated_by) VALUES ($1,'2027-07-31',$2,$2) ON CONFLICT (start_year) DO NOTHING RETURNING start_year",
      [year, admin.userId],
    );
    createdYear = Boolean(insertedYear.rowCount);
    await insertTestStudent({ studentNumber, firstName: "Browser", lastName: "Exam Fixture", yearLevel: 2, dateOfBirth: "2005-01-01" });
    const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
    const physician = await savePhysicianRevision({
      profile: { displayName: "Dr. Browser Fixture", licenseNumber: "PRC BPE 2026", specialty: "General Medicine", active: true },
      signatureBytes,
      signatureMediaType: "image/png",
    }, admin);
    physicianId = physician.id;

    const appointments = await transaction(async (client) => {
      const importId = await insertTestScheduleImportGroup(client, {
        name: "BPE fixture import",
        sourceFilename: `${randomUUID()}.csv`,
        academicYearStart: year,
        importMode: "STANDARD",
        actor: admin.userId,
      });
      await client.query(`INSERT INTO student_academic_snapshots
        (student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id)
        VALUES ($1,$2,'Browser Exam Fixture',$3,'College of Computer Studies',$4,'BSIT','BSIT',2,$5)`,
      [studentNumber, year, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, importId]);
      const pairId = randomUUID();
      const insert = async (clinicId: string, scheduleType: string, date: string) => {
        const result = await client.query<{ id: string }>(`INSERT INTO appointments
          (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
          VALUES ($1,$2,$3,$4,'PENDING',TRUE,$5,$6,'REGULAR',$7,$7) RETURNING id::text`,
        [clinicId, studentNumber, scheduleType, date, pairId, year, admin.userId]);
        return result.rows[0].id;
      };
      const labId = await insert(TEST_REFERENCE_IDS.laboratoryClinic, "LABORATORY", labDate);
      const peId = await insert(TEST_REFERENCE_IDS.physicalExamClinic, "PHYSICAL_EXAM", peDate);
      await linkPublishedLaboratoryAppointments(client, [labId]);
      return { labId, peId };
    });
    let checklist = await getLaboratoryChecklist(appointments.labId, admin);
    for (const testCode of ["CBC", "URINE", "STOOL"] as const) {
      checklist = await setLaboratoryTestVerification(
        appointments.labId,
        { testCode, checked: true, expectedVersion: checklist.version },
        admin,
      );
    }
    const state: State = { database, studentNumber, ...appointments, physicianId, createdYear };
    await mkdir(resolve(".data"), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ studentNumber, peId: appointments.peId, labStatus: "COMPLETED", physicianId }));
  } catch (error) {
    if (physicianId) await cleanupRows(physicianId, createdYear);
    else {
      await cleanupTestFixtures("B-PE-20260928", "BPE fixture%", "BPE fixture%");
      if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
    }
    throw error;
  }
}

async function loadState(database: string): Promise<State> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as State;
  if (state.database !== database || state.studentNumber !== studentNumber) {
    throw new Error("Fixture state does not match the current database and student.");
  }
  return state;
}

async function status(database: string) {
  const state = await loadState(database);
  const result = await pool.query<{ status: string; classification: string | null; revisions: number }>(
    `SELECT appointment.status, max(revision.classification) AS classification,
            count(revision.id)::int AS revisions
       FROM appointments appointment
       LEFT JOIN medical_certificate_revisions revision ON revision.appointment_id=appointment.id
      WHERE appointment.id=$1
      GROUP BY appointment.status`, [state.peId],
  );
  console.log(JSON.stringify({ ...state, ...result.rows[0] }));
}

async function authSetup(database: string) {
  const state = await loadState(database);
  if (state.createdTestAdmin) throw new Error("Browser test Administrator already exists.");
  const testAdmin = TEST_STAFF_ACCOUNTS[0];
  const existing = await pool.query("SELECT 1 FROM users WHERE id=$1 OR email=$2", [testAdmin.id, testAdmin.email]);
  if (existing.rowCount) throw new Error("Browser test Administrator identity already exists.");
  const passwordHash = await bcrypt.hash(testAdmin.password, 10);
  await pool.query(`INSERT INTO users
    (id,full_name,email,password_hash,role,clinic_id,email_verified_at,must_change_password,credential_version)
    VALUES ($1,$2,$3,$4,'ADMIN',NULL,clock_timestamp(),FALSE,1)`,
  [testAdmin.id, testAdmin.fullName, testAdmin.email, passwordHash]);
  state.createdTestAdmin = true;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.log("Browser test Administrator ready.");
}

async function cleanup(database: string) {
  const state = await loadState(database);
  await cleanupRows(state.physicianId, state.createdYear);
  if (state.createdTestAdmin) {
    await transaction(async (client) => {
      await client.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [TEST_STAFF_ACCOUNTS[0].id]);
      await client.query("DELETE FROM users WHERE id=$1", [TEST_STAFF_ACCOUNTS[0].id]);
    });
  }
  const residue = await pool.query<{ count: number }>(
    `SELECT (SELECT count(*) FROM students WHERE student_number=$1)
          + (SELECT count(*) FROM appointments WHERE student_number=$1)
          + (SELECT count(*) FROM schedule_import_groups WHERE import_name LIKE 'BPE fixture%')
          + (SELECT count(*) FROM medical_certificate_physicians WHERE id=$2)
          + (SELECT count(*) FROM users WHERE id=$3)::int AS count`,
    [studentNumber, state.physicianId, TEST_STAFF_ACCOUNTS[0].id],
  );
  if (Number(residue.rows[0].count) !== 0) throw new Error(`Fixture residue remains: ${residue.rows[0].count}`);
  await rm(statePath);
  console.log("Browser PE fixture residue: 0");
}

const command = process.argv[2];
try {
  const database = databaseIdentity();
  if (command === "setup") await setup(database);
  else if (command === "auth-setup") await authSetup(database);
  else if (command === "status") await status(database);
  else if (command === "cleanup") await cleanup(database);
  else throw new Error("Usage: browser-pe-completion-fixture.ts setup|auth-setup|status|cleanup");
} finally {
  await pool.end();
}
