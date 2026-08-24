// @vitest-environment node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "./pool";
import { cleanupTestFixtures, insertTestStudent } from "@/test/integration-fixtures";

const migrationPath = join(
  process.cwd(),
  "database/migrations/023_mandatory_student_email_verification_notifications.sql",
);
const studentPattern = "99-23%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-MIGRATION-023%", "TEST-MIGRATION-023%");
}

beforeAll(async () => {
  await cleanup();
  if (!existsSync(migrationPath)) {
    throw new Error(`Required migration 023 is missing or misnamed: ${migrationPath}`);
  }
  await pool.query(await readFile(migrationPath, "utf8"));
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("mandatory student email verification notifications migration", () => {
  it("adds the outbox lifecycle and notification context contract", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='email_outbox'
          AND column_name IN (
            'message_kind','notification_type','source_type','source_id',
            'portal_notification_id','schedule_fingerprint',
            'verification_body_encrypted','last_attempt_at','last_attempt_status'
          )
        ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "last_attempt_at",
      "last_attempt_status",
      "message_kind",
      "notification_type",
      "portal_notification_id",
      "schedule_fingerprint",
      "source_id",
      "source_type",
      "verification_body_encrypted",
    ]);

    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid='email_outbox'::regclass AND contype='c'`,
    );
    expect(constraints.rows.some((row) => row.definition.includes("'OBSOLETE'"))).toBe(true);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'students_active_verified_email_unique_idx',
            'email_outbox_actionable_failure_idx'
          )
        ORDER BY indexname`,
    );
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows.find((row) => row.indexname === "students_active_verified_email_unique_idx")?.indexdef)
      .toContain("lower(btrim((email)::text))");
    expect(indexes.rows.find((row) => row.indexname === "students_active_verified_email_unique_idx")?.indexdef)
      .toContain("((email_verified_at IS NOT NULL) AND (is_active = true))");
    expect(indexes.rows.find((row) => row.indexname === "email_outbox_actionable_failure_idx")?.indexdef)
      .toContain("PERMANENT_FAILURE");
  });

  it("lets only one concurrent active student claim a normalized verified email", async () => {
    for (const studentNumber of ["99-2301-01", "99-2302-02"]) {
      await insertTestStudent({ studentNumber, firstName: "Concurrent", lastName: "Owner", yearLevel: 3 });
    }
    const first = await pool.connect();
    const second = await pool.connect();
    let firstOpen = false;
    let secondOpen = false;
    try {
      await first.query("BEGIN");
      firstOpen = true;
      await second.query("BEGIN");
      secondOpen = true;
      await first.query(
        `UPDATE students SET email=' Shared@Example.Test ',email_verified_at=clock_timestamp()
          WHERE student_number='99-2301-01'`,
      );
      const secondClaim = second.query(
        `UPDATE students SET email='shared@example.test',email_verified_at=clock_timestamp()
          WHERE student_number='99-2302-02'`,
      );
      await first.query("COMMIT");
      firstOpen = false;
      await expect(secondClaim).rejects.toMatchObject({ code: "23505" });
      await second.query("ROLLBACK");
      secondOpen = false;
    } finally {
      if (firstOpen) await first.query("ROLLBACK");
      if (secondOpen) await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("rejects reactivation when another active student owns the normalized verified email", async () => {
    for (const studentNumber of ["99-2303-03", "99-2304-04"]) {
      await insertTestStudent({ studentNumber, firstName: "Reactivate", lastName: "Owner", yearLevel: 3 });
    }
    await pool.query(
      `UPDATE students
          SET email='reactivate@example.test',email_verified_at=clock_timestamp(),is_active=FALSE
        WHERE student_number='99-2303-03'`,
    );
    await pool.query(
      `UPDATE students
          SET email=' REACTIVATE@example.test ',email_verified_at=clock_timestamp()
        WHERE student_number='99-2304-04'`,
    );
    await expect(pool.query(
      "UPDATE students SET is_active=TRUE WHERE student_number='99-2303-03'",
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps schedule bodies plaintext and verification bodies encrypted", async () => {
    await insertTestStudent({
      studentNumber: "99-2305-05",
      firstName: "Body",
      lastName: "Boundary",
      yearLevel: 3,
    });
    await expect(pool.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,message_kind,verification_body_encrypted
       ) VALUES (
         '99-2305-05','body@example.test','Schedule','Plain schedule body','SCHEDULE','ciphertext'
       )`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,message_kind,verification_body_encrypted
       ) VALUES (
         '99-2305-05','body@example.test','Verify','Raw token URL','VERIFICATION','ciphertext'
       )`,
    )).rejects.toMatchObject({ code: "23514" });

    const general = await pool.query<{ message_kind: string }>(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body
       ) VALUES (
         '99-2305-05','body@example.test','General','Plain general body'
       ) RETURNING message_kind`,
    );
    expect(general.rows).toEqual([{ message_kind: "GENERAL" }]);
  });
});
