import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  captureCleanupManifest,
  deleteManifestDatabaseRows,
  privateResultDirectories,
  runPersistedCatalogCleanup,
  type CatalogCleanupProgress,
  type CleanupDatabaseIdentity,
} from "../../scripts/db-reference-catalog-cleanup";

const integration = process.env.REFERENCE_CATALOG_CLEANUP_INTEGRATION_EXCLUSIVE_DATABASE === "1"
  ? describe
  : describe.skip;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const created = {
  collegeId: "",
  programId: "",
  importGroupId: "",
  batchId: "",
  targetStudent: "",
  retainedStudent: "",
};
let storageRoot = "";

async function cleanupFixture() {
  if (created.targetStudent || created.retainedStudent) {
    const students = [created.targetStudent, created.retainedStudent].filter(Boolean);
    await pool.query(
      "DELETE FROM audit_logs WHERE entity_id=ANY($1::text[]) OR metadata->>'studentNumber'=ANY($1::text[])",
      [students],
    );
    await pool.query("DELETE FROM student_result_submissions WHERE student_number=ANY($1::varchar[])", [students]);
    await pool.query("DELETE FROM exam_results WHERE student_number=ANY($1::varchar[])", [students]);
    await pool.query("DELETE FROM laboratory_results WHERE student_number=ANY($1::varchar[])", [students]);
    await pool.query("DELETE FROM appointments WHERE student_number=ANY($1::varchar[])", [students]);
    await pool.query("DELETE FROM coordinator_schedule_items WHERE student_number=ANY($1::varchar[])", [students]);
    await pool.query("DELETE FROM students WHERE student_number=ANY($1::varchar[])", [students]);
  }
  if (created.batchId) await pool.query("DELETE FROM schedule_batches WHERE id=$1", [created.batchId]);
  if (created.importGroupId) await pool.query("DELETE FROM schedule_import_groups WHERE id=$1", [created.importGroupId]);
  if (created.programId) await pool.query("DELETE FROM programs WHERE id=$1", [created.programId]);
  if (created.collegeId) await pool.query("DELETE FROM colleges WHERE id=$1", [created.collegeId]);
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  Object.assign(created, {
    collegeId: "",
    programId: "",
    importGroupId: "",
    batchId: "",
    targetStudent: "",
    retainedStudent: "",
  });
}

