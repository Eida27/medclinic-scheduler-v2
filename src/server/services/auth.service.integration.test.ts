// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { pool } from "@/server/db/pool";
import { authenticate, authorizeAuthenticatedStaff, authorizeSession } from "./auth.service";

const fixtureEmail = "restricted-auth@staff-security.test";
const unknownEmail = "unknown-auth@staff-security.test";
const normalizedEmail = "normalized-auth@staff-security.test";
const expiryEmail = "expiry-auth@staff-security.test";
const oversizedEmail = `${"a".repeat(308)}@example.test`;
const globalIpEmails = Array.from(
  { length: 26 },
  (_, index) => `global-ip-${index + 1}@staff-security.test`,
);

const ipAddresses = {
  seededAdmin: "192.0.2.101",
  seededCoordinator: "192.0.2.102",
  incorrectPassword: "192.0.2.103",
  restrictedAccount: "192.0.2.104",
  staleSession: "192.0.2.105",
  deletedAccount: "192.0.2.106",
  emailThreshold: "192.0.2.107",
  parityReal: "192.0.2.108",
  parityUnknown: "192.0.2.109",
  normalization: "192.0.2.110",
  globalThreshold: "192.0.2.111",
  successClearsEmail: "192.0.2.112",
  expiry: "192.0.2.113",
  concurrency: "192.0.2.114",
  oversizedEmail: "192.0.2.115",
} as const;

const throttleBucketKeys = [
  "admin@medclinic.local",
  "coordinator@medclinic.local",
  fixtureEmail,
  unknownEmail,
  normalizedEmail,
  expiryEmail,
  oversizedEmail,
  ...globalIpEmails,
  ...Object.values(ipAddresses),
];

let fixtureId: string | undefined;

type AuthenticationError = {
  code: string;
  status: number;
  details?: { retryAfterSeconds?: number };
};

async function cleanupThrottleFixtures() {
  await pool.query(
    "DELETE FROM staff_login_failures WHERE bucket_key=ANY($1::varchar[])",
    [throttleBucketKeys],
  );
}

async function authenticationError(
  email: string,
  password: string,
  ipAddress: string,
): Promise<AuthenticationError> {
  return authenticate(email, password, ipAddress).then(
    () => {
      throw new Error("Expected authentication to reject.");
    },
    (error: unknown) => error as AuthenticationError,
  );
}

beforeEach(cleanupThrottleFixtures);

afterEach(async () => {
  if (fixtureId) {
    await pool.query("DELETE FROM users WHERE id=$1", [fixtureId]);
    fixtureId = undefined;
  }
  await cleanupThrottleFixtures();
});

afterAll(async () => {
  try {
    await cleanupThrottleFixtures();
  } finally {
    await pool.end();
  }
});

