// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_NUMBER = "TEST-MIGRATION-01";
const OTHER_STUDENT_NUMBER = "TEST-MIGRATION-02";

afterAll(async () => {
  await pool.end();
});

async function migrationSql() {
  return readFile(
    join(process.cwd(), "database", "migrations", "014_unified_clinic_calendar.sql"),
    "utf8",
  );
}

async function createLegacySchema(client: PoolClient, schemaName: string) {
  const quotedSchema = `"${schemaName}"`;
  await client.query(`CREATE SCHEMA ${quotedSchema}`);
  await client.query(`SET search_path TO ${quotedSchema}, public`);
  await client.query(`
    CREATE TABLE users (id UUID PRIMARY KEY);
    CREATE TABLE students (student_number VARCHAR(30) PRIMARY KEY);
    CREATE TABLE appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_number VARCHAR(30) NOT NULL REFERENCES students(student_number),
      clinic_id UUID NOT NULL DEFAULT gen_random_uuid(),
      schedule_pair_id UUID,
      schedule_cycle_start INTEGER NOT NULL DEFAULT 2026,
      schedule_type VARCHAR(30) NOT NULL,
      appointment_date DATE NOT NULL,
      status VARCHAR(30) NOT NULL
        CONSTRAINT appointments_status_check
        CHECK (status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW','RESCHEDULED','CANCELLED')),
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      is_manually_locked BOOLEAN NOT NULL DEFAULT FALSE,
      rescheduled_from UUID REFERENCES appointments(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX appointments_one_active_service_cycle_idx
      ON appointments(student_number, schedule_type, schedule_cycle_start)
      WHERE status IN ('DRAFT','PENDING');
    CREATE TABLE appointment_status_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      notes TEXT
    );
    CREATE TABLE clinic_unavailable_dates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id UUID NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      category VARCHAR(40) NOT NULL,
      reason TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_batch_id UUID,
      unblocked_at TIMESTAMPTZ,
      unblocked_by UUID REFERENCES users(id),
      unblocked_batch_id UUID
    );
    CREATE TABLE appointment_reschedule_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_number VARCHAR(30) NOT NULL REFERENCES students(student_number),
      schedule_pair_id UUID,
      cause VARCHAR(40) NOT NULL,
      source_import_group_id UUID,
      clinic_unavailable_date_id UUID REFERENCES clinic_unavailable_dates(id),
      old_laboratory_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
      new_laboratory_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
      old_physical_exam_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
      new_physical_exam_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      block_batch_id UUID,
      restored_at TIMESTAMPTZ,
      restored_by UUID REFERENCES users(id),
      restoration_batch_id UUID
    );
    CREATE TABLE student_result_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID NOT NULL REFERENCES appointments(id),
      status VARCHAR(30) NOT NULL
    );
    CREATE TABLE exam_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID REFERENCES appointments(id),
      result_status VARCHAR(30) NOT NULL
    );
    CREATE TABLE laboratory_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID REFERENCES appointments(id),
      result_status VARCHAR(30) NOT NULL
    );
    CREATE TABLE student_portal_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE email_outbox (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await client.query("INSERT INTO users(id) VALUES ($1)", [ADMIN_ID]);
  await client.query(
    "INSERT INTO students(student_number) VALUES ($1),($2)",
    [STUDENT_NUMBER, OTHER_STUDENT_NUMBER],
  );
  return quotedSchema;
}

async function insertClosureLineage(
  client: PoolClient,
  overrides: {
    generatedStatus?: string;
    manuallyLocked?: boolean;
    mismatchedLineage?: boolean;
    protectedResult?: boolean;
    finalizedSubmission?: boolean;
  } = {},
) {
  const originalLaboratoryId = randomUUID();
  const originalPhysicalId = randomUUID();
  const generatedLaboratoryId = randomUUID();
  const generatedPhysicalId = randomUUID();
  const unavailableDateId = randomUUID();
  const closureEventId = randomUUID();
  const unrelatedEventId = randomUUID();
  const pairId = randomUUID();

  await client.query(
    `INSERT INTO appointments (
       id,student_number,schedule_pair_id,schedule_type,appointment_date,status,is_published
     ) VALUES
       ($1,$5,$6,'LABORATORY','2027-08-10','RESCHEDULED',TRUE),
       ($2,$5,$6,'PHYSICAL_EXAM','2027-08-11','RESCHEDULED',TRUE),
       ($3,$5,$6,'LABORATORY','2027-08-16',$7,TRUE),
       ($4,$5,$6,'PHYSICAL_EXAM','2027-08-17',$7,TRUE)`,
    [
      originalLaboratoryId,
      originalPhysicalId,
      generatedLaboratoryId,
      generatedPhysicalId,
      STUDENT_NUMBER,
      pairId,
      overrides.generatedStatus ?? "PENDING",
    ],
  );
  await client.query(
    `UPDATE appointments
        SET rescheduled_from=CASE id WHEN $1 THEN $3::uuid ELSE $4::uuid END,
            is_manually_locked=$5
      WHERE id IN ($1,$2)`,
    [
      generatedLaboratoryId,
      generatedPhysicalId,
      overrides.mismatchedLineage ? originalPhysicalId : originalLaboratoryId,
      originalPhysicalId,
      overrides.manuallyLocked ?? false,
    ],
  );
  await client.query(
    `INSERT INTO clinic_unavailable_dates (
       id,clinic_id,start_date,end_date,category,reason,created_by,created_batch_id
     ) VALUES ($1,$2,'2027-08-10','2027-08-10','CLOSURE','TEST migration closure',$3,$4)`,
    [unavailableDateId, randomUUID(), ADMIN_ID, randomUUID()],
  );
  await client.query(
    `INSERT INTO appointment_reschedule_events (
       id,student_number,schedule_pair_id,cause,clinic_unavailable_date_id,
       old_laboratory_appointment_id,new_laboratory_appointment_id,
       old_physical_exam_appointment_id,new_physical_exam_appointment_id,actor_user_id
     ) VALUES ($1,$2,$3,'CLINIC_CLOSURE',$4,$5,$6,$7,$8,$9)`,
    [
      closureEventId,
      STUDENT_NUMBER,
      pairId,
      unavailableDateId,
      originalLaboratoryId,
      generatedLaboratoryId,
      originalPhysicalId,
      generatedPhysicalId,
      ADMIN_ID,
    ],
  );
  await client.query(
    `INSERT INTO appointment_reschedule_events (id,student_number,cause,actor_user_id)
     VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3)`,
    [unrelatedEventId, OTHER_STUDENT_NUMBER, ADMIN_ID],
  );
  if (overrides.protectedResult) {
    await client.query(
      "INSERT INTO laboratory_results(appointment_id,result_status) VALUES ($1,'COMPLETED')",
      [generatedLaboratoryId],
    );
  }
  if (overrides.finalizedSubmission) {
    await client.query(
      "INSERT INTO student_result_submissions(appointment_id,status) VALUES ($1,'FINALIZED')",
      [generatedLaboratoryId],
    );
  }
  return {
    originalLaboratoryId,
    originalPhysicalId,
    generatedLaboratoryId,
    generatedPhysicalId,
    closureEventId,
    unrelatedEventId,
  };
}

async function withLegacySchema(
  callback: (client: PoolClient, quotedSchema: string) => Promise<void>,
) {
  const client = await pool.connect();
  const schemaName = `unified_calendar_${randomUUID().replaceAll("-", "_")}`;
  const quotedSchema = `"${schemaName}"`;
  try {
    await createLegacySchema(client, schemaName);
    await callback(client, quotedSchema);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    client.release();
  }
}

describe("014 unified clinic calendar migration", () => {
  it("restores attributable originals, removes closure lineage, and preserves unrelated history", async () => {
    await withLegacySchema(async (client) => {
      const fixture = await insertClosureLineage(client);
      await client.query(await migrationSql());

      const originals = await client.query<{ id: string; status: string; is_published: boolean }>(
        `SELECT id::text,status,is_published FROM appointments
          WHERE id IN ($1,$2) ORDER BY id`,
        [fixture.originalLaboratoryId, fixture.originalPhysicalId],
      );
      expect(originals.rows).toEqual([
        expect.objectContaining({ status: "PENDING", is_published: true }),
        expect.objectContaining({ status: "PENDING", is_published: true }),
      ]);
      await expect(client.query(
        "SELECT 1 FROM appointments WHERE id IN ($1,$2)",
        [fixture.generatedLaboratoryId, fixture.generatedPhysicalId],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(client.query(
        "SELECT 1 FROM appointment_reschedule_events WHERE id=$1",
        [fixture.closureEventId],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(client.query(
        "SELECT 1 FROM appointment_reschedule_events WHERE id=$1",
        [fixture.unrelatedEventId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query(
        "SELECT 1 FROM clinic_unavailable_dates WHERE reopened_at IS NULL",
      )).resolves.toMatchObject({ rowCount: 0 });
    });
  });

  it("cleans an attributable no-show replacement during the one-time reset", async () => {
    await withLegacySchema(async (client) => {
      const fixture = await insertClosureLineage(client, { generatedStatus: "NO_SHOW" });
      await client.query(await migrationSql());
      await expect(client.query(
        "SELECT status,is_published FROM appointments WHERE id=$1",
        [fixture.originalLaboratoryId],
      )).resolves.toMatchObject({ rows: [{ status: "PENDING", is_published: true }] });
      await expect(client.query(
        "SELECT 1 FROM appointments WHERE id=$1",
        [fixture.generatedLaboratoryId],
      )).resolves.toMatchObject({ rowCount: 0 });
    });
  });

  it.each([
    ["completed replacements", { generatedStatus: "COMPLETED" }],
    ["manually locked replacements", { manuallyLocked: true }],
    ["protected result records", { protectedResult: true }],
    ["finalized submissions", { finalizedSubmission: true }],
    ["ambiguous replacement lineage", { mismatchedLineage: true }],
  ])("aborts before cleanup for %s", async (_name, overrides) => {
    await withLegacySchema(async (client) => {
      const fixture = await insertClosureLineage(client, overrides);
      await expect(client.query(await migrationSql())).rejects.toThrow(/unified clinic calendar cleanup preflight/i);
      await expect(client.query(
        "SELECT status,is_published FROM appointments WHERE id=$1",
        [fixture.originalLaboratoryId],
      )).resolves.toMatchObject({ rows: [{ status: "RESCHEDULED", is_published: true }] });
      await expect(client.query(
        "SELECT 1 FROM appointments WHERE id=$1",
        [fixture.generatedLaboratoryId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query(
        "SELECT 1 FROM clinic_unavailable_dates",
      )).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
