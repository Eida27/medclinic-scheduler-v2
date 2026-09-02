// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pool } from "./pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/020_first_year_schedule_import_consolidation.sql",
);

afterAll(async () => {
  await pool.end();
});

describe("first-year schedule import consolidation migration", () => {
  it("adds compatible import metadata and multi-date First Year allocation persistence", async () => {
    const migration = await readFile(migrationPath, "utf8");
    await expect(pool.query(migration)).resolves.toBeDefined();

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name
         FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND (table_name,column_name) IN (
            ('schedule_import_groups','import_mode'),
            ('schedule_import_groups','first_year_laboratory_date'),
            ('ovpsa_first_year_batches','source_import_group_id'),
            ('ovpsa_first_year_membership_snapshots','source_row_number'),
            ('ovpsa_first_year_membership_snapshots','allocation_position'),
            ('ovpsa_first_year_membership_snapshots','assigned_pe_reservation_id')
          )
        ORDER BY table_name,column_name`,
    );

    expect(columns.rows).toHaveLength(6);
  });

  it("allows multiple PE dates while retaining one Laboratory reservation per revision", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const actorId = randomUUID();
      const collegeId = randomUUID();
      const programId = randomUUID();
      const studentNumber = `96-${Date.now().toString().slice(-4)}-01`;
      await client.query(
        `INSERT INTO users (id,full_name,email,password_hash,role)
         VALUES ($1,'Migration Actor',$2,'migration-hash','ADMIN')`,
        [actorId, `migration-${actorId}@example.test`],
      );
      await client.query(
        `INSERT INTO colleges (id,code,name) VALUES ($1,$2,$3)`,
        [collegeId, `M${actorId.slice(0, 8)}`, `Migration College ${actorId}`],
      );
      await client.query(
        `INSERT INTO programs (id,college_id,code,name) VALUES ($1,$2,$3,$4)`,
        [programId, collegeId, "MIG", `Migration Program ${actorId}`],
      );
      await client.query(
        `INSERT INTO students (
           student_number,first_name,middle_name,last_name,college_id,program_id,year_level,date_of_birth
         ) VALUES ($1,'Student','Middle','Migration',$2,$3,1,'2078-01-01')`,
        [studentNumber, collegeId, programId],
      );
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2096,'2097-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING`,
        [actorId],
      );
      const importGroup = await client.query<{ id: string }>(
        `INSERT INTO schedule_import_groups (
           import_name,source_filename,total_rows,created_by,student_category,
           academic_year_start,accepted_at,import_mode,first_year_laboratory_date
         ) VALUES ('First Year migration fixture','fixture.csv',1,$1,'REGULAR',2096,
                   clock_timestamp(),'FIRST_YEAR_OVPSA','2096-09-22')
         RETURNING id::text`,
        [actorId],
      );
      const snapshot = await client.query<{ id: string }>(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_id,college_name,
           program_id,program_code,program_name,year_level,source_import_group_id
         ) VALUES ($1,2096,$2,$3,$4,$5,$6,$7,1,$8)
         RETURNING id::text`,
        [
          studentNumber,
          "Migration, Student",
          collegeId,
          `Migration College ${actorId}`,
          programId,
          "MIG",
          `Migration Program ${actorId}`,
          importGroup.rows[0].id,
        ],
      );
      const batch = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batches (
           schedule_cycle_start,college_id,status,created_by,updated_by,source_import_group_id
         ) VALUES (2096,NULL,'DRAFT',$1,$1,$2)
         RETURNING id::text`,
        [actorId, importGroup.rows[0].id],
      );
      const revision = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batch_revisions (
           batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by
         ) VALUES ($1,1,'DRAFT','2096-09-22','2096-09-29',$2)
         RETURNING id::text`,
        [batch.rows[0].id, actorId],
      );
      const reservations = await client.query<{ id: string; schedule_type: string; reservation_date: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES
           ($1,$2,'LABORATORY','2096-09-22','ACTIVE',$3),
           ($1,$2,'PHYSICAL_EXAM','2096-09-29','ACTIVE',$3),
           ($1,$2,'PHYSICAL_EXAM','2096-09-30','ACTIVE',$3)
         RETURNING id::text,schedule_type,reservation_date::text`,
        [batch.rows[0].id, revision.rows[0].id, actorId],
      );
      expect(reservations.rows).toHaveLength(3);

      const peReservationId = reservations.rows.find(
        (reservation) => reservation.schedule_type === "PHYSICAL_EXAM"
          && reservation.reservation_date === "2096-09-29",
      )!.id;
      await expect(client.query(
        `INSERT INTO ovpsa_first_year_membership_snapshots (
           revision_id,batch_id,student_number,academic_snapshot_id,student_name,
           college_id,college_name,program_name,year_level,source_row_number,
           allocation_position,assigned_pe_reservation_id
         ) SELECT $1,$2,$3::varchar,$4,'Migration Student',student.college_id,
                  college.name,'Migration Program',1,2,1,$5
             FROM students student
             JOIN colleges college ON college.id=student.college_id
            WHERE student.student_number=$3`,
        [revision.rows[0].id, batch.rows[0].id, studentNumber, snapshot.rows[0].id, peReservationId],
      )).resolves.toBeDefined();

      await client.query("SAVEPOINT second_laboratory");
      await expect(client.query(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES ($1,$2,'LABORATORY','2096-09-23','ACTIVE',$3)`,
        [batch.rows[0].id, revision.rows[0].id, actorId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT second_laboratory");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