integration("reference catalog destructive cleanup", () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "medclinic-reference-catalog-"));
  });
  afterEach(cleanupFixture);
  afterAll(async () => {
    await cleanupFixture();
    await pool.end();
  });

  it("removes the whole mixed import but retains the valid student profile and resumes file cleanup", async () => {
    created.collegeId = randomUUID();
    created.programId = randomUUID();
    created.importGroupId = randomUUID();
    created.batchId = randomUUID();
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    created.targetStudent = `CAT-${suffix}-A`;
    created.retainedStudent = `CAT-${suffix}-B`;
    const targetItemId = randomUUID();
    const retainedItemId = randomUUID();
    const targetAppointmentId = randomUUID();
    const retainedAppointmentId = randomUUID();
    const submissionId = randomUUID();
    const storageKey = `${submissionId}/result.pdf`;

    await pool.query(
      `INSERT INTO colleges (id, code, name) VALUES ($1,$2,$3)`,
      [created.collegeId, `OLD${suffix.slice(0, 6)}`, `Obsolete College ${suffix}`],
    );
    await pool.query(
      `INSERT INTO programs (id, college_id, code, name) VALUES ($1,$2,$3,$4)`,
      [created.programId, created.collegeId, `OLD${suffix.slice(0, 6)}`, `Obsolete Program ${suffix}`],
    );
    await pool.query(
      `INSERT INTO students (student_number, first_name, last_name, college_id, program_id, year_level)
       VALUES ($1,'Target','Catalog',$3,$4,1),
              ($2,'Retained','Catalog','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',1)`,
      [created.targetStudent, created.retainedStudent, created.collegeId, created.programId],
    );
    await pool.query(
      `INSERT INTO schedule_import_groups (
         id, import_name, source_filename, total_rows, created_student_count,
         matched_student_count, created_by, student_category, academic_year_start
       ) VALUES ($1,$2,'catalog-cleanup.csv',2,1,1,'00000000-0000-4000-8000-000000000001','REGULAR',2026)`,
      [created.importGroupId, `TEST reference catalog ${suffix}`],
    );
    await pool.query(
      `INSERT INTO schedule_batches (id, clinic_id, batch_name, status, created_by, import_group_id)
       VALUES ($1,'60000000-0000-4000-8000-000000000001',$2,'PUBLISHED',
         '00000000-0000-4000-8000-000000000001',$3)`,
      [created.batchId, `TEST reference catalog ${suffix}`, created.importGroupId],
    );
    await pool.query(
      `INSERT INTO coordinator_schedule_items (
         id, batch_id, clinic_id, student_number, schedule_type, priority_group_id,
         target_date, status, source_row_order, schedule_cycle_start
       ) VALUES
         ($1,$3,'60000000-0000-4000-8000-000000000001',$4,'LABORATORY',NULL,'2026-08-03','SCHEDULED',1,2026),
         ($2,$3,'60000000-0000-4000-8000-000000000001',$5,'LABORATORY',NULL,'2026-08-03','SCHEDULED',2,2026)`,
      [targetItemId, retainedItemId, created.batchId, created.targetStudent, created.retainedStudent],
    );
    await pool.query(
      `INSERT INTO appointments (
         id, batch_id, schedule_item_id, clinic_id, student_number, schedule_type,
         appointment_date, status, is_published, schedule_cycle_start, created_by
       ) VALUES
         ($1,$3,$4,'60000000-0000-4000-8000-000000000001',$6,'LABORATORY','2026-08-03','PENDING',TRUE,2026,
          '00000000-0000-4000-8000-000000000001'),
         ($2,$3,$5,'60000000-0000-4000-8000-000000000001',$7,'LABORATORY','2026-08-03','PENDING',TRUE,2026,
          '00000000-0000-4000-8000-000000000001')`,
      [targetAppointmentId, retainedAppointmentId, created.batchId, targetItemId, retainedItemId, created.targetStudent, created.retainedStudent],
    );
    await pool.query(
      `INSERT INTO laboratory_results (student_number, appointment_id, result_status)
       VALUES ($1,$2,'PENDING_UPLOAD')`,
      [created.targetStudent, targetAppointmentId],
    );
    await pool.query(
      `INSERT INTO student_result_submissions (id, appointment_id, student_number, result_type)
       VALUES ($1,$2,$3,'LABORATORY')`,
      [submissionId, targetAppointmentId, created.targetStudent],
    );
    await pool.query(
      `INSERT INTO student_result_files (
         submission_id, storage_key, original_filename, detected_mime_type,
         extension, byte_size, checksum_sha256
       ) VALUES ($1,$2,'result.pdf','application/pdf','pdf',8,$3)`,
      [submissionId, storageKey, "0".repeat(64)],
    );
    await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, metadata)
       VALUES ('TEST_CATALOG_CLEANUP','student',$1::text,jsonb_build_object('studentNumber',$1::text))`,
      [created.targetStudent],
    );
    await mkdir(join(storageRoot, submissionId), { recursive: true });
    await writeFile(join(storageRoot, storageKey), "%PDF-1.7");

    const client = await pool.connect();
    let manifest;
    try {
      manifest = await captureCleanupManifest(client);
    } finally {
      client.release();
    }
    expect(manifest.studentNumbers).toContain(created.targetStudent);
    expect(manifest.studentNumbers).not.toContain(created.retainedStudent);
    expect(manifest.importGroupIds).toContain(created.importGroupId);
    expect(manifest.appointmentIds).toEqual(expect.arrayContaining([targetAppointmentId, retainedAppointmentId]));
    expect(manifest.resultFiles).toContainEqual(expect.objectContaining({ storageKey }));

    const identity: CleanupDatabaseIdentity = {
      scheme: "postgresql",
      host: "localhost",
      port: "5432",
      database: "exclusive-test",
      storageRoot,
    };
    let persisted: CatalogCleanupProgress | undefined;
    let failFiles = true;
    const actions = {
      captureManifest: async () => manifest,
      persist: async (progress: CatalogCleanupProgress) => { persisted = structuredClone(progress); },
      deleteDatabase: (captured: typeof manifest) => deleteManifestDatabaseRows(pool, captured),
      deletePrivateFiles: async (directories: string[]) => {
        if (failFiles) throw new Error("injected storage outage");
        await Promise.all(directories.map((directory) => rm(join(storageRoot, directory), { recursive: true, force: true })));
      },
      prove: async () => {
        const rows = await pool.query<{ target: number; retained: number; imports: number }>(
          `SELECT
             (SELECT COUNT(*)::int FROM students WHERE student_number=$1) AS target,
             (SELECT COUNT(*)::int FROM students WHERE student_number=$2) AS retained,
             (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$3) AS imports`,
          [created.targetStudent, created.retainedStudent, created.importGroupId],
        );
        let privateStorageDirectories = 0;
        for (const directory of privateResultDirectories(manifest.resultFiles.map((file) => file.storageKey))) {
          try {
            await access(join(storageRoot, directory));
            privateStorageDirectories += 1;
          } catch {
            // Missing is the desired cleanup result.
          }
        }
        return {
          databaseRows: rows.rows[0].target + rows.rows[0].imports,
          privateStorageDirectories,
        };
      },
    };

    await expect(runPersistedCatalogCleanup(undefined, identity, actions))
      .rejects.toThrow("injected storage outage");
    expect(persisted?.phase).toBe("DATABASE_DELETED");
    failFiles = false;
    await expect(runPersistedCatalogCleanup(persisted, identity, actions))
      .resolves.toEqual({ databaseRows: 0, privateStorageDirectories: 0 });

    await expect(pool.query("SELECT 1 FROM students WHERE student_number=$1", [created.retainedStudent]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("SELECT 1 FROM appointments WHERE student_number=$1", [created.retainedStudent]))
      .resolves.toMatchObject({ rowCount: 0 });
    await expect(access(join(storageRoot, submissionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks direct migration until referenced obsolete data is cleaned, then reconciles legacy values", async () => {
    created.collegeId = randomUUID();
    created.programId = randomUUID();
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    created.targetStudent = `CAT-${suffix}-M`;
    await pool.query(
      "INSERT INTO colleges (id, code, name) VALUES ($1,$2,$3)",
      [created.collegeId, `OLD${suffix.slice(0, 6)}`, `Migration College ${suffix}`],
    );
    await pool.query(
      "INSERT INTO programs (id, college_id, code, name) VALUES ($1,$2,$3,$4)",
      [created.programId, created.collegeId, `OLD${suffix.slice(0, 6)}`, `Migration Program ${suffix}`],
    );
    await pool.query(
      `INSERT INTO students (student_number, first_name, last_name, college_id, program_id, year_level)
       VALUES ($1,'Migration','Blocked',$2,$3,1)`,
      [created.targetStudent, created.collegeId, created.programId],
    );
    const migration = await readFile(resolve("database/migrations/012_cpu_reference_catalog.sql"), "utf8");
    created.retainedStudent = `CAT-${suffix}-L`;
    created.batchId = randomUUID();
    const legacyItemId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(client.query(migration)).rejects.toThrow(/db:reference-catalog-cleanup -- apply/u);
      await client.query("ROLLBACK");

      const manifestClient = await pool.connect();
      let manifest;
      try {
        manifest = await captureCleanupManifest(manifestClient);
      } finally {
        manifestClient.release();
      }
      await deleteManifestDatabaseRows(pool, manifest);

      await client.query("BEGIN");
      await client.query("UPDATE colleges SET code='COE' WHERE id='10000000-0000-4000-8000-000000000001'");
      await client.query("UPDATE programs SET name='BS Civil Engineering' WHERE id='20000000-0000-4000-8000-000000000001'");
      await client.query(
        `INSERT INTO priority_groups (id, name, rank_order)
         VALUES ('30000000-0000-4000-8000-000000000001','Graduating',4)`,
      );
      await client.query(
        `INSERT INTO students (student_number, first_name, last_name, college_id, program_id, year_level)
         VALUES ($1,'Legacy','Priority','10000000-0000-4000-8000-000000000003',
           '20000000-0000-4000-8000-000000000003',1)`,
        [created.retainedStudent],
      );
      await client.query(
        `INSERT INTO schedule_batches (id, clinic_id, batch_name, created_by)
         VALUES ($1,'60000000-0000-4000-8000-000000000001',$2,
           '00000000-0000-4000-8000-000000000001')`,
        [created.batchId, `Legacy Graduating ${suffix}`],
      );
      await client.query(
        `INSERT INTO coordinator_schedule_items (
           id, batch_id, clinic_id, student_number, schedule_type, priority_group_id,
           target_date, source_row_order, schedule_cycle_start
         ) VALUES ($1,$2,'60000000-0000-4000-8000-000000000001',$3,'LABORATORY',
           '30000000-0000-4000-8000-000000000001','2026-08-03',1,2026)`,
        [legacyItemId, created.batchId, created.retainedStudent],
      );
      await client.query(migration);
      const proof = await client.query<{
        colleges: number;
        programs: number;
        engineeringCode: string;
        civilEngineeringName: string;
        graduating: number;
        priorities: string;
        legacyPriorityCleared: boolean;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM colleges) AS colleges,
           (SELECT COUNT(*)::int FROM programs) AS programs,
           (SELECT code FROM colleges WHERE id='10000000-0000-4000-8000-000000000001') AS "engineeringCode",
           (SELECT name FROM programs WHERE id='20000000-0000-4000-8000-000000000001') AS "civilEngineeringName",
           (SELECT COUNT(*)::int FROM priority_groups WHERE name='Graduating') AS graduating,
           (SELECT priority_group_id IS NULL
              FROM coordinator_schedule_items
             WHERE id='${legacyItemId}') AS "legacyPriorityCleared",
           (SELECT string_agg(name || ':' || rank_order, ',' ORDER BY rank_order)
              FROM priority_groups
             WHERE id IN (
               '30000000-0000-4000-8000-000000000002',
               '30000000-0000-4000-8000-000000000003',
               '30000000-0000-4000-8000-000000000004'
             )) AS priorities`,
      );
      expect(proof.rows).toEqual([{
        colleges: 13,
        programs: 48,
        engineeringCode: "COEng",
        civilEngineeringName: "Bachelor of Science in Civil Engineering",
        graduating: 0,
        priorities: "OJT:1,Tour:2,Regular:3",
        legacyPriorityCleared: true,
      }]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
