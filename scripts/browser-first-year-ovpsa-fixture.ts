import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const DIRECTORY = resolve(".data/browser-first-year-ovpsa");
const STATE_FILE = resolve(DIRECTORY, "state.json");
const CSV_FILE = resolve(DIRECTORY, "B-FIRST-YEAR-IMPORT-280.csv");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const LAB_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const PE_CLINIC_ID = "60000000-0000-4000-8000-000000000002";
const LOWER_BATCH_ID = "bf200000-0000-4000-8000-000000000031";
const SOURCE_FILENAME = "B-FIRST-YEAR-IMPORT-280.csv";
const FIXTURE_STUDENT_NUMBERS = [
  ...Array.from({ length: 280 }, (_, index) => `86-${String(index + 1).padStart(4, "0")}-91`),
  "86-9001-91",
  "86-9002-91",
  "86-9003-91",
  "86-9004-91",
  "86-9005-91",
];

export const FIRST_YEAR_IMPORT_ACCEPTANCE = {
  marker: "B-FIRST-YEAR-IMPORT",
  cycleStart: 2026,
  sourceFilename: SOURCE_FILENAME,
  csvPath: CSV_FILE,
  laboratory: {
    date: "2026-09-22",
    location: "Iloilo Mission Hospital",
  },
  firstPhysicalExamCandidate: "2026-09-29",
  expected: {
    memberCount: 280,
    capacity: 150,
    skippedProtectedDate: "2026-09-29",
    allocations: [
      { date: "2026-09-30", studentCount: 150 },
      { date: "2026-10-01", studentCount: 130 },
    ],
    displacementTotal: 4,
  },
  login: {
    email: "admin@medclinic.local",
    password: "Admin123!",
  },
  conflictStudents: {
    movable: ["86-9001-91", "86-9002-91", "86-9003-91", "86-9004-91"],
    protected: "86-9005-91",
  },
} as const;

type DatabaseIdentity = {
  scheme: "postgresql";
  host: string;
  port: string;
  database: string;
};

type State = {
  databaseIdentity: DatabaseIdentity;
  preparedAt: string;
  originalCapacity: { safe: number; maximum: number };
};

type Residue = {
  students: number;
  imports: number;
  batches: number;
  revisions: number;
  memberships: number;
  reservations: number;
  appointments: number;
  events: number;
  notifications: number;
  outbox: number;
  audits: number;
  lowerBatches: number;
  stateFiles: number;
  csvFiles: number;
};

