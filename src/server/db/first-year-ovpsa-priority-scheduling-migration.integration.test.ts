// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pool } from "./pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/019_first_year_ovpsa_priority_scheduling.sql",
);

afterAll(async () => {
  await pool.end();
});

describe("first-year OVPSA priority scheduling migration", () => {
  it("installs the additive schema and all appointment foreign-key indexes", async () => {
    const migration = await readFile(migrationPath, "utf8");
    await expect(pool.query(migration)).resolves.toBeDefined();

    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'appointments_ovpsa_batch_idx',
            'appointments_ovpsa_revision_idx',
            'appointments_ovpsa_service_reservation_idx',
            'appointment_reschedule_events_ovpsa_batch_idx',
            'appointment_reschedule_events_ovpsa_reservation_idx'
          )
        ORDER BY indexname`,
    );

    expect(indexes.rows).toHaveLength(5);
  });

  it("enforces active reservation, membership, and revision uniqueness", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const fixture = await client.query<{
        actor_id: string;
        college_id: string;
        program_id: string;
      }>(
        `SELECT user_row.id::text AS actor_id,
                program.college_id::text,
                program.id::text AS program_id
           FROM users user_row
           CROSS JOIN LATERAL (
             SELECT id,college_id FROM programs ORDER BY id LIMIT 1
           ) program
          ORDER BY user_row.id
          LIMIT 1`,
      );
      const { actor_id: actorId, college_id: collegeId, program_id: programId } = fixture.rows[0];
      const studentNumber = "FY-MIG-2097";
      await client.query(
        `INSERT INTO students (
           student_number,first_name,last_name,college_id,program_id,year_level
         ) VALUES ($1,'Migration','Fixture',$2,$3,1)`,
        [studentNumber, collegeId, programId],
      );
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2097,'2098-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorId],
      );
      const batches = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batches (
           schedule_cycle_start,college_id,status,created_by,updated_by
         ) VALUES
           (2097,$1,'DRAFT',$2,$2),
           (2097,$1,'DRAFT',$2,$2)
         RETURNING id::text`,
        [collegeId, actorId],
      );
      const batchIds = batches.rows.map((row) => row.id);
      const revisions = await client.query<{ id: string; batch_id: string }>(
        `INSERT INTO ovpsa_first_year_batch_revisions (
           batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by,
           validation_snapshot,validated_by,validated_at,published_by,published_at
         ) VALUES
           ($1,1,'PUBLISHED','2097-09-06','2097-09-13',$3,'{}',$3,clock_timestamp(),$3,clock_timestamp()),
           ($2,1,'PUBLISHED','2097-09-07','2097-09-14',$3,'{}',$3,clock_timestamp(),$3,clock_timestamp())
         RETURNING id::text,batch_id::text`,
        [batchIds[0], batchIds[1], actorId],
      );
      const revisionByBatch = new Map(revisions.rows.map((row) => [row.batch_id, row.id]));
      await client.query(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES ($1,$2,'LABORATORY','2097-09-06','ACTIVE',$3)`,
        [batchIds[0], revisionByBatch.get(batchIds[0]), actorId],
      );
      await client.query("SAVEPOINT duplicate_reservation");
      await expect(client.query(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES ($1,$2,'LABORATORY','2097-09-06','ACTIVE',$3)`,
        [batchIds[1], revisionByBatch.get(batchIds[1]), actorId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_reservation");

      await client.query(
        `INSERT INTO ovpsa_first_year_active_memberships (
           batch_id,revision_id,student_number,schedule_cycle_start
         ) VALUES ($1,$2,$3,2097)`,
        [batchIds[0], revisionByBatch.get(batchIds[0]), studentNumber],
      );
      await client.query("SAVEPOINT duplicate_membership");
      await expect(client.query(
        `INSERT INTO ovpsa_first_year_active_memberships (
           batch_id,revision_id,student_number,schedule_cycle_start
         ) VALUES ($1,$2,$3,2097)`,
        [batchIds[1], revisionByBatch.get(batchIds[1]), studentNumber],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_membership");

      await client.query("SAVEPOINT duplicate_current_revision");
      await expect(client.query(
        `INSERT INTO ovpsa_first_year_batch_revisions (
           batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by,
           validation_snapshot,validated_by,validated_at,published_by,published_at
         ) VALUES ($1,2,'PUBLISHED','2097-09-08','2097-09-15',$2,
                   '{}',$2,clock_timestamp(),$2,clock_timestamp())`,
        [batchIds[0], actorId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_current_revision");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps published revision fields and membership snapshots immutable", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("ovpsa_first_year_revision_published_fields_immutable");
    expect(migration).toContain("ovpsa_first_year_membership_snapshots_immutable");
    expect(migration).toContain("OVPSA_PUBLICATION");
    const appointmentStatus = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid='appointments'::regclass
          AND conname='appointments_status_check'`,
    );
    expect(appointmentStatus.rows[0].definition).toContain("AWAITING_RESCHEDULE");
  });
});
