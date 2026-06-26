// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "./pool";

afterAll(async () => {
  await pool.end();
});

describe("database constraints", () => {
  it("seeds the two clinic schedulers and scopes capacity settings to clinics", async () => {
    const clinics = await pool.query<{ code: string; name: string }>(
      "SELECT code, name FROM clinics ORDER BY code",
    );
    expect(clinics.rows).toEqual([
      { code: "CPU_CLINIC", name: "CPU Clinic" },
      { code: "KABALAKA_CLINIC", name: "KABALAKA Clinic" },
    ]);

    const capacity = await pool.query<{ code: string; schedule_type: string; safe_daily_capacity: number; max_daily_capacity: number }>(
      `SELECT c.code, s.schedule_type, s.safe_daily_capacity, s.max_daily_capacity
         FROM clinic_capacity_settings s
         JOIN clinics c ON c.id = s.clinic_id
        ORDER BY c.code, s.schedule_type`,
    );
    expect(capacity.rows).toEqual([
      { code: "CPU_CLINIC", schedule_type: "PHYSICAL_EXAM", safe_daily_capacity: 120, max_daily_capacity: 150 },
      { code: "KABALAKA_CLINIC", schedule_type: "LABORATORY", safe_daily_capacity: 120, max_daily_capacity: 150 },
    ]);
  });

  it("rejects persisted BOTH coordinator schedule items", async () => {
    await expect(
      pool.query(
        `INSERT INTO coordinator_schedule_items (
          batch_id, student_number, schedule_type, priority_group_id, clinic_id, target_date
        ) VALUES ($1, $2, 'BOTH', $3, $4, DATE '2026-09-01')`,
        [
          "50000000-0000-4000-8000-000000000120",
          "DEMO-0001",
          "30000000-0000-4000-8000-000000000004",
          "60000000-0000-4000-8000-000000000001",
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

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