type PublicationProof = {
  importMode: string;
  importStatus: string;
  laboratoryDate: string;
  reservations: Array<{ serviceType: string; date: string }>;
  allocations: Array<{
    date: string;
    studentCount: number;
    firstSourceRow: number;
    lastSourceRow: number;
    firstAllocationPosition: number;
    lastAllocationPosition: number;
  }>;
  displacedCategories: string[];
  protectedCandidate: { date: string; status: string; manuallyLocked: boolean };
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
  if (!LOOPBACK.has(host)) {
    throw new Error("First Year import acceptance requires a loopback PostgreSQL database.");
  }
  if (process.env.OVPSA_FIRST_YEAR_ACCEPTANCE_EXCLUSIVE_DATABASE !== "1") {
    throw new Error(
      "Set OVPSA_FIRST_YEAR_ACCEPTANCE_EXCLUSIVE_DATABASE=1 only for a dedicated local acceptance database.",
    );
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

async function fileExists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSame(current: DatabaseIdentity, state: State) {
  if (JSON.stringify(current) !== JSON.stringify(state.databaseIdentity)) {
    throw new Error("The prepared fixture belongs to a different database.");
  }
}

export function firstYearAcceptanceCsvContents() {
  const header = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";
  const rows = Array.from({ length: 280 }, (_, index) => {
    const position = index + 1;
    const studentNumber = `86-${String(position).padStart(4, "0")}-91`;
    const college = position <= 150 ? "College of Computer Studies" : "College of Engineering";
    const course = position <= 150 ? "BSIT" : "BSCE";
    return `${studentNumber},Order${String(position).padStart(3, "0")},First${String(position).padStart(3, "0")},Acceptance,,${college},${course},1,2007-01-01`;
  });
  return [header, ...rows].join("\r\n") + "\r\n";
}

async function residue(client: PoolClient): Promise<Residue> {
  const result = await client.query<Omit<Residue, "stateFiles" | "csvFiles">>(
    `WITH tagged_imports AS (
       SELECT id FROM schedule_import_groups WHERE source_filename=$1
     ), tagged_ovpsa_batches AS (
       SELECT id FROM ovpsa_first_year_batches
        WHERE source_import_group_id IN (SELECT id FROM tagged_imports)
     ), tagged_appointments AS (
       SELECT id FROM appointments WHERE student_number=ANY($2::varchar[])
     )
     SELECT
       (SELECT COUNT(*)::int FROM students WHERE student_number=ANY($2::varchar[])) AS students,
       (SELECT COUNT(*)::int FROM tagged_imports) AS imports,
       (SELECT COUNT(*)::int FROM tagged_ovpsa_batches) AS batches,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions
         WHERE batch_id IN (SELECT id FROM tagged_ovpsa_batches)) AS revisions,
       ((SELECT COUNT(*) FROM ovpsa_first_year_membership_snapshots
          WHERE batch_id IN (SELECT id FROM tagged_ovpsa_batches))
        +(SELECT COUNT(*) FROM ovpsa_first_year_active_memberships
          WHERE batch_id IN (SELECT id FROM tagged_ovpsa_batches)))::int AS memberships,
       (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
         WHERE batch_id IN (SELECT id FROM tagged_ovpsa_batches)) AS reservations,
       (SELECT COUNT(*)::int FROM tagged_appointments) AS appointments,
       (SELECT COUNT(*)::int FROM appointment_reschedule_events
         WHERE student_number=ANY($2::varchar[])
            OR ovpsa_batch_id IN (SELECT id FROM tagged_ovpsa_batches)) AS events,
       (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=ANY($2::varchar[])) AS notifications,
       (SELECT COUNT(*)::int FROM email_outbox WHERE student_number=ANY($2::varchar[])) AS outbox,
       (SELECT COUNT(*)::int FROM audit_logs
         WHERE metadata::text LIKE '%B-FIRST-YEAR-IMPORT%'
            OR metadata->>'studentNumber'=ANY($2::varchar[])
            OR entity_id IN (SELECT id::text FROM tagged_imports)
            OR entity_id IN (SELECT id::text FROM tagged_ovpsa_batches)
            OR entity_id IN (SELECT id::text FROM tagged_appointments)) AS audits,
       (SELECT COUNT(*)::int FROM schedule_batches WHERE id=$3) AS "lowerBatches"`,
    [SOURCE_FILENAME, FIXTURE_STUDENT_NUMBERS, LOWER_BATCH_ID],
  );
  return {
    ...result.rows[0],
    stateFiles: (await readState()) ? 1 : 0,
    csvFiles: (await fileExists(CSV_FILE)) ? 1 : 0,
  };
}

async function publicationProof(client: PoolClient): Promise<PublicationProof | null> {
  const importResult = await client.query<{
    import_mode: string;
    status: string;
    laboratory_date: string;
  }>(
    `SELECT import_group.import_mode,batch.status,
            import_group.first_year_laboratory_date::text AS laboratory_date
       FROM schedule_import_groups import_group
       JOIN ovpsa_first_year_batches batch ON batch.source_import_group_id=import_group.id
      WHERE import_group.source_filename=$1`,
    [SOURCE_FILENAME],
  );
  if (!importResult.rowCount) return null;

  const reservations = await client.query<{ service_type: string; date: string }>(
    `SELECT reservation.schedule_type AS service_type,reservation.reservation_date::text AS date
       FROM ovpsa_first_year_service_reservations reservation
       JOIN ovpsa_first_year_batches batch ON batch.id=reservation.batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.source_import_group_id
      WHERE import_group.source_filename=$1
      ORDER BY reservation.reservation_date,reservation.schedule_type`,
    [SOURCE_FILENAME],
  );
  const allocations = await client.query<{
    date: string;
    student_count: number;
    first_source_row: number;
    last_source_row: number;
    first_allocation_position: number;
    last_allocation_position: number;
  }>(
    `SELECT reservation.reservation_date::text AS date,
            COUNT(*)::int AS student_count,
            MIN(membership.source_row_number)::int AS first_source_row,
            MAX(membership.source_row_number)::int AS last_source_row,
            MIN(membership.allocation_position)::int AS first_allocation_position,
            MAX(membership.allocation_position)::int AS last_allocation_position
       FROM ovpsa_first_year_membership_snapshots membership
       JOIN ovpsa_first_year_batches batch ON batch.id=membership.batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.source_import_group_id
       JOIN ovpsa_first_year_service_reservations reservation
         ON reservation.id=membership.assigned_pe_reservation_id
      WHERE import_group.source_filename=$1
      GROUP BY reservation.reservation_date
      ORDER BY reservation.reservation_date`,
    [SOURCE_FILENAME],
  );
  const displaced = await client.query<{ category: string }>(
    `SELECT old_laboratory.scheduling_category AS category
       FROM appointment_reschedule_events event
       JOIN ovpsa_first_year_batches batch ON batch.id=event.ovpsa_batch_id
       JOIN schedule_import_groups import_group ON import_group.id=batch.source_import_group_id
       JOIN appointments old_laboratory ON old_laboratory.id=event.old_laboratory_appointment_id
      WHERE import_group.source_filename=$1
      ORDER BY old_laboratory.scheduling_category`,
    [SOURCE_FILENAME],
  );
  const protectedCandidate = await client.query<{
    date: string;
    status: string;
    manually_locked: boolean;
  }>(
    `SELECT appointment_date::text AS date,status,is_manually_locked AS manually_locked
       FROM appointments
      WHERE student_number=$1 AND schedule_type='PHYSICAL_EXAM' AND appointment_date=$2::date`,
    [FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.protected, FIRST_YEAR_IMPORT_ACCEPTANCE.firstPhysicalExamCandidate],
  );
  if (!protectedCandidate.rowCount) {
    throw new Error("The protected First Year candidate appointment was not preserved.");
  }

  const proof: PublicationProof = {
    importMode: importResult.rows[0].import_mode,
    importStatus: importResult.rows[0].status,
    laboratoryDate: importResult.rows[0].laboratory_date,
    reservations: reservations.rows.map((row) => ({ serviceType: row.service_type, date: row.date })),
    allocations: allocations.rows.map((row) => ({
      date: row.date,
      studentCount: row.student_count,
      firstSourceRow: row.first_source_row,
      lastSourceRow: row.last_source_row,
      firstAllocationPosition: row.first_allocation_position,
      lastAllocationPosition: row.last_allocation_position,
    })),
    displacedCategories: displaced.rows.map((row) => row.category),
    protectedCandidate: {
      date: protectedCandidate.rows[0].date,
      status: protectedCandidate.rows[0].status,
      manuallyLocked: protectedCandidate.rows[0].manually_locked,
    },
  };
  const expected = {
    importMode: "FIRST_YEAR_OVPSA",
    importStatus: "PUBLISHED",
    laboratoryDate: FIRST_YEAR_IMPORT_ACCEPTANCE.laboratory.date,
    reservations: [
      { serviceType: "LABORATORY", date: "2026-09-22" },
      { serviceType: "PHYSICAL_EXAM", date: "2026-09-30" },
      { serviceType: "PHYSICAL_EXAM", date: "2026-10-01" },
    ],
    allocations: [
      {
        date: "2026-09-30",
        studentCount: 150,
        firstSourceRow: 2,
        lastSourceRow: 151,
        firstAllocationPosition: 1,
        lastAllocationPosition: 150,
      },
      {
        date: "2026-10-01",
        studentCount: 130,
        firstSourceRow: 152,
        lastSourceRow: 281,
        firstAllocationPosition: 151,
        lastAllocationPosition: 280,
      },
    ],
    displacedCategories: ["OJT", "REGULAR", "SPECIALIZED", "TOUR"],
    protectedCandidate: { date: "2026-09-29", status: "PENDING", manuallyLocked: true },
  } satisfies PublicationProof;
  if (JSON.stringify(proof) !== JSON.stringify(expected)) {
    throw new Error(`First Year publication proof did not match the fixture contract: ${JSON.stringify(proof)}.`);
  }
  return proof;
}

function assertZero(value: Residue) {
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`First Year import acceptance cleanup residue remains: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function deleteFixture(client: PoolClient, state: State | null) {
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TEMP TABLE acceptance_imports ON COMMIT DROP AS
       SELECT id FROM schedule_import_groups WHERE source_filename=$1`,
      [SOURCE_FILENAME],
    );
    await client.query(
      `CREATE TEMP TABLE acceptance_ovpsa_batches ON COMMIT DROP AS
       SELECT id FROM ovpsa_first_year_batches
        WHERE source_import_group_id IN (SELECT id FROM acceptance_imports)`,
    );
    await client.query(
      `CREATE TEMP TABLE acceptance_schedule_batches ON COMMIT DROP AS
       SELECT id FROM schedule_batches
        WHERE import_group_id IN (SELECT id FROM acceptance_imports) OR id=$1`,
      [LOWER_BATCH_ID],
    );
    await client.query(
      `CREATE TEMP TABLE acceptance_appointments ON COMMIT DROP AS
       WITH RECURSIVE related AS (
         SELECT id FROM appointments
          WHERE student_number=ANY($1::varchar[])
             OR batch_id IN (SELECT id FROM acceptance_schedule_batches)
             OR ovpsa_batch_id IN (SELECT id FROM acceptance_ovpsa_batches)
         UNION
         SELECT child.id FROM appointments child JOIN related parent ON parent.id=child.rescheduled_from
       ) SELECT id FROM related`,
      [FIXTURE_STUDENT_NUMBERS],
    );
    await client.query(
      `DELETE FROM appointment_reschedule_event_unavailable_dates
        WHERE event_id IN (
          SELECT id FROM appointment_reschedule_events
           WHERE student_number=ANY($1::varchar[])
              OR ovpsa_batch_id IN (SELECT id FROM acceptance_ovpsa_batches)
        )`,
      [FIXTURE_STUDENT_NUMBERS],
    );
    await client.query(
      `DELETE FROM appointment_reschedule_events
        WHERE student_number=ANY($1::varchar[])
           OR ovpsa_batch_id IN (SELECT id FROM acceptance_ovpsa_batches)`,
      [FIXTURE_STUDENT_NUMBERS],
    );
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications DISABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query("DELETE FROM ovpsa_external_laboratory_verifications WHERE appointment_id IN (SELECT id FROM acceptance_appointments)");
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications ENABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query("DELETE FROM laboratory_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM acceptance_appointments)", [FIXTURE_STUDENT_NUMBERS]);
    await client.query("DELETE FROM exam_results WHERE student_number=ANY($1::varchar[]) OR appointment_id IN (SELECT id FROM acceptance_appointments)", [FIXTURE_STUDENT_NUMBERS]);
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM acceptance_appointments)");
    await client.query("DELETE FROM appointments WHERE id IN (SELECT id FROM acceptance_appointments)");
    await client.query("DELETE FROM coordinator_schedule_items WHERE student_number=ANY($1::varchar[]) OR batch_id IN (SELECT id FROM acceptance_schedule_batches)", [FIXTURE_STUDENT_NUMBERS]);
    await client.query("DELETE FROM schedule_batches WHERE id IN (SELECT id FROM acceptance_schedule_batches)");
    await client.query("DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_batches DISABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_batches ENABLE TRIGGER ovpsa_first_year_batch_identity_immutable");
    await client.query("DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("DELETE FROM ovpsa_first_year_batches WHERE id IN (SELECT id FROM acceptance_ovpsa_batches)");
    await client.query("DELETE FROM student_portal_notifications WHERE student_number=ANY($1::varchar[])", [FIXTURE_STUDENT_NUMBERS]);
    await client.query("DELETE FROM email_outbox WHERE student_number=ANY($1::varchar[])", [FIXTURE_STUDENT_NUMBERS]);
    await client.query(
      `DELETE FROM audit_logs
        WHERE metadata::text LIKE '%B-FIRST-YEAR-IMPORT%'
           OR metadata->>'studentNumber'=ANY($1::varchar[])
           OR entity_id IN (SELECT id::text FROM acceptance_imports)
           OR entity_id IN (SELECT id::text FROM acceptance_ovpsa_batches)
           OR entity_id IN (SELECT id::text FROM acceptance_appointments)`,
      [FIXTURE_STUDENT_NUMBERS],
    );
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM acceptance_imports)");
    await client.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM student_academic_snapshots WHERE student_number=ANY($1::varchar[])", [FIXTURE_STUDENT_NUMBERS]);
    await client.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
    await client.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [FIXTURE_STUDENT_NUMBERS]);
    if (state) {
      await client.query(
        `UPDATE clinic_capacity_settings SET safe_daily_capacity=$2,max_daily_capacity=$3
          WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM'`,
        [PE_CLINIC_ID, state.originalCapacity.safe, state.originalCapacity.maximum],
      );
    }
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
    await deleteFixture(client, existingState);
  } else {
    const before = await residue(client);
    if (Object.entries(before).some(([key, count]) => key !== "stateFiles" && count !== 0)) {
      throw new Error(`Refusing to overwrite untracked First Year import fixtures: ${JSON.stringify(before)}.`);
    }
  }

  const capacity = await client.query<{ safe_daily_capacity: number; max_daily_capacity: number }>(
    `SELECT safe_daily_capacity,max_daily_capacity FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM' AND is_active=TRUE`,
    [PE_CLINIC_ID],
  );
  if (!capacity.rowCount) throw new Error("CPU Clinic Physical Examination capacity is not configured.");
  const state: State = {
    databaseIdentity,
    preparedAt: new Date().toISOString(),
    originalCapacity: {
      safe: capacity.rows[0].safe_daily_capacity,
      maximum: capacity.rows[0].max_daily_capacity,
    },
  };
  await mkdir(DIRECTORY, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await client.query("BEGIN");
  try {
    const academicYear = await client.query(
      `SELECT 1 FROM academic_years
        WHERE start_year=$1 AND closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date`,
      [FIRST_YEAR_IMPORT_ACCEPTANCE.cycleStart],
    );
    if (!academicYear.rowCount) throw new Error("Configure the open 2026 academic year before preparing the fixture.");
    await client.query(
      `UPDATE clinic_capacity_settings SET safe_daily_capacity=150,max_daily_capacity=150
        WHERE clinic_id=$1 AND schedule_type='PHYSICAL_EXAM'`,
      [PE_CLINIC_ID],
    );
    const conflictStudents = [
      ...FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.movable,
      FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.protected,
    ];
    await client.query(
      `INSERT INTO students (
         student_number,first_name,middle_name,last_name,college_id,program_id,year_level,date_of_birth
       ) SELECT student_number,'Browser','Conflict',last_name,
                '10000000-0000-4000-8000-000000000003',
                '20000000-0000-4000-8000-000000000003',4,'2004-01-01'
           FROM UNNEST($1::varchar[],$2::varchar[]) AS row(student_number,last_name)`,
      [conflictStudents, ["Regular", "OJT", "Tour", "Specialized", "Protected"]],
    );
    await client.query(
      `INSERT INTO schedule_batches (
         id,clinic_id,batch_name,college_id,program_id,status,created_by,published_by,published_at
       ) VALUES ($1,$2,'B-FIRST-YEAR-IMPORT lower-priority conflicts',
                 '10000000-0000-4000-8000-000000000003',
                 '20000000-0000-4000-8000-000000000003','PUBLISHED',$3,$3,clock_timestamp())`,
      [LOWER_BATCH_ID, LAB_CLINIC_ID, ADMIN_ID],
    );
    const categories = ["REGULAR", "OJT", "TOUR", "SPECIALIZED"];
    const pairIds = FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.movable.map(
      (_, index) => `bf200000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,batch_id,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,scheduling_window_start,scheduling_window_end
       )
       SELECT $1::uuid,row.student_number,'LABORATORY',$4::date,'PENDING',TRUE,row.pair_id,$5::integer,$6::uuid,$6::uuid,$7::uuid,
              row.category,('2026-08-01T00:00:00Z'::timestamptz + row.position * interval '1 second'),
              row.position,'2026-08-01'::date,'2027-07-31'::date
         FROM UNNEST($2::varchar[],$3::uuid[],$8::varchar[]) WITH ORDINALITY
           AS row(student_number,pair_id,category,position)
       UNION ALL
       SELECT $9::uuid,row.student_number,'PHYSICAL_EXAM','2026-09-23'::date,'PENDING',TRUE,row.pair_id,$5::integer,$6::uuid,$6::uuid,$7::uuid,
              row.category,('2026-08-01T00:00:00Z'::timestamptz + row.position * interval '1 second'),
              row.position,'2026-08-01'::date,'2027-07-31'::date
         FROM UNNEST($2::varchar[],$3::uuid[],$8::varchar[]) WITH ORDINALITY
           AS row(student_number,pair_id,category,position)`,
      [
        LAB_CLINIC_ID,
        FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.movable,
        pairIds,
        FIRST_YEAR_IMPORT_ACCEPTANCE.laboratory.date,
        FIRST_YEAR_IMPORT_ACCEPTANCE.cycleStart,
        ADMIN_ID,
        LOWER_BATCH_ID,
        categories,
        PE_CLINIC_ID,
      ],
    );
    await client.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,batch_id,scheduling_category,
         scheduling_accepted_at,scheduling_source_row_order,scheduling_window_start,scheduling_window_end,
         is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES
       ($1,$3,'LABORATORY','2026-09-28','PENDING',TRUE,$4,$5,$6,$6,$7,'REGULAR',
        '2026-08-02T00:00:00Z',5,'2026-08-01','2027-07-31',FALSE,NULL,NULL,NULL),
       ($2,$3,'PHYSICAL_EXAM',$8,'PENDING',TRUE,$4,$5,$6,$6,$7,'REGULAR',
        '2026-08-02T00:00:00Z',5,'2026-08-01','2027-07-31',TRUE,$6,clock_timestamp(),
        'B-FIRST-YEAR-IMPORT protected candidate')`,
      [
        LAB_CLINIC_ID,
        PE_CLINIC_ID,
        FIRST_YEAR_IMPORT_ACCEPTANCE.conflictStudents.protected,
        "bf200000-0000-4000-8000-000000000099",
        FIRST_YEAR_IMPORT_ACCEPTANCE.cycleStart,
        ADMIN_ID,
        LOWER_BATCH_ID,
        FIRST_YEAR_IMPORT_ACCEPTANCE.firstPhysicalExamCandidate,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await writeFile(CSV_FILE, firstYearAcceptanceCsvContents(), "utf8");
  return {
    mode: "setup",
    databaseIdentity,
    fixture: FIRST_YEAR_IMPORT_ACCEPTANCE,
    residue: await residue(client),
  };
}

async function run() {
  const mode = process.argv[2];
  if (!mode || !["setup", "status", "cleanup"].includes(mode)) {
    throw new Error("Use setup, status, or cleanup for the First Year import acceptance fixture.");
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
      if (mode === "setup") {
        console.log(JSON.stringify(await setup(client, databaseIdentity), null, 2));
      }
      if (mode === "status") {
        console.log(JSON.stringify({
          mode,
          databaseIdentity,
          fixture: FIRST_YEAR_IMPORT_ACCEPTANCE,
          residue: await residue(client),
          publicationProof: await publicationProof(client),
        }, null, 2));
      }
      if (mode === "cleanup") {
        await deleteFixture(client, state);
        await rm(DIRECTORY, { recursive: true, force: true });
        console.log(JSON.stringify({
          mode,
          databaseIdentity,
          residue: assertZero(await residue(client)),
        }, null, 2));
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
