// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { pool } from "@/server/db/pool";
import { ensureTestStaffFixtures } from "@/test/staff-fixtures";
import { bootstrapFirstAdministrator } from "./staff-bootstrap.service";

const fixtureDomain = "@staff-bootstrap.test";

async function cleanup() {
  const users = await pool.query<{ id: string }>("SELECT id FROM users WHERE email LIKE $1 OR full_name LIKE 'TEST Bootstrap%'", [`%${fixtureDomain}`]);
  const ids = users.rows.map((row) => row.id);
  if (ids.length) {
    await pool.query("DELETE FROM email_outbox WHERE source_id IN (SELECT id::text FROM staff_email_verifications WHERE user_id=ANY($1::uuid[]))", [ids]);
    await pool.query("DELETE FROM staff_email_verifications WHERE user_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM audit_logs WHERE entity_type='user' AND entity_id=ANY($1::text[])", [ids]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
  }
  await ensureTestStaffFixtures();
}

beforeEach(async () => {
  await cleanup();
  await pool.query("UPDATE users SET role='COORDINATOR',clinic_id=NULL WHERE role='ADMIN' AND deleted_at IS NULL");
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("first Administrator bootstrap", () => {
  it("creates one restricted Administrator, verification request, encrypted mail, and safe audit", async () => {
    const result = await bootstrapFirstAdministrator({
      fullName: "TEST Bootstrap Admin",
      email: `first${fixtureDomain}`,
      temporaryPassword: "BootstrapPass123!",
    });

    expect(result).toMatchObject({
      fullName: "TEST Bootstrap Admin",
      email: `first${fixtureDomain}`,
      role: "ADMIN",
      status: "PENDING_VERIFICATION",
    });
    const stored = await pool.query<{
      emailVerifiedAt: Date | null;
      mustChangePassword: boolean;
      credentialVersion: number;
      passwordHash: string;
    }>(
      `SELECT email_verified_at AS "emailVerifiedAt",must_change_password AS "mustChangePassword",
              credential_version AS "credentialVersion",password_hash AS "passwordHash"
         FROM users WHERE id=$1`,
      [result.id],
    );
    expect(stored.rows[0]).toMatchObject({
      emailVerifiedAt: null,
      mustChangePassword: true,
      credentialVersion: 1,
    });
    expect(await bcrypt.compare("BootstrapPass123!", stored.rows[0].passwordHash)).toBe(true);

    const delivery = await pool.query<{ message_kind: string; source_type: string; encrypted: boolean }>(
      `SELECT message_kind,source_type,verification_body_encrypted IS NOT NULL AS encrypted
         FROM email_outbox WHERE source_id IN (
           SELECT id::text FROM staff_email_verifications WHERE user_id=$1
         )`,
      [result.id],
    );
    expect(delivery.rows).toEqual([{
      message_kind: "STAFF_SECURITY",
      source_type: "STAFF_EMAIL_VERIFICATION",
      encrypted: true,
    }]);

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE entity_type='user' AND entity_id=$1",
      [result.id],
    );
    expect(audit.rows.map((row) => row.action)).toContain("STAFF_BOOTSTRAP_ADMIN_CREATED");
    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain("BootstrapPass123!");
    expect(serialized).not.toContain(`first${fixtureDomain}`);
    expect(serialized).not.toMatch(/token|passwordHash/i);
  });

  it("refuses when a non-deleted Administrator already exists", async () => {
    await bootstrapFirstAdministrator({
      fullName: "TEST Bootstrap Existing",
      email: `existing${fixtureDomain}`,
      temporaryPassword: "BootstrapPass123!",
    });
    await expect(bootstrapFirstAdministrator({
      fullName: "TEST Bootstrap Refused",
      email: `refused${fixtureDomain}`,
      temporaryPassword: "BootstrapPass456!",
    })).rejects.toMatchObject({ code: "STAFF_ADMIN_EXISTS", status: 409 });
  });

  it("serializes concurrent attempts so exactly one Administrator is created", async () => {
    const attempts = await Promise.allSettled([
      bootstrapFirstAdministrator({
        fullName: "TEST Bootstrap Concurrent A",
        email: `concurrent-a${fixtureDomain}`,
        temporaryPassword: "BootstrapPass123!",
      }),
      bootstrapFirstAdministrator({
        fullName: "TEST Bootstrap Concurrent B",
        email: `concurrent-b${fixtureDomain}`,
        temporaryPassword: "BootstrapPass456!",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const count = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND deleted_at IS NULL",
    );
    expect(count.rows[0].count).toBe(1);
  });
});
