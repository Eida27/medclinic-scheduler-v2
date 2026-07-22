import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TEST_REFERENCE_IDS = {
  adminUser: "00000000-0000-4000-8000-000000000001",
  laboratoryClinic: "60000000-0000-4000-8000-000000000001",
  physicalExamClinic: "60000000-0000-4000-8000-000000000002",
} as const;

const FIXTURE_DIR = resolve(".data/browser-automated-scheduling");
const STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const STATE_FILE = resolve(FIXTURE_DIR, "state.json");
const STUDENT_PATTERN = "99-98%";
const IMPORT_PATTERN = "%BROWSER-AY%";
const REASON_PATTERN = "BROWSER-AY%";
const CAPACITY_IDS = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
] as const;

type CapacityState = {
  id: string;
  maxDailyCapacity: number;
};

type FixtureState = { capacities: CapacityState[] };

async function cleanupTestFixtures(
  studentNumberPattern: string,
  batchNamePattern: string,
  importNamePattern: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE browser_fixture_students ON COMMIT DROP AS
       SELECT student_number FROM students WHERE student_number LIKE $1`,
      [studentNumberPattern],
    );
    await client.query("ALTER TABLE browser_fixture_students ADD PRIMARY KEY (student_number)");
    await client.query(
      `CREATE TEMP TABLE browser_fixture_import_groups ON COMMIT DROP AS
       SELECT id FROM schedule_import_groups WHERE import_name LIKE $1`,
      [importNamePattern],
    );
    await client.query("ALTER TABLE browser_fixture_import_groups ADD PRIMARY KEY (id)");
    await client.query(
      `CREATE TEMP TABLE browser_fixture_batches ON COMMIT DROP AS
       SELECT id FROM schedule_batches
        WHERE batch_name LIKE $1
           OR import_group_id IN (SELECT id FROM browser_fixture_import_groups)`,
      [batchNamePattern],
    );
    await client.query("ALTER TABLE browser_fixture_batches ADD PRIMARY KEY (id)");
    await client.query(
      `CREATE TEMP TABLE browser_fixture_appointments ON COMMIT DROP AS
       WITH RECURSIVE fixture_appointments AS (
         SELECT appointment.id FROM appointments appointment
          WHERE appointment.batch_id IN (SELECT id FROM browser_fixture_batches)
             OR appointment.student_number IN (SELECT student_number FROM browser_fixture_students)
         UNION
         SELECT child.id FROM appointments child
         JOIN fixture_appointments parent ON parent.id=child.rescheduled_from
       ) SELECT id FROM fixture_appointments`,
    );
    await client.query("ALTER TABLE browser_fixture_appointments ADD PRIMARY KEY (id)");
    await client.query(
      `DELETE FROM audit_logs audit
        WHERE (audit.entity_type='schedule_import_group'
               AND audit.entity_id IN (SELECT id::text FROM browser_fixture_import_groups))
           OR (audit.entity_type='schedule_batch'
               AND audit.entity_id IN (SELECT id::text FROM browser_fixture_batches))
           OR (audit.entity_type='student'
               AND audit.entity_id IN (SELECT student_number FROM browser_fixture_students))
           OR (audit.entity_type='appointment'
               AND audit.entity_id IN (SELECT id::text FROM browser_fixture_appointments))
           OR audit.metadata->>'studentNumber' IN (SELECT student_number FROM browser_fixture_students)
           OR audit.metadata->>'batchId' IN (SELECT id::text FROM browser_fixture_batches)
           OR audit.metadata->>'replacementId' IN (SELECT id::text FROM browser_fixture_appointments)`,
    );
    await client.query(
      `DELETE FROM student_result_submissions
        WHERE student_number IN (SELECT student_number FROM browser_fixture_students)
           OR appointment_id IN (SELECT id FROM browser_fixture_appointments)`,
    );
    await client.query("DELETE FROM student_portal_notifications WHERE student_number IN (SELECT student_number FROM browser_fixture_students)");
    await client.query("DELETE FROM student_email_verifications WHERE student_number IN (SELECT student_number FROM browser_fixture_students)");
    await client.query("DELETE FROM email_outbox WHERE student_number IN (SELECT student_number FROM browser_fixture_students)");
    await client.query("DELETE FROM student_login_attempts WHERE student_number IN (SELECT student_number FROM browser_fixture_students)");
    await client.query(
      `DELETE FROM exam_results
        WHERE student_number IN (SELECT student_number FROM browser_fixture_students)
           OR appointment_id IN (SELECT id FROM browser_fixture_appointments)`,
    );
    await client.query(
      `DELETE FROM laboratory_results
        WHERE student_number IN (SELECT student_number FROM browser_fixture_students)
           OR appointment_id IN (SELECT id FROM browser_fixture_appointments)`,
    );
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM browser_fixture_appointments)");
    await client.query("DELETE FROM appointments WHERE id IN (SELECT id FROM browser_fixture_appointments)");
    await client.query(
      `DELETE FROM coordinator_schedule_items
        WHERE batch_id IN (SELECT id FROM browser_fixture_batches)
           OR student_number IN (SELECT student_number FROM browser_fixture_students)`,
    );
    await client.query("DELETE FROM schedule_batches WHERE id IN (SELECT id FROM browser_fixture_batches)");
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM browser_fixture_import_groups)");
    await client.query("DELETE FROM students WHERE student_number IN (SELECT student_number FROM browser_fixture_students)");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readState(): Promise<FixtureState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as FixtureState;
  } catch {
    return null;
  }
}

async function resultStorageDirectories() {
  const result = await pool.query<{ storageKey: string }>(
    `SELECT file.storage_key AS "storageKey"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE submission.student_number LIKE $1`,
    [STUDENT_PATTERN],
  );
  return [...new Set(result.rows.map(({ storageKey }) => storageKey.split("/")[0]))];
}

async function removePrivateFixtureFiles(directories: string[]) {
  for (const directory of directories) {
    const target = resolve(STORAGE_ROOT, directory);
    if (!target.startsWith(`${STORAGE_ROOT}${sep}`)) {
      throw new Error(`Refusing to remove result storage outside ${STORAGE_ROOT}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

async function cleanupBrowserData(state: FixtureState | null) {
  const storageDirectories = await resultStorageDirectories();
  await cleanupTestFixtures(STUDENT_PATTERN, IMPORT_PATTERN, IMPORT_PATTERN);
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE $1", [REASON_PATTERN]);
  await removePrivateFixtureFiles(storageDirectories);
  if (state) {
    for (const capacity of state.capacities) {
      await pool.query(
        `UPDATE clinic_capacity_settings
            SET safe_daily_capacity=$2, max_daily_capacity=$2
          WHERE id=$1`,
        [capacity.id, capacity.maxDailyCapacity],
      );
    }
  }
}

async function setup() {
  const previousState = await readState();
  if (previousState) await cleanupBrowserData(previousState);

  const capacities = await pool.query<{
    id: string;
    maxDailyCapacity: number;
  }>(
    `SELECT id, max_daily_capacity AS "maxDailyCapacity"
       FROM clinic_capacity_settings
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [CAPACITY_IDS],
  );
  const state: FixtureState = { capacities: capacities.rows };
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await cleanupBrowserData(null);
  await pool.query(
    `UPDATE clinic_capacity_settings
        SET safe_daily_capacity=1, max_daily_capacity=1
      WHERE id = ANY($1::uuid[])`,
    [CAPACITY_IDS],
  );
  await pool.query(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by
     ) VALUES
       ($1,'2026-08-05','2026-08-31','CLOSURE','BROWSER-AY capacity laboratory',$3),
       ($2,'2026-08-05','2026-08-31','CLOSURE','BROWSER-AY capacity physical',$3)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );

  const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
  const regularCsv = [
    header,
    "99-9801-01,Browser,Regular One,,,College of Computer Studies,BSIT,3,05-06-2003",
    "99-9802-02,Browser,Regular Two,,,College of Computer Studies,BSIT,3,05-07-2003",
  ].join("\n");
  const priorityCsv = [
    header,
    "99-9803-03,Browser,Priority,,,College of Computer Studies,BSIT,3,05-08-2003",
  ].join("\n");
  const files = {
    regularCsv: resolve(FIXTURE_DIR, "BROWSER-AY-regular.csv"),
    priorityCsv: resolve(FIXTURE_DIR, "BROWSER-AY-priority.csv"),
    pdf: resolve(FIXTURE_DIR, "BROWSER-AY-result.pdf"),
    png: resolve(FIXTURE_DIR, "BROWSER-AY-result.png"),
  };
  await Promise.all([
    writeFile(files.regularCsv, regularCsv, "utf8"),
    writeFile(files.priorityCsv, priorityCsv, "utf8"),
    writeFile(files.pdf, "%PDF-1.7\nSynthetic non-sensitive Browser acceptance result.\n", "utf8"),
    writeFile(files.png, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ])),
  ]);
  return { mode: "setup", students: ["99-9801-01", "99-9802-02", "99-9803-03"], files };
}

async function cleanup() {
  const state = await readState();
  await cleanupBrowserData(state);
  const proof = await pool.query<{
    students: number;
    imports: number;
    closures: number;
    submissions: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $1) AS students,
       (SELECT COUNT(*)::int FROM schedule_import_groups WHERE import_name LIKE $2) AS imports,
       (SELECT COUNT(*)::int FROM clinic_unavailable_dates WHERE reason LIKE $3) AS closures,
       (SELECT COUNT(*)::int FROM student_result_submissions WHERE student_number LIKE $1) AS submissions`,
    [STUDENT_PATTERN, IMPORT_PATTERN, REASON_PATTERN],
  );
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  return { mode: "cleanup", ...proof.rows[0], capacitiesRestored: Boolean(state) };
}

async function status() {
  const appointments = await pool.query<{
    id: string;
    clinicType: string;
    appointmentDate: string;
    status: string;
  }>(
    `SELECT appointment.id,
            appointment.schedule_type AS "clinicType",
            appointment.appointment_date::text AS "appointmentDate",
            appointment.status
       FROM appointments appointment
      WHERE appointment.student_number='99-9803-03'
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY appointment.appointment_date, appointment.schedule_type`,
  );
  const capacities = await pool.query<{
    id: string;
    maxDailyCapacity: number;
  }>(
    `SELECT id, max_daily_capacity AS "maxDailyCapacity"
       FROM clinic_capacity_settings
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [CAPACITY_IDS],
  );
  return { mode: "status", appointments: appointments.rows, capacities: capacities.rows };
}

const mode = process.argv[2];
try {
  const result = mode === "setup" ? await setup()
    : mode === "cleanup" ? await cleanup()
      : mode === "status" ? await status()
        : null;
  if (!result) throw new Error("Use setup, status, or cleanup.");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
