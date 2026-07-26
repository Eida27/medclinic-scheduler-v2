// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "./pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

afterAll(async () => {
  await pool.end();
});

async function columnExists(tableName: string, columnName: string) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [tableName, columnName],
  );
  return result.rowCount === 1;
}

async function tableExists(tableName: string) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1`,
    [tableName],
  );
  return result.rowCount === 1;
}

describe("database constraints", () => {
  it("creates the automated scheduling and student portal foundation", async () => {
    await expect(columnExists("students", "date_of_birth")).resolves.toBe(true);
    await expect(columnExists("schedule_import_groups", "student_category")).resolves.toBe(true);
    await expect(columnExists("schedule_import_groups", "accepted_at")).resolves.toBe(true);
    await expect(columnExists("coordinator_schedule_items", "source_row_order")).resolves.toBe(true);
    await expect(columnExists("appointments", "schedule_pair_id")).resolves.toBe(true);
    await expect(columnExists("appointments", "schedule_cycle_start")).resolves.toBe(true);
    await expect(tableExists("clinic_unavailable_dates")).resolves.toBe(true);
    await expect(tableExists("appointment_reschedule_events")).resolves.toBe(true);
    await expect(tableExists("student_result_submissions")).resolves.toBe(true);
    await expect(tableExists("student_result_files")).resolves.toBe(true);
    await expect(tableExists("student_portal_notifications")).resolves.toBe(true);
    await expect(tableExists("email_outbox")).resolves.toBe(true);
  });

  it("creates current appointment and result submission read indexes", async () => {
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname='public'
          AND indexname IN (
            'appointments_current_service_lookup_idx',
            'student_result_submissions_admin_profile_idx'
          )
        ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      expect.objectContaining({
        indexname: "appointments_current_service_lookup_idx",
        indexdef: expect.stringContaining("student_number, schedule_type, appointment_date DESC"),
      }),
      expect.objectContaining({
        indexname: "student_result_submissions_admin_profile_idx",
        indexdef: expect.stringContaining("student_number, appointment_id, last_activity_at DESC"),
      }),
    ]);
  });

  it("creates reversible clinic-calendar history and active single-day invariants", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='public'
          AND (
            (table_name='clinic_unavailable_dates' AND column_name IN (
              'created_batch_id', 'unblocked_batch_id', 'unblocked_at', 'unblocked_by'
            ))
            OR
            (table_name='appointment_reschedule_events' AND column_name IN (
              'block_batch_id', 'restoration_batch_id', 'restored_at', 'restored_by'
            ))
          )`,
    );
    const columnNames = columns.rows.map((column) => `${column.table_name}.${column.column_name}`);
    expect(columnNames).toEqual(expect.arrayContaining([
      "clinic_unavailable_dates.created_batch_id",
      "clinic_unavailable_dates.unblocked_batch_id",
      "clinic_unavailable_dates.unblocked_at",
      "clinic_unavailable_dates.unblocked_by",
      "appointment_reschedule_events.block_batch_id",
      "appointment_reschedule_events.restoration_batch_id",
      "appointment_reschedule_events.restored_at",
      "appointment_reschedule_events.restored_by",
    ]));
    const columnTypes = new Map(columns.rows.map((column) => [
      `${column.table_name}.${column.column_name}`,
      column.data_type,
    ]));
    expect(Object.fromEntries(columnTypes)).toMatchObject({
      "clinic_unavailable_dates.created_batch_id": "uuid",
      "clinic_unavailable_dates.unblocked_batch_id": "uuid",
      "clinic_unavailable_dates.unblocked_at": "timestamp with time zone",
      "clinic_unavailable_dates.unblocked_by": "uuid",
      "appointment_reschedule_events.block_batch_id": "uuid",
      "appointment_reschedule_events.restoration_batch_id": "uuid",
      "appointment_reschedule_events.restored_at": "timestamp with time zone",
      "appointment_reschedule_events.restored_by": "uuid",
    });

    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT constraint_name AS conname, check_clause AS definition
         FROM information_schema.check_constraints
        WHERE constraint_schema='public'
          AND constraint_name IN (
            'clinic_unavailable_dates_unblock_complete',
            'clinic_unavailable_dates_active_single_day',
            'appointment_reschedule_events_restore_complete'
          )`,
    );
    const constraintNames = constraints.rows.map((constraint) => constraint.conname);
    expect(constraintNames).toEqual(expect.arrayContaining([
      "clinic_unavailable_dates_unblock_complete",
      "clinic_unavailable_dates_active_single_day",
      "appointment_reschedule_events_restore_complete",
    ]));
    const definitions = new Map(constraints.rows.map((constraint) => [constraint.conname, constraint.definition]));
    expect(definitions.get("clinic_unavailable_dates_unblock_complete"))
      .toMatch(/unblocked_at.*unblocked_by.*unblocked_batch_id.*OR.*unblocked_at.*unblocked_by.*unblocked_batch_id/i);
    expect(definitions.get("clinic_unavailable_dates_active_single_day"))
      .toMatch(/unblocked_at.*start_date.*end_date/i);
    expect(definitions.get("appointment_reschedule_events_restore_complete"))
      .toMatch(/restored_at.*restored_by.*restoration_batch_id.*OR.*restored_at.*restored_by.*restoration_batch_id/i);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public'
          AND indexname='clinic_unavailable_dates_one_active_day_idx'`,
    );
    expect(indexes.rows.map((index) => index.indexname)).toContain("clinic_unavailable_dates_one_active_day_idx");

    const activeRanges = await pool.query(
      `SELECT id::text
         FROM clinic_unavailable_dates
        WHERE unblocked_at IS NULL
          AND start_date <> end_date`,
    );
    expect(activeRanges.rows).toEqual([]);

    await expect(pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES ($1,'2047-07-15','2047-07-16','CLOSURE','TEST invalid active range',$2)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by,
         unblocked_at, unblocked_by
       ) VALUES ($1,'2047-07-17','2047-07-17','CLOSURE','TEST incomplete unblock',$2,NOW(),$2)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, TEST_REFERENCE_IDS.adminUser],
    )).rejects.toMatchObject({ code: "23514" });

    const completeUnblock = await pool.query<{ id: string }>(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by,
         unblocked_at, unblocked_by, unblocked_batch_id
       ) VALUES ($1,'2047-07-18','2047-07-18','CLOSURE','TEST complete unblock',$2,NOW(),$2,$3)
       RETURNING id::text`,
      [
        TEST_REFERENCE_IDS.physicalExamClinic,
        TEST_REFERENCE_IDS.adminUser,
        "71000000-0000-4000-8000-000000000001",
      ],
    );
    await pool.query("DELETE FROM clinic_unavailable_dates WHERE id=$1", [completeUnblock.rows[0].id]);
  });

  it("normalizes legacy active ranges and remaps their reschedule events", async () => {
    const schemaName = `task_1_migration_${randomUUID().replaceAll("-", "_")}`;
    const quotedSchema = `"${schemaName}"`;
    const client = await pool.connect();
    const sourceUnavailableDateId = "81000000-0000-4000-8000-000000000001";
    const rescheduleEventId = "82000000-0000-4000-8000-000000000001";

    try {
      await client.query(`CREATE SCHEMA ${quotedSchema}`);
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      await client.query(`
        CREATE TABLE users (id UUID PRIMARY KEY);
        CREATE TABLE clinics (id UUID PRIMARY KEY, code VARCHAR(40) NOT NULL);
        CREATE TABLE clinic_unavailable_dates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          clinic_id UUID NOT NULL REFERENCES clinics(id),
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          category VARCHAR(40) NOT NULL,
          reason TEXT NOT NULL,
          created_by UUID NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE appointments (id UUID PRIMARY KEY, appointment_date DATE NOT NULL);
        CREATE TABLE appointment_reschedule_events (
          id UUID PRIMARY KEY,
          clinic_unavailable_date_id UUID REFERENCES clinic_unavailable_dates(id),
          old_laboratory_appointment_id UUID REFERENCES appointments(id),
          old_physical_exam_appointment_id UUID REFERENCES appointments(id)
        );
      `);
      await client.query("INSERT INTO users (id) VALUES ($1)", [TEST_REFERENCE_IDS.adminUser]);
      await client.query("INSERT INTO clinics (id, code) VALUES ($1,'CPU_CLINIC')", [
        TEST_REFERENCE_IDS.physicalExamClinic,
      ]);
      await client.query("INSERT INTO appointments (id, appointment_date) VALUES ($1,'2047-07-16')", [
        "83000000-0000-4000-8000-000000000001",
      ]);
      await client.query(
        `INSERT INTO clinic_unavailable_dates (
           id, clinic_id, start_date, end_date, category, reason, created_by
         ) VALUES ($1,$2,'2047-07-15','2047-07-17','CLOSURE','TEST legacy CPU range',$3)`,
        [
          sourceUnavailableDateId,
          TEST_REFERENCE_IDS.physicalExamClinic,
          TEST_REFERENCE_IDS.adminUser,
        ],
      );
      await client.query(
        `INSERT INTO appointment_reschedule_events (
           id, clinic_unavailable_date_id, old_physical_exam_appointment_id
         ) VALUES ($1,$2,$3)`,
        [
          rescheduleEventId,
          sourceUnavailableDateId,
          "83000000-0000-4000-8000-000000000001",
        ],
      );

      const migrationSql = await readFile(
        join(process.cwd(), "database", "migrations", "013_clinic_calendar_batch_editor.sql"),
        "utf8",
      );
      await client.query("BEGIN");
      try {
        await client.query(migrationSql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      const splitDates = await client.query<{ start_date: string; end_date: string }>(
        `SELECT start_date::text, end_date::text
           FROM clinic_unavailable_dates
          WHERE reason='TEST legacy CPU range'
          ORDER BY start_date`,
      );
      expect(splitDates.rows).toEqual([
        { start_date: "2047-07-15", end_date: "2047-07-15" },
        { start_date: "2047-07-16", end_date: "2047-07-16" },
        { start_date: "2047-07-17", end_date: "2047-07-17" },
      ]);

      const remappedEvent = await client.query<{ start_date: string; end_date: string }>(
        `SELECT unavailable.start_date::text, unavailable.end_date::text
           FROM appointment_reschedule_events event
           JOIN clinic_unavailable_dates unavailable ON unavailable.id=event.clinic_unavailable_date_id
          WHERE event.id=$1`,
        [rescheduleEventId],
      );
      expect(remappedEvent.rows).toEqual([
        { start_date: "2047-07-16", end_date: "2047-07-16" },
      ]);

      await expect(client.query(
        "UPDATE appointment_reschedule_events SET restored_at=NOW() WHERE id=$1",
        [rescheduleEventId],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(
        `UPDATE appointment_reschedule_events
            SET restored_at=NOW(), restored_by=$2, restoration_batch_id=$3
          WHERE id=$1`,
        [
          rescheduleEventId,
          TEST_REFERENCE_IDS.adminUser,
          "84000000-0000-4000-8000-000000000001",
        ],
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      client.release();
    }
  });

  it("creates schedule import groups with the required columns, defaults, and updated-at trigger", async () => {
    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='schedule_import_groups'
        ORDER BY ordinal_position`,
    );

    expect(columns.rows).toEqual([
      { column_name: "id", data_type: "uuid", character_maximum_length: null, is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "import_name", data_type: "character varying", character_maximum_length: 150, is_nullable: "NO", column_default: null },
      { column_name: "source_filename", data_type: "character varying", character_maximum_length: 255, is_nullable: "NO", column_default: null },
      { column_name: "total_rows", data_type: "integer", character_maximum_length: null, is_nullable: "NO", column_default: null },
      { column_name: "created_student_count", data_type: "integer", character_maximum_length: null, is_nullable: "NO", column_default: "0" },
      { column_name: "matched_student_count", data_type: "integer", character_maximum_length: null, is_nullable: "NO", column_default: "0" },
      { column_name: "submitted_by_name", data_type: "character varying", character_maximum_length: 150, is_nullable: "YES", column_default: null },
      { column_name: "description", data_type: "text", character_maximum_length: null, is_nullable: "YES", column_default: null },
      { column_name: "created_by", data_type: "uuid", character_maximum_length: null, is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", character_maximum_length: null, is_nullable: "NO", column_default: "now()" },
      { column_name: "updated_at", data_type: "timestamp with time zone", character_maximum_length: null, is_nullable: "NO", column_default: "now()" },
      { column_name: "student_category", data_type: "character varying", character_maximum_length: 30, is_nullable: "YES", column_default: null },
      { column_name: "academic_year_start", data_type: "integer", character_maximum_length: null, is_nullable: "YES", column_default: null },
      { column_name: "preferred_month", data_type: "integer", character_maximum_length: null, is_nullable: "YES", column_default: null },
      { column_name: "accepted_at", data_type: "timestamp with time zone", character_maximum_length: null, is_nullable: "NO", column_default: "clock_timestamp()" },
    ]);

    const created = await pool.query<{
      id: string;
      created_student_count: number;
      matched_student_count: number;
      created_at: Date;
      updated_at: Date;
      accepted_at: Date;
    }>(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_by, created_at, updated_at
       ) VALUES ($1,$2,2,$3,NOW() - INTERVAL '1 day',NOW() - INTERVAL '1 day')
       RETURNING id, created_student_count, matched_student_count, created_at, updated_at, accepted_at`,
      ["TEST database import group", "test-schedule.csv", "00000000-0000-4000-8000-000000000001"],
    );
    const group = created.rows[0];

    try {
      expect(group).toMatchObject({ created_student_count: 0, matched_student_count: 0 });
      await pool.query("UPDATE schedule_import_groups SET description='updated' WHERE id=$1", [group.id]);
      const updated = await pool.query<{ updated_at: Date }>(
        "SELECT updated_at FROM schedule_import_groups WHERE id=$1",
        [group.id],
      );
      expect(updated.rows[0].updated_at.getTime()).toBeGreaterThan(group.updated_at.getTime());
      await expect(
        pool.query("UPDATE schedule_import_groups SET accepted_at=NOW() WHERE id=$1", [group.id]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.query("DELETE FROM schedule_import_groups WHERE id=$1", [group.id]);
    }
  });

  it("enforces import group counts and user ownership", async () => {
    const insert = (totalRows: number, createdCount = 0, matchedCount = 0, createdBy = "00000000-0000-4000-8000-000000000001") => pool.query(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_student_count, matched_student_count, created_by
       ) VALUES ('TEST invalid group','invalid.csv',$1,$2,$3,$4)`,
      [totalRows, createdCount, matchedCount, createdBy],
    );

    await expect(insert(0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(1, -1)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(1, 0, -1)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(1, 0, 0, "99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({ code: "23503" });
  });

  it("supports legacy batches and limits grouped children to one batch per clinic", async () => {
    const group = await pool.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (import_name, source_filename, total_rows, created_by)
       VALUES ('TEST grouped children','grouped.csv',2,$1) RETURNING id`,
      ["00000000-0000-4000-8000-000000000001"],
    );
    const groupId = group.rows[0].id;
    const createdBatchIds: string[] = [];
    const insertBatch = async (name: string, clinicId: string, importGroupId?: string | null) => {
      const result = importGroupId === undefined
        ? await pool.query<{ id: string; import_group_id: string | null }>(
            `INSERT INTO schedule_batches (clinic_id, batch_name, created_by)
             VALUES ($1,$2,$3) RETURNING id, import_group_id`,
            [clinicId, name, "00000000-0000-4000-8000-000000000001"],
          )
        : await pool.query<{ id: string; import_group_id: string | null }>(
            `INSERT INTO schedule_batches (clinic_id, batch_name, created_by, import_group_id)
             VALUES ($1,$2,$3,$4) RETURNING id, import_group_id`,
            [clinicId, name, "00000000-0000-4000-8000-000000000001", importGroupId],
          );
      createdBatchIds.push(result.rows[0].id);
      return result.rows[0];
    };

    try {
      const legacyOne = await insertBatch("TEST legacy batch one", "60000000-0000-4000-8000-000000000001");
      const legacyTwo = await insertBatch("TEST legacy batch two", "60000000-0000-4000-8000-000000000001", null);
      expect(legacyOne.import_group_id).toBeNull();
      expect(legacyTwo.import_group_id).toBeNull();

      await insertBatch("TEST grouped laboratory", "60000000-0000-4000-8000-000000000001", groupId);
      await insertBatch("TEST grouped physical", "60000000-0000-4000-8000-000000000002", groupId);
      await expect(insertBatch("TEST duplicate grouped clinic", "60000000-0000-4000-8000-000000000001", groupId))
        .rejects.toMatchObject({ code: "23505" });
      await expect(insertBatch("TEST missing import group", "60000000-0000-4000-8000-000000000002", "99999999-9999-4999-8999-999999999999"))
        .rejects.toMatchObject({ code: "23503" });

      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname='public'
            AND indexname IN ('batches_import_group_status_idx','batches_import_group_clinic_unique')
          ORDER BY indexname`,
      );
      expect(indexes.rows).toEqual([
        expect.objectContaining({
          indexname: "batches_import_group_clinic_unique",
          indexdef: expect.stringMatching(/UNIQUE.*\(import_group_id, clinic_id\).*WHERE \(import_group_id IS NOT NULL\)/),
        }),
        expect.objectContaining({
          indexname: "batches_import_group_status_idx",
          indexdef: expect.stringContaining("(import_group_id, status)"),
        }),
      ]);
    } finally {
      if (createdBatchIds.length) {
        await pool.query("DELETE FROM schedule_batches WHERE id = ANY($1::uuid[])", [createdBatchIds]);
      }
      await pool.query("DELETE FROM schedule_import_groups WHERE id=$1", [groupId]);
    }
  });

  it("seeds required reference, user, priority, program, and capacity data", async () => {
    const clinics = await pool.query<{ code: string; name: string }>(
      `SELECT code, name FROM clinics
        WHERE id IN (
          '60000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-000000000002'
        )
        ORDER BY code`,
    );
    expect(clinics.rows).toEqual([
      { code: "CPU_CLINIC", name: "CPU Clinic" },
      { code: "KABALAKA_CLINIC", name: "KABALAKA Clinic" },
    ]);

    const capacity = await pool.query<{ code: string; schedule_type: string; safe_daily_capacity: number; max_daily_capacity: number }>(
      `SELECT c.code, s.schedule_type, s.safe_daily_capacity, s.max_daily_capacity
         FROM clinic_capacity_settings s
         JOIN clinics c ON c.id = s.clinic_id
        WHERE s.id IN (
          '40000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000002'
        )
        ORDER BY c.code, s.schedule_type`,
    );
    expect(capacity.rows).toEqual([
      { code: "CPU_CLINIC", schedule_type: "PHYSICAL_EXAM", safe_daily_capacity: 150, max_daily_capacity: 150 },
      { code: "KABALAKA_CLINIC", schedule_type: "LABORATORY", safe_daily_capacity: 150, max_daily_capacity: 150 },
    ]);

    const users = await pool.query<{ full_name: string; email: string; role: string; clinic_code: string | null }>(
      `SELECT u.full_name, u.email, u.role, c.code AS clinic_code
         FROM users u LEFT JOIN clinics c ON c.id=u.clinic_id
        WHERE u.id IN (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003'
        )
        ORDER BY u.id`,
    );
    expect(users.rows).toEqual([
      { full_name: "System Admin", email: "admin@medclinic.local", role: "ADMIN", clinic_code: null },
      { full_name: "Clinic Staff", email: "staff@medclinic.local", role: "CLINIC_STAFF", clinic_code: "KABALAKA_CLINIC" },
      { full_name: "Schedule Coordinator", email: "coordinator@medclinic.local", role: "COORDINATOR", clinic_code: null },
    ]);

    const catalogCounts = await pool.query<{ colleges: number; programs: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM colleges) AS colleges,
         (SELECT COUNT(*)::int FROM programs) AS programs`,
    );
    expect(catalogCounts.rows).toEqual([{ colleges: 13, programs: 48 }]);

    const programs = await pool.query<{ college_code: string; program_code: string; program_name: string }>(
      `SELECT c.code AS college_code, p.code AS program_code
              , p.name AS program_name
         FROM programs p JOIN colleges c ON c.id=p.college_id
         WHERE p.id IN (
           '20000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000003'
        )
        ORDER BY c.code`,
    );
    expect(programs.rows).toEqual([
      { college_code: "CCS", program_code: "BSIT", program_name: "Bachelor of Science in Information Technology" },
      { college_code: "COEng", program_code: "BSCE", program_name: "Bachelor of Science in Civil Engineering" },
      { college_code: "CON", program_code: "BSN", program_name: "Bachelor of Science in Nursing" },
    ]);

    const duplicateScopedCode = await pool.query<{ college_code: string; program_name: string }>(
      `SELECT c.code AS college_code, p.name AS program_name
         FROM programs p JOIN colleges c ON c.id=p.college_id
        WHERE p.code='BSA'
        ORDER BY c.code`,
    );
    expect(duplicateScopedCode.rows).toEqual([
      { college_code: "CARES", program_name: "Bachelor of Science in Agriculture" },
      { college_code: "CBA", program_name: "Bachelor of Science in Accountancy" },
    ]);

    const priorities = await pool.query<{ name: string; rank_order: number }>(
      `SELECT name, rank_order FROM priority_groups
         WHERE id IN (
           '30000000-0000-4000-8000-000000000002',
           '30000000-0000-4000-8000-000000000003',
          '30000000-0000-4000-8000-000000000004'
        )
        ORDER BY rank_order`,
    );
    expect(priorities.rows).toEqual([
      { name: "OJT", rank_order: 1 },
      { name: "Tour", rank_order: 2 },
      { name: "Regular", rank_order: 3 },
    ]);
    await expect(pool.query("SELECT 1 FROM priority_groups WHERE name='Graduating'"))
      .resolves.toMatchObject({ rowCount: 0 });
  });

  it("keeps coordinator accounts global at the database boundary", async () => {
    await expect(pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, clinic_id)
       VALUES ('Scoped Coordinator', 'scoped.coordinator@example.com', 'not-used', 'COORDINATOR',
         '60000000-0000-4000-8000-000000000001')`,
    )).rejects.toMatchObject({ constraint: "users_coordinator_global" });
  });

  it("rejects persisted BOTH coordinator schedule items", async () => {
    const studentNumber = "TEST-DB-BOTH";
    await expect(
      transaction(async (client) => {
        await client.query(
          `INSERT INTO students (student_number, first_name, last_name, college_id, program_id, year_level)
           VALUES ($1,'Database','Fixture',$2,$3,1)`,
          [studentNumber, "10000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000003"],
        );
        const batch = await client.query<{ id: string }>(
          `INSERT INTO schedule_batches (clinic_id, batch_name, created_by)
           VALUES ($1,'TEST persisted BOTH constraint',$2) RETURNING id`,
          ["60000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"],
        );
        await client.query(
          `INSERT INTO coordinator_schedule_items (
            batch_id, student_number, schedule_type, priority_group_id, clinic_id, target_date
          ) VALUES ($1, $2, 'BOTH', $3, $4, DATE '2026-09-01')`,
          [
            batch.rows[0].id,
            studentNumber,
            "30000000-0000-4000-8000-000000000004",
            "60000000-0000-4000-8000-000000000001",
          ],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });

    expect((await pool.query("SELECT 1 FROM students WHERE student_number=$1", [studentNumber])).rowCount).toBe(0);
  });

  it("contains no production demo students or known demo batches", async () => {
    const students = await pool.query("SELECT student_number FROM students WHERE student_number LIKE 'DEMO-%'");
    const batches = await pool.query(
      `SELECT id FROM schedule_batches WHERE id = ANY($1::uuid[])`,
      [[
        "50000000-0000-4000-8000-000000000120",
        "50000000-0000-4000-8000-000000000130",
        "50000000-0000-4000-8000-000000000160",
        "50000000-0000-4000-8000-000000000010",
        "50000000-0000-4000-8000-000000000011",
      ]],
    );

    expect(students.rows).toEqual([]);
    expect(batches.rows).toEqual([]);
  });

  it("rejects a student whose program belongs to another college", async () => {
    await expect(
      pool.query(
        `INSERT INTO students (
          student_number, first_name, last_name, college_id, program_id
        ) VALUES ($1, 'Wrong', 'College', $2, $3)`,
        [
          "TEST-WRONG-COLLEGE",
          "10000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000003",
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rolls back all writes when a transaction fails", async () => {
    await expect(
      transaction(async (client) => {
        await client.query(
          `INSERT INTO students (
            student_number, first_name, last_name, college_id, program_id
          ) VALUES ('TEST-ROLLBACK', 'Rollback', 'Student', $1, $2)`,
          [
            "10000000-0000-4000-8000-000000000003",
            "20000000-0000-4000-8000-000000000003",
          ],
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const result = await pool.query("SELECT 1 FROM students WHERE student_number = 'TEST-ROLLBACK'");
    expect(result.rowCount).toBe(0);
  });
});
