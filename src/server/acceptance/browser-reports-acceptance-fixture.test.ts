// @vitest-environment node
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getHistoricalComplianceReport } from "@/server/services/historical-compliance-report.service";
import {
  REPORTS_ACCEPTANCE_FIXTURE,
  assertMatchingReportsAcceptanceDatabaseIdentity,
  assertSafeReportsAcceptanceDatabase,
  assertZeroReportsAcceptanceResidue,
  cleanupReportsAcceptanceFixture,
  getReportsAcceptanceFixtureStatus,
  normalizeReportsAcceptanceDatabaseIdentity,
  setupReportsAcceptanceFixture,
} from "../../../scripts/browser-reports-acceptance-fixture";

const STATE_DIRECTORY = resolve(".data/browser-reports-acceptance");
const STATE_FILE = resolve(STATE_DIRECTORY, "state.json");
const STATE_TEMP_FILE = resolve(STATE_DIRECTORY, "state.json.tmp");
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const LABORATORY_CLINIC_ID = "60000000-0000-4000-8000-000000000001";
const CURRENT_COLLEGE_ID = "10000000-0000-4000-8000-000000000003";
const CURRENT_PROGRAM_ID = "20000000-0000-4000-8000-000000000003";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("reports Browser acceptance fixture guards", () => {
  it("requires an explicitly opted-in loopback PostgreSQL database without leaking credentials", () => {
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@db.example.test/reports", "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeReportsAcceptanceDatabase(
      "postgresql://fixture:secret-password@localhost/reports", undefined,
    )).toThrow("REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
  });

  it.each([
      "postgresql://fixture:secret-password@localhost/reports?host=remote.example",
      "postgresql://fixture:secret-password@localhost/reports?port=9999",
  ])("rejects the unsafe effective URL %s", (databaseUrl) => {
    expect(() => assertSafeReportsAcceptanceDatabase(databaseUrl, "1"))
      .toThrow(/host or port query/i);
  });

  it.each([
    "postgresql://fixture:secret-password@localhost/reports?host=remote.example",
    "postgresql://fixture:secret-password@localhost/reports?port=9999",
  ])("does not leak credentials while rejecting %s", (databaseUrl) => {
    let thrown: unknown;
      try {
        assertSafeReportsAcceptanceDatabase(databaseUrl, "1");
      } catch (error) {
      thrown = error;
      }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("secret-password");
    expect(String(thrown)).not.toContain(databaseUrl);
  });

  it.each([
    ["postgresql://fixture:secret@localhost/reports", "localhost", "5432", "reports"],
    ["postgres://fixture:secret@127.0.0.1:5544/reports", "127.0.0.1", "5544", "reports"],
    ["postgresql://fixture:secret@[::1]:5433/reports", "::1", "5433", "reports"],
  ])("normalizes a credential-free loopback identity", (url, host, port, database) => {
    expect(assertSafeReportsAcceptanceDatabase(url, "1"))
      .toEqual({ scheme: "postgresql", host, port, database });
  });

  it("refuses destructive work when the persisted database identity differs", () => {
    const prepared = normalizeReportsAcceptanceDatabaseIdentity(
      "postgresql://fixture:secret@localhost/reports_a",
    );
    const current = normalizeReportsAcceptanceDatabaseIdentity(
      "postgresql://fixture:secret@localhost/reports_b",
    );
    expect(() => assertMatchingReportsAcceptanceDatabaseIdentity(current, prepared))
      .toThrow(/does not match/i);
  });

  it("reserves exact disjoint identifiers and deterministic Browser expectations", () => {
    expect(REPORTS_ACCEPTANCE_FIXTURE).toMatchObject({
      marker: "BROWSER-REPORTS-ACCEPTANCE-V1",
      studentPrefix: "B-RPT-",
      paginationCount: 153,
      years: {
        closed: { startYear: 2020, label: "2020–2021", closingDate: "2021-07-31" },
        open: { startYear: 2098, label: "2098–2099", closingDate: "2099-07-31" },
      },
      crudScratch: { startYear: 2097, closingDate: "2098-07-31" },
    });
    expect(new Set(REPORTS_ACCEPTANCE_FIXTURE.studentNumbers).size).toBe(153);
    expect(new Set(REPORTS_ACCEPTANCE_FIXTURE.appointmentIds).size)
      .toBe(REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.length);
  });

  it("requires every fixture-owned database and state count to be zero", () => {
    const zero = {
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    };
    expect(assertZeroReportsAcceptanceResidue(zero)).toBe(zero);
    expect(() => assertZeroReportsAcceptanceResidue({ ...zero, snapshots: 1 }))
      .toThrow(/residue remains/i);
  });
});

