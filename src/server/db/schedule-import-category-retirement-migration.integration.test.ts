// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/022_schedule_import_year_category_validation.sql",
);

afterAll(async () => {
  await pool.end();
});

describe("schedule import category retirement migration", () => {
  it("restricts persisted import and appointment categories to the active set", async () => {
    const migration = await readFile(migrationPath, "utf8");
    await expect(pool.query(migration)).resolves.toBeDefined();

    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname,pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname IN (
          'schedule_import_groups_student_category_check',
          'appointments_scheduling_category_check'
        )
          AND connamespace=current_schema()::regnamespace
        ORDER BY conname`,
    );
    expect(constraints.rows).toHaveLength(2);
    for (const constraint of constraints.rows) {
      expect(constraint.definition).toContain("REGULAR");
      expect(constraint.definition).toContain("OJT");
      expect(constraint.definition).toContain("TOUR");
      expect(constraint.definition).not.toContain("SPECIALIZED");
    }
  });

  it("rejects a retired category at the database boundary", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await expect(client.query(
        `INSERT INTO schedule_import_groups (
           import_name,source_filename,total_rows,created_by,student_category,
           academic_year_start,preferred_month,accepted_at
         ) SELECT 'Retired category fixture','retired-category.csv',1,id,'SPECIALIZED',
                  2096,9,clock_timestamp()
             FROM users WHERE role='ADMIN' ORDER BY created_at LIMIT 1`,
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
