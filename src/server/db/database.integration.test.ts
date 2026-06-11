// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "./pool";

afterAll(async () => {
  await pool.end();
});

describe("database constraints", () => {
  it("contains the deterministic demo fixtures", async () => {
    const students = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM students");
    const batches = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM schedule_batches");

    expect(Number(students.rows[0].count)).toBeGreaterThanOrEqual(180);
    expect(Number(batches.rows[0].count)).toBeGreaterThanOrEqual(4);
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