const exclusive = process.env.REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE === "1";
describe.runIf(exclusive)("reports Browser acceptance fixture lifecycle", () => {
  let pool: Pool;
  let identity: ReturnType<typeof assertSafeReportsAcceptanceDatabase>;

  async function removeState() {
    await rm(STATE_DIRECTORY, { recursive: true, force: true });
  }

  async function deleteSnapshotById(id: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
      );
      await client.query("DELETE FROM student_academic_snapshots WHERE id=$1", [id]);
      await client.query(
        "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertCurrentStudent(studentNumber: string) {
    await pool.query(
      `INSERT INTO students (
         student_number,first_name,last_name,college_id,program_id,year_level,is_active
       ) VALUES ($1,'Collision','Sentinel',$2,$3,1,TRUE)`,
      [studentNumber, CURRENT_COLLEGE_ID, CURRENT_PROGRAM_ID],
    );
  }

  beforeAll(async () => {
    identity = assertSafeReportsAcceptanceDatabase(process.env.DATABASE_URL, "1");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanupReportsAcceptanceFixture(pool, identity);
  });

  afterAll(async () => {
    if (pool) {
      await cleanupReportsAcceptanceFixture(pool, identity);
      await pool.end();
    }
  });

  it("sets up idempotently and exposes exact status without secrets", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await setupReportsAcceptanceFixture(pool, identity);
    const status = await getReportsAcceptanceFixtureStatus(pool, identity);

    expect(status).toMatchObject({
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      years: {
        closed: { startYear: 2020, label: "2020–2021", state: "CLOSED" },
        open: { startYear: 2098, label: "2098–2099", state: "OPEN" },
      },
      paginationCount: 153,
      counts: { students: 153, snapshots: 157, appointments: 165, academicYears: 2 },
      expected: {
        replacement: {
          studentNumber: "B-RPT-0001", classification: "COMPLIED",
          laboratoryStatus: "COMPLETED", dataQuality: "VERIFIED_HISTORICAL",
        },
        historicalDivergence: {
          studentNumber: "B-RPT-0002",
          currentCollege: "College of Computer Studies",
          currentProgram: "Bachelor of Science in Information Technology",
          historicalCollege: "Archived College of Health Sciences",
          historicalProgram: "Archived Clinical Sciences",
          classification: "DID_NOT_COMPLY_BOTH",
          dataQuality: "RECOVERED_HISTORICAL",
        },
        migratedIncomplete: {
          studentNumber: "B-RPT-0003",
          classification: "DID_NOT_COMPLY_PHYSICAL_EXAM",
          dataQuality: "MIGRATED_INCOMPLETE",
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(status)).not.toContain("password");
    const state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({
      version: 1,
      marker: REPORTS_ACCEPTANCE_FIXTURE.marker,
      databaseIdentity: identity,
      setupAuditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      preparedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(await exists(STATE_TEMP_FILE)).toBe(false);
  });

  it("drives exact report classifications, replacement precedence, and pagination", async () => {
    const first = await getHistoricalComplianceReport({
      academicYearStart: "2020", search: "B-RPT-", page: "1", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    const second = await getHistoricalComplianceReport({
      academicYearStart: "2020", search: "B-RPT-", page: "2", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    expect(first.total).toBe(153);
    expect(first.items).toHaveLength(150);
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((row) => row.studentNumber)).size).toBe(153);

    const byNumber = Object.fromEntries([...first.items, ...second.items]
      .map((row) => [row.studentNumber, row]));
    expect(byNumber["B-RPT-0001"]).toMatchObject({
      laboratoryStatus: "COMPLETED", physicalExamStatus: "COMPLETED",
      overallStatus: "COMPLIED", dataQuality: "VERIFIED_HISTORICAL",
    });
    expect(byNumber["B-RPT-0002"]).toMatchObject({
      collegeName: "Archived College of Health Sciences",
      programName: "Archived Clinical Sciences",
      laboratoryStatus: "PENDING", physicalExamStatus: "UNSCHEDULED",
      overallStatus: "DID_NOT_COMPLY_BOTH", dataQuality: "RECOVERED_HISTORICAL",
    });
    expect(byNumber["B-RPT-0003"]).toMatchObject({
      laboratoryStatus: "COMPLETED", physicalExamStatus: "NO_SHOW",
      overallStatus: "DID_NOT_COMPLY_PHYSICAL_EXAM", dataQuality: "MIGRATED_INCOMPLETE",
    });
    expect(byNumber["B-RPT-0004"]).toMatchObject({
      laboratoryStatus: "PENDING", physicalExamStatus: "COMPLETED",
      overallStatus: "DID_NOT_COMPLY_LABORATORY",
    });

    const open = await getHistoricalComplianceReport({
      academicYearStart: "2098", search: "B-RPT-", sort: "name_asc",
    }, new Date("2026-08-02T04:00:00.000Z"));
    expect(open.total).toBe(4);
    expect(Object.fromEntries(open.items.map((row) => [row.studentNumber, row.overallStatus])))
      .toEqual({
        "B-RPT-0001": "COMPLIED",
        "B-RPT-0002": "PENDING_COMPLIANCE",
        "B-RPT-0003": "PENDING_COMPLIANCE",
        "B-RPT-0004": "PENDING_COMPLIANCE",
      });
  });

  it("cleans partial and complete setups repeatedly with no residue", async () => {
    await pool.query("DELETE FROM appointments WHERE id=$1", [REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.at(-1)]);
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
    await setupReportsAcceptanceFixture(pool, identity);
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
    expect(await cleanupReportsAcceptanceFixture(pool, identity)).toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
  });

  it("refuses and preserves reserved-year, prefix, appointment UUID, and snapshot UUID collisions", async () => {
    await removeState();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2020,'2021-06-30',$1,$1)`,
      [ADMIN_USER_ID],
    );
    await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/reserved/i);
    expect((await pool.query("SELECT closing_date::text AS date FROM academic_years WHERE start_year=2020"))
      .rows).toEqual([{ date: "2021-06-30" }]);
    await pool.query("DELETE FROM academic_years WHERE start_year=2020");

    await insertCurrentStudent("B-RPT-COLLIDE");
    await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/reserved/i);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number='B-RPT-COLLIDE'"))
      .rows[0].count).toBe(1);
    await pool.query("DELETE FROM students WHERE student_number='B-RPT-COLLIDE'");

    await insertCurrentStudent("RPT-COLL-APPT");
    await pool.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,created_by,updated_by
       ) VALUES ($1,$2,'RPT-COLL-APPT','LABORATORY','2096-09-01','COMPLETED',TRUE,2096,$3,$3)`,
      [REPORTS_ACCEPTANCE_FIXTURE.appointmentIds[0], LABORATORY_CLINIC_ID, ADMIN_USER_ID],
    );
    await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/reserved/i);
    expect((await pool.query("SELECT student_number FROM appointments WHERE id=$1", [
      REPORTS_ACCEPTANCE_FIXTURE.appointmentIds[0],
    ])).rows[0].student_number).toBe("RPT-COLL-APPT");
    await pool.query("DELETE FROM appointments WHERE student_number='RPT-COLL-APPT'");
    await pool.query("DELETE FROM students WHERE student_number='RPT-COLL-APPT'");

    await insertCurrentStudent("RPT-COLL-SNAP");
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2096,'2097-07-31',$1,$1)`,
      [ADMIN_USER_ID],
    );
    await pool.query(
      `INSERT INTO student_academic_snapshots (
         id,student_number,academic_year_start,student_name,college_name,program_code,
         program_name,year_level,source_type
       ) VALUES ($1,'RPT-COLL-SNAP',2096,'Collision, Snapshot','Collision College',
         'COLL','Collision Program',1,'VERIFIED_HISTORICAL')`,
      [REPORTS_ACCEPTANCE_FIXTURE.snapshotIds[0]],
    );
    await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/reserved/i);
    expect((await pool.query("SELECT student_number FROM student_academic_snapshots WHERE id=$1", [
      REPORTS_ACCEPTANCE_FIXTURE.snapshotIds[0],
    ])).rows[0].student_number).toBe("RPT-COLL-SNAP");
    await deleteSnapshotById(REPORTS_ACCEPTANCE_FIXTURE.snapshotIds[0]);
    await pool.query("DELETE FROM students WHERE student_number='RPT-COLL-SNAP'");
    await pool.query("DELETE FROM academic_years WHERE start_year=2096");
  });

  it("refuses partial setup-marker ownership and preserves its rows", async () => {
    await removeState();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2020,'2021-07-31',$1,$1)`,
      [ADMIN_USER_ID],
    );
    const marker = await pool.query<{ id: string }>(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'BROWSER_REPORTS_FIXTURE_SETUP','acceptance_fixture',$2,'{}'::jsonb)
       RETURNING id::text AS id`,
      [ADMIN_USER_ID, REPORTS_ACCEPTANCE_FIXTURE.marker],
    );
    try {
      await expect(cleanupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/marker|ownership/i);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM academic_years WHERE start_year=2020"))
        .rows[0].count).toBe(1);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=$1", [marker.rows[0].id]))
        .rows[0].count).toBe(1);
    } finally {
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [marker.rows[0].id]);
      await pool.query("DELETE FROM academic_years WHERE start_year=2020");
      await removeState();
    }
  });

  it("recovers cleanup from an exact database marker when state is malformed", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await writeFile(STATE_FILE, "{malformed", "utf8");
    await expect(cleanupReportsAcceptanceFixture(pool, identity)).resolves.toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
  });

  it("rejects malformed or wrong-marker state without exact database ownership and preserves rows", async () => {
    await insertCurrentStudent(REPORTS_ACCEPTANCE_FIXTURE.studentNumbers[0]);
    await mkdir(STATE_DIRECTORY, { recursive: true });
    await writeFile(STATE_FILE, "{malformed", "utf8");
    await expect(cleanupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/state|ownership/i);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1", [
      REPORTS_ACCEPTANCE_FIXTURE.studentNumbers[0],
    ])).rows[0].count).toBe(1);
    await writeFile(STATE_FILE, JSON.stringify({
      version: 1,
      marker: "WRONG-MARKER",
      databaseIdentity: identity,
      setupAuditId: "b8600000-0000-4000-8000-000000000001",
      preparedAt: new Date().toISOString(),
    }), "utf8");
    await expect(cleanupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/state|marker|ownership/i);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1", [
      REPORTS_ACCEPTANCE_FIXTURE.studentNumbers[0],
    ])).rows[0].count).toBe(1);
    await removeState();
    await pool.query("DELETE FROM students WHERE student_number=$1", [REPORTS_ACCEPTANCE_FIXTURE.studentNumbers[0]]);
  });

  it("refuses and preserves exact scratch and PDF audit collisions before setup", async () => {
    const collisions = await pool.query<{ id: string }>(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata) VALUES
       ($1,'ACADEMIC_YEAR_CREATED','academic_year','2097',$2::jsonb),
       ($1,'HISTORICAL_COMPLIANCE_PDF_EXPORTED','academic_year','2020',$3::jsonb)
       RETURNING id::text AS id`,
      [ADMIN_USER_ID, JSON.stringify({
        startYear: 2097, label: "2097–2098", closingDate: "2098-07-31",
      }), JSON.stringify({
        academicYearStart: 2020,
        academicYearLabel: REPORTS_ACCEPTANCE_FIXTURE.years.closed.label,
        filters: {}, sort: "name_asc", rowCount: 153,
        generatedAt: new Date().toISOString(), generationDurationMs: 10,
      })],
    );
    try {
      await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/reserved/i);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=ANY($1::uuid[])", [
        collisions.rows.map((row) => row.id),
      ])).rows[0].count).toBe(2);
    } finally {
      await pool.query("DELETE FROM audit_logs WHERE id=ANY($1::uuid[])", [
        collisions.rows.map((row) => row.id),
      ]);
    }
  });

  it("cleans exact CRUD and PDF audits while preserving unrelated marker-like audits", async () => {
    const unrelated = await pool.query<{ id: string }>(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,'UNRELATED_AUDIT','unrelated','sentinel',$2::jsonb)
       RETURNING id::text AS id`,
      [ADMIN_USER_ID, JSON.stringify({
        note: `${REPORTS_ACCEPTANCE_FIXTURE.marker} ${REPORTS_ACCEPTANCE_FIXTURE.studentPrefix}`,
      })],
    );
    await setupReportsAcceptanceFixture(pool, identity);
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2097,'2098-07-31',$1,$1)`,
      [ADMIN_USER_ID],
    );
    const ownedAudits = await pool.query<{ id: string }>(
      `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata) VALUES
       ($1,'ACADEMIC_YEAR_CREATED','academic_year','2097',$2::jsonb),
       ($1,'ACADEMIC_YEAR_CLOSING_DATE_UPDATED','academic_year','2097',$3::jsonb),
       ($1,'ACADEMIC_YEAR_DELETED','academic_year','2097',$4::jsonb),
       ($1,'HISTORICAL_COMPLIANCE_PDF_EXPORTED','academic_year','2020',$5::jsonb),
       ($1,'HISTORICAL_COMPLIANCE_PDF_EXPORTED','academic_year','2098',$6::jsonb)
       RETURNING id::text AS id`,
      [ADMIN_USER_ID, JSON.stringify({
        startYear: 2097, label: "2097–2098", closingDate: "2098-07-31",
      }), JSON.stringify({
        oldClosingDate: "2098-07-31", newClosingDate: "2098-06-30",
      }), JSON.stringify({
        startYear: 2097, label: "2097–2098", closingDate: "2098-06-30",
      }), JSON.stringify({
        academicYearStart: 2020, academicYearLabel: REPORTS_ACCEPTANCE_FIXTURE.years.closed.label,
        filters: {}, sort: "name_asc",
        rowCount: 153, generatedAt: new Date().toISOString(), generationDurationMs: 25,
      }), JSON.stringify({
        academicYearStart: 2098, academicYearLabel: REPORTS_ACCEPTANCE_FIXTURE.years.open.label,
        filters: { overallStatus: null }, sort: "attention_first", rowCount: 4,
        generatedAt: new Date().toISOString(),
        generationDurationMs: 30,
      })],
    );
    await cleanupReportsAcceptanceFixture(pool, identity);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=ANY($1::uuid[])", [
      ownedAudits.rows.map((row) => row.id),
    ])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=$1", [unrelated.rows[0].id]))
      .rows[0].count).toBe(1);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM academic_years WHERE start_year=2097"))
      .rows[0].count).toBe(0);
    await pool.query("DELETE FROM audit_logs WHERE id=$1", [unrelated.rows[0].id]);
  });

  it("status and repeated setup refuse drifted academic-year ownership and dates", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await pool.query(
      `UPDATE academic_years SET closing_date='2021-06-30',updated_by=$1 WHERE start_year=2020`,
      ["00000000-0000-4000-8000-000000000002"],
    );
    await expect(getReportsAcceptanceFixtureStatus(pool, identity)).rejects.toThrow(/drift|readiness/i);
    await expect(setupReportsAcceptanceFixture(pool, identity)).rejects.toThrow(/drift|readiness/i);
    await cleanupReportsAcceptanceFixture(pool, identity);
  });

  it("status refuses drifted required CCS labels", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    const original = await pool.query<{ name: string }>("SELECT name FROM colleges WHERE id=$1", [CURRENT_COLLEGE_ID]);
    try {
      await pool.query("UPDATE colleges SET name='Drifted Reports Fixture College' WHERE id=$1", [CURRENT_COLLEGE_ID]);
      await expect(getReportsAcceptanceFixtureStatus(pool, identity)).rejects.toThrow(/reference|readiness|drift/i);
    } finally {
      await pool.query("UPDATE colleges SET name=$2 WHERE id=$1", [CURRENT_COLLEGE_ID, original.rows[0].name]);
      await cleanupReportsAcceptanceFixture(pool, identity);
    }
  });

  it("status refuses drifted immutable snapshot fields", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
      );
      await client.query("UPDATE student_academic_snapshots SET college_name='Drifted Snapshot' WHERE id=$1", [
        REPORTS_ACCEPTANCE_FIXTURE.snapshotIds[4],
      ]);
      await client.query(
        "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await expect(getReportsAcceptanceFixtureStatus(pool, identity)).rejects.toThrow(/snapshot|readiness|drift/i);
    await cleanupReportsAcceptanceFixture(pool, identity);
  });

  it("status refuses drifted appointment fields and extra fixture-student appointments", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await pool.query("UPDATE appointments SET status='NO_SHOW',appointment_date='2098-10-01' WHERE id=$1", [
      REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.at(-1),
    ]);
    await expect(getReportsAcceptanceFixtureStatus(pool, identity)).rejects.toThrow(/appointment|readiness|drift/i);
    await cleanupReportsAcceptanceFixture(pool, identity);

    await setupReportsAcceptanceFixture(pool, identity);
    const extraId = "b8500000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,created_by,updated_by
       ) VALUES ($1,$2,$3,'LABORATORY','2020-11-01','NO_SHOW',TRUE,2020,$4,$4)`,
      [extraId, LABORATORY_CLINIC_ID, REPORTS_ACCEPTANCE_FIXTURE.studentNumbers[4], ADMIN_USER_ID],
    );
    await expect(getReportsAcceptanceFixtureStatus(pool, identity)).rejects.toThrow(/appointment|extra|readiness|drift/i);
    await cleanupReportsAcceptanceFixture(pool, identity);
  });

  it("recovers partial fixture cleanup from the exact marker without a state file", async () => {
    await setupReportsAcceptanceFixture(pool, identity);
    await removeState();
    await pool.query("DELETE FROM appointments WHERE id=$1", [REPORTS_ACCEPTANCE_FIXTURE.appointmentIds.at(-1)]);
    await deleteSnapshotById(REPORTS_ACCEPTANCE_FIXTURE.snapshotIds.at(-1)!);
    await expect(cleanupReportsAcceptanceFixture(pool, identity)).resolves.toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
    await expect(cleanupReportsAcceptanceFixture(pool, identity)).resolves.toMatchObject({
      students: 0, snapshots: 0, appointments: 0, academicYears: 0,
      crudScratchYears: 0, auditLogs: 0, stateFiles: 0,
    });
  });
});
