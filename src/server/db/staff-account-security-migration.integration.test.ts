// @vitest-environment node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "./pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/024_staff_account_security_onboarding_deletion.sql",
);
const fixtureEmailPattern = "%@staff-security-migration.test";

async function cleanup() {
  const users = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE full_name LIKE 'TEST Migration 024%' OR email LIKE $1",
    [fixtureEmailPattern],
  );
  const userIds = users.rows.map((row) => row.id);
  if (userIds.length === 0) return;
  await pool.query("DELETE FROM email_outbox WHERE source_id = ANY($1::text[])", [userIds]);
  await pool.query("DELETE FROM staff_password_resets WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM staff_email_verifications WHERE user_id = ANY($1::uuid[])", [userIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
}

beforeAll(async () => {
  if (!existsSync(migrationPath)) {
    throw new Error(`Required migration 024 is missing or misnamed: ${migrationPath}`);
  }
  await pool.query(await readFile(migrationPath, "utf8"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("staff account security onboarding and deletion migration", () => {
  it("adds credential lifecycle columns, token tables, and supporting indexes", async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string; character_maximum_length: number | null }>(
      `SELECT column_name,is_nullable,character_maximum_length
         FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='users'
          AND column_name IN (
            'email','password_hash','email_verified_at','must_change_password',
            'credential_version','deleted_at','deleted_by'
          )
        ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "credential_version",
      "deleted_at",
      "deleted_by",
      "email",
      "email_verified_at",
      "must_change_password",
      "password_hash",
    ]);
    expect(columns.rows.find((row) => row.column_name === "email")).toMatchObject({
      is_nullable: "YES",
      character_maximum_length: 254,
    });
    expect(columns.rows.find((row) => row.column_name === "password_hash")?.is_nullable).toBe("YES");

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema()
          AND table_name IN ('staff_email_verifications','staff_password_resets')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "staff_email_verifications",
      "staff_password_resets",
    ]);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'users_active_email_unique_idx',
            'staff_email_verifications_request_throttle_idx',
            'staff_password_resets_request_throttle_idx'
          )
        ORDER BY indexname`,
    );
    expect(indexes.rows).toHaveLength(3);
    expect(indexes.rows.find((row) => row.indexname === "users_active_email_unique_idx")?.indexdef)
      .toContain("WHERE (deleted_at IS NULL)");
  });

  it("requires complete credentials for active users and credential-free tombstones", async () => {
    await expect(pool.query(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 Missing Password','missing-password@staff-security-migration.test',NULL,'ADMIN')`,
    )).rejects.toMatchObject({ code: "23514" });

    const active = await pool.query<{ id: string }>(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 Active','active@staff-security-migration.test','hash','ADMIN')
       RETURNING id`,
    );
    const id = active.rows[0].id;
    await expect(pool.query(
      `UPDATE users
          SET deleted_at=clock_timestamp(),deleted_by=$1,email=NULL,password_hash=NULL,
              email_verified_at=NULL,must_change_password=FALSE
        WHERE id=$1`,
      [id],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("UPDATE users SET email='revived@staff-security-migration.test' WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("allows email reuse after deletion but rejects normalized duplicates among active users", async () => {
    const first = await pool.query<{ id: string }>(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 First','reuse@staff-security-migration.test','hash','ADMIN')
       RETURNING id`,
    );
    await expect(pool.query(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 Duplicate','reuse@staff-security-migration.test','hash','ADMIN')`,
    )).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `UPDATE users
          SET deleted_at=clock_timestamp(),deleted_by=$1,email=NULL,password_hash=NULL,
              email_verified_at=NULL,must_change_password=FALSE
        WHERE id=$1`,
      [first.rows[0].id],
    );
    await expect(pool.query(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 Reused','reuse@staff-security-migration.test','hash','ADMIN')`,
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("adds the staff security encrypted outbox classification", async () => {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (full_name,email,password_hash,role)
       VALUES ('TEST Migration 024 Outbox','outbox@staff-security-migration.test','hash','ADMIN')
       RETURNING id`,
    );
    await expect(pool.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,message_kind,source_type,source_id,
         verification_body_encrypted
       ) VALUES (
         NULL,'outbox@staff-security-migration.test','Verify your staff email',
         'Staff security email content is encrypted.','STAFF_SECURITY',
         'STAFF_EMAIL_VERIFICATION',$1,'ciphertext'
       )`,
      [user.rows[0].id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