describe("authenticate", () => {
  it("accepts the seeded admin credentials", async () => {
    await expect(
      authenticate("admin@medclinic.local", "Admin123!", ipAddresses.seededAdmin),
    ).resolves.toMatchObject({
      role: "ADMIN",
      email: "admin@medclinic.local",
      credentialVersion: 1,
      status: "ACTIVE",
    });
  });

  it("round-trips the seeded global coordinator credentials", async () => {
    await expect(
      authenticate(
        "coordinator@medclinic.local",
        "Coordinator123!",
        ipAddresses.seededCoordinator,
      ),
    ).resolves.toMatchObject({
      fullName: "Schedule Coordinator",
      role: "COORDINATOR",
      email: "coordinator@medclinic.local",
      clinicId: null,
      clinicCode: null,
    });
  });

  it("rejects an incorrect password without exposing account details", async () => {
    await expect(
      authenticate("admin@medclinic.local", "wrong-password", ipAddresses.incorrectPassword),
    ).rejects.toMatchObject({
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
    const session = await authenticate(
      fixtureEmail,
      "Temporary123!",
      ipAddresses.restrictedAccount,
    );
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
    const session = await authenticate(
      "admin@medclinic.local",
      "Admin123!",
      ipAddresses.staleSession,
    );
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
    const session = await authenticate(
      fixtureEmail,
      "Operational123!",
      ipAddresses.deletedAccount,
    );
    await pool.query(
      `UPDATE users SET credential_version=credential_version+1,deleted_at=clock_timestamp(),
                        deleted_by=id,email=NULL,password_hash=NULL,email_verified_at=NULL,
                        must_change_password=FALSE WHERE id=$1`,
      [fixtureId],
    );
    await expect(
      authenticate(fixtureEmail, "Operational123!", ipAddresses.deletedAccount),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
    await expect(authorizeAuthenticatedStaff(session)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
  });

  it("throttles the fifth failed attempt for an existing email and blocks a correct password", async () => {
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(
        authenticate("admin@medclinic.local", "wrong-password", ipAddresses.emailThreshold),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    }

    const fifthError = await authenticationError(
      "admin@medclinic.local",
      "wrong-password",
      ipAddresses.emailThreshold,
    );
    expect(fifthError).toMatchObject({ code: "STAFF_LOGIN_THROTTLED", status: 429 });
    expect(fifthError.details?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(fifthError.details?.retryAfterSeconds).toBeLessThanOrEqual(900);

    await expect(
      authenticate("admin@medclinic.local", "Admin123!", ipAddresses.emailThreshold),
    ).rejects.toMatchObject({ code: "STAFF_LOGIN_THROTTLED", status: 429 });
  });

  it("keeps unknown-email failure responses in parity with a real email", async () => {
    const realOutcomes: Array<Pick<AuthenticationError, "code" | "status">> = [];
    const unknownOutcomes: Array<Pick<AuthenticationError, "code" | "status">> = [];

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const realError = await authenticationError(
        "admin@medclinic.local",
        "wrong-password",
        ipAddresses.parityReal,
      );
      const unknownError = await authenticationError(
        unknownEmail,
        "wrong-password",
        ipAddresses.parityUnknown,
      );
      realOutcomes.push({ code: realError.code, status: realError.status });
      unknownOutcomes.push({ code: unknownError.code, status: unknownError.status });
    }

    expect(unknownOutcomes).toEqual(realOutcomes);
    expect(unknownOutcomes).toEqual([
      { code: "INVALID_CREDENTIALS", status: 401 },
      { code: "INVALID_CREDENTIALS", status: 401 },
      { code: "INVALID_CREDENTIALS", status: 401 },
      { code: "INVALID_CREDENTIALS", status: 401 },
      { code: "STAFF_LOGIN_THROTTLED", status: 429 },
    ]);
  });

  it("normalizes email casing and whitespace into one failure bucket", async () => {
    const variants = [
      " Normalized-Auth@Staff-Security.Test ",
      "NORMALIZED-AUTH@STAFF-SECURITY.TEST",
      normalizedEmail,
      "normalized-AUTH@staff-security.test",
    ];
    for (const variant of variants) {
      await expect(
        authenticate(variant, "wrong-password", ipAddresses.normalization),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    }
    await expect(
      authenticate("NORMALIZED-auth@STAFF-security.TEST", "wrong-password", ipAddresses.normalization),
    ).rejects.toMatchObject({ code: "STAFF_LOGIN_THROTTLED", status: 429 });
  });

  it("throttles the twenty-fifth failure across distinct emails sharing one IP", async () => {
    for (let attempt = 1; attempt < 25; attempt += 1) {
      await expect(
        authenticate(globalIpEmails[attempt - 1], "wrong-password", ipAddresses.globalThreshold),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    }
    await expect(
      authenticate(globalIpEmails[24], "wrong-password", ipAddresses.globalThreshold),
    ).rejects.toMatchObject({ code: "STAFF_LOGIN_THROTTLED", status: 429 });
    await expect(
      authenticate(globalIpEmails[25], "wrong-password", ipAddresses.globalThreshold),
    ).rejects.toMatchObject({ code: "STAFF_LOGIN_THROTTLED", status: 429 });
  }, 30_000);

  it("clears only the email failure bucket after a successful login", async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        authenticate("admin@medclinic.local", "wrong-password", ipAddresses.successClearsEmail),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    }

    await expect(
      authenticate("admin@medclinic.local", "Admin123!", ipAddresses.successClearsEmail),
    ).resolves.toMatchObject({ email: "admin@medclinic.local" });

    const remaining = await pool.query<{ scope: "EMAIL" | "IP"; count: number }>(
      `SELECT scope,COUNT(*)::integer AS count
         FROM staff_login_failures
        WHERE (scope='EMAIL' AND bucket_key='admin@medclinic.local')
           OR (scope='IP' AND bucket_key=$1)
        GROUP BY scope
        ORDER BY scope`,
      [ipAddresses.successClearsEmail],
    );
    expect(remaining.rows).toEqual([{ scope: "IP", count: 3 }]);
  });

  it("allows authentication after the fifteen-minute failure window expires", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (
         full_name,email,password_hash,role,email_verified_at,must_change_password
       ) VALUES ('Expiry Staff',$1,$2,'COORDINATOR',clock_timestamp(),FALSE) RETURNING id::text`,
      [expiryEmail, await bcrypt.hash("Operational123!", 4)],
    );
    fixtureId = inserted.rows[0].id;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const error = await authenticationError(
        expiryEmail,
        "wrong-password",
        ipAddresses.expiry,
      );
      expect(error).toMatchObject({
        code: attempt < 5 ? "INVALID_CREDENTIALS" : "STAFF_LOGIN_THROTTLED",
        status: attempt < 5 ? 401 : 429,
      });
    }

    await pool.query(
      `UPDATE staff_login_failures
          SET occurred_at=clock_timestamp()-INTERVAL '15 minutes 1 second'
        WHERE (scope='EMAIL' AND bucket_key=$1)
           OR (scope='IP' AND bucket_key=$2)`,
      [expiryEmail, ipAddresses.expiry],
    );
    await expect(
      authenticate(expiryEmail, "Operational123!", ipAddresses.expiry),
    ).resolves.toMatchObject({ email: expiryEmail });
  });

  it("serializes a concurrent burst at exactly five stored failures per bucket", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        authenticate("admin@medclinic.local", "wrong-password", ipAddresses.concurrency),
      ),
    );
    const codes = outcomes.map((outcome) =>
      outcome.status === "rejected"
        ? (outcome.reason as AuthenticationError).code
        : "UNEXPECTED_SUCCESS",
    );
    expect(codes.filter((code) => code === "INVALID_CREDENTIALS")).toHaveLength(4);
    expect(codes.filter((code) => code === "STAFF_LOGIN_THROTTLED")).toHaveLength(6);

    const stored = await pool.query<{ scope: "EMAIL" | "IP"; count: number }>(
      `SELECT scope,COUNT(*)::integer AS count
         FROM staff_login_failures
        WHERE (scope='EMAIL' AND bucket_key='admin@medclinic.local')
           OR (scope='IP' AND bucket_key=$1)
        GROUP BY scope
        ORDER BY scope`,
      [ipAddresses.concurrency],
    );
    expect(stored.rows).toEqual([
      { scope: "EMAIL", count: 5 },
      { scope: "IP", count: 5 },
    ]);
  });

  it("rejects an empty IP address before authentication", async () => {
    await expect(authenticate("admin@medclinic.local", "Admin123!", "   ")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 422,
    });
  });

  it("rejects an email longer than 254 characters before bcrypt or failure persistence", async () => {
    expect(oversizedEmail).toHaveLength(321);
    const compare = vi.spyOn(bcrypt, "compare");

    try {
      const error = await authenticationError(
        oversizedEmail,
        "wrong-password",
        ipAddresses.oversizedEmail,
      );

      const failures = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
           FROM staff_login_failures
          WHERE bucket_key=ANY($1::varchar[])`,
        [[oversizedEmail, ipAddresses.oversizedEmail]],
      );
      expect(compare).not.toHaveBeenCalled();
      expect(failures.rows[0].count).toBe(0);
      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        status: 422,
      });
    } finally {
      compare.mockRestore();
    }
  });
});
