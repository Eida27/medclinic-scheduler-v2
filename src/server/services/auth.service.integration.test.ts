// @vitest-environment node
import { afterAll, afterEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { pool } from "@/server/db/pool";
import { authenticate, authorizeAuthenticatedStaff, authorizeSession } from "./auth.service";

const fixtureEmail = "restricted-auth@staff-security.test";
let fixtureId: string | undefined;

afterEach(async () => {
  if (!fixtureId) return;
  await pool.query("DELETE FROM users WHERE id=$1", [fixtureId]);
  fixtureId = undefined;
});

afterAll(async () => {
  await pool.end();
});

describe("authenticate", () => {
  it("accepts the seeded admin credentials", async () => {
    await expect(authenticate("admin@medclinic.local", "Admin123!")).resolves.toMatchObject({
      role: "ADMIN",
      email: "admin@medclinic.local",
      credentialVersion: 1,
      status: "ACTIVE",
    });
  });

  it("round-trips the seeded global coordinator credentials", async () => {
    await expect(authenticate("coordinator@medclinic.local", "Coordinator123!")).resolves.toMatchObject({
      fullName: "Schedule Coordinator",
      role: "COORDINATOR",
      email: "coordinator@medclinic.local",
      clinicId: null,
      clinicCode: null,
    });
  });

  it("rejects an incorrect password without exposing account details", async () => {
    await expect(authenticate("admin@medclinic.local", "wrong-password")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
  });

  it("authenticates a restricted account but denies ordinary authorization with ONBOARDING_REQUIRED", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (
         full_name,email,password_hash,role,email_verified_at,must_change_password,credential_version
       ) VALUES ('Restricted Staff',$1,$2,'COORDINATOR',NULL,TRUE,4) RETURNING id::text`,
      [fixtureEmail, await bcrypt.hash("Temporary123!", 4)],
    );
    fixtureId = inserted.rows[0].id;
    const session = await authenticate(fixtureEmail, "Temporary123!");
    expect(session).toMatchObject({
      credentialVersion: 4,
      status: "PENDING_VERIFICATION",
      onboardingRequired: true,
    });
    await expect(authorizeAuthenticatedStaff(session)).resolves.toMatchObject({
      userId: fixtureId,
      status: "PENDING_VERIFICATION",
    });
    await expect(authorizeSession(session)).rejects.toMatchObject({
      code: "ONBOARDING_REQUIRED",
      status: 403,
    });
  });

  it("rejects a stale credential version after a security mutation", async () => {
    const session = await authenticate("admin@medclinic.local", "Admin123!");
    await pool.query("UPDATE users SET credential_version=credential_version+1 WHERE id=$1", [session.userId]);
    await expect(authorizeAuthenticatedStaff(session)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
    await pool.query("UPDATE users SET credential_version=1 WHERE id=$1", [session.userId]);
  });

  it("rejects deleted accounts for both login and existing-session authorization", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (
         full_name,email,password_hash,role,email_verified_at,must_change_password
       ) VALUES ('Deleted Staff',$1,$2,'COORDINATOR',clock_timestamp(),FALSE) RETURNING id::text`,
      [fixtureEmail, await bcrypt.hash("Operational123!", 4)],
    );
    fixtureId = inserted.rows[0].id;
    const session = await authenticate(fixtureEmail, "Operational123!");
    await pool.query(
      `UPDATE users SET credential_version=credential_version+1,deleted_at=clock_timestamp(),
                        deleted_by=id,email=NULL,password_hash=NULL,email_verified_at=NULL,
                        must_change_password=FALSE WHERE id=$1`,
      [fixtureId],
    );
    await expect(authenticate(fixtureEmail, "Operational123!")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
    await expect(authorizeAuthenticatedStaff(session)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
  });
});
