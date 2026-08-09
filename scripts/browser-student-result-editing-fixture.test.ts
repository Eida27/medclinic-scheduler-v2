// @vitest-environment node
import { access, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  STUDENT_RESULT_EDITING_FIXTURE,
  assertMatchingStudentResultEditingDatabaseIdentity,
  assertSafeStudentResultEditingAcceptanceDatabase,
  assertStudentResultEditingStorageTarget,
  assertZeroStudentResultEditingResidue,
  cleanupStudentResultEditingFixture,
  getStudentResultEditingFixtureStatus,
  normalizeStudentResultEditingDatabaseIdentity,
  prepareStudentResultEditingFixture,
} from "./browser-student-result-editing-fixture";

const STATE_DIRECTORY = resolve(".data/browser-student-result-editing");
const STATE_FILE = resolve(STATE_DIRECTORY, "state.json");
const STORAGE_ROOT = resolve(process.env.RESULT_UPLOAD_ROOT ?? ".data/private-result-uploads");
const SENTINEL_AUDIT_ID = "be180000-0000-4000-8000-000000000901";
const SENTINEL_STORAGE_KEY = "browser-student-result-editing-unrelated/sentinel.pdf";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("student result editing Browser acceptance fixture guards", () => {
  const loopback = "postgresql://fixture:secret-password@localhost/result_editing";

  it.each(["prepare", "cleanup"] as const)(
    "requires the exact exclusive flag for the %s mutation",
    (mode) => {
      expect(() => assertSafeStudentResultEditingAcceptanceDatabase(loopback, undefined, mode))
        .toThrow("STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
      expect(() => assertSafeStudentResultEditingAcceptanceDatabase(loopback, "true", mode))
        .toThrow("STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
    },
  );

  it.each(["prepare", "cleanup"] as const)(
    "rejects a non-loopback database for the %s mutation without leaking credentials",
    (mode) => {
      let thrown: unknown;
      try {
        assertSafeStudentResultEditingAcceptanceDatabase(
          "postgresql://fixture:secret-password@db.example.test/result_editing",
          "1",
          mode,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/loopback/i);
      expect(String(thrown)).not.toContain("secret-password");
    },
  );

  it("allows read-only status without the exclusive flag but still requires loopback", () => {
    expect(assertSafeStudentResultEditingAcceptanceDatabase(loopback, undefined, "status"))
      .toEqual({ scheme: "postgresql", host: "localhost", port: "5432", database: "result_editing" });
    expect(() => assertSafeStudentResultEditingAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.test/result_editing",
      undefined,
      "status",
    )).toThrow(/loopback/i);
  });

  it.each([
    "postgresql://fixture:secret@localhost/result_editing?host=remote.example",
    "postgresql://fixture:secret@localhost/result_editing?port=6432",
  ])("rejects unsafe destination overrides in %s", (databaseUrl) => {
    expect(() => assertSafeStudentResultEditingAcceptanceDatabase(databaseUrl, "1", "prepare"))
      .toThrow(/host or port query/i);
  });

  it("normalizes credential-free database identity and refuses identity drift", () => {
    expect(normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@LOCALHOST:5544/result%5Fediting?sslmode=disable",
    )).toEqual({ scheme: "postgresql", host: "localhost", port: "5544", database: "result_editing" });
    const prepared = normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@localhost/result_editing_a",
    );
    const current = normalizeStudentResultEditingDatabaseIdentity(
      "postgresql://fixture:secret@localhost/result_editing_b",
    );
    expect(() => assertMatchingStudentResultEditingDatabaseIdentity(current, prepared))
      .toThrow(/does not match/i);
  });

  it("confines private storage targets to the configured root", () => {
    expect(assertStudentResultEditingStorageTarget(STORAGE_ROOT, "submission/file.pdf"))
      .toBe(resolve(STORAGE_ROOT, "submission/file.pdf"));
    expect(() => assertStudentResultEditingStorageTarget(STORAGE_ROOT, "../outside.pdf"))
      .toThrow(/storage key/i);
    expect(() => assertStudentResultEditingStorageTarget(STORAGE_ROOT, resolve("outside.pdf")))
      .toThrow(/storage key/i);
  });

  it("requires every scoped database, storage, chooser, and state count to be zero", () => {
    const zero = {
      students: 0,
      appointments: 0,
      submissions: 0,
      files: 0,
      legacyExamResults: 0,
      legacyLaboratoryResults: 0,
      appointmentStatusLogs: 0,
      storageCleanupIntents: 0,
      notifications: 0,
      outbox: 0,
      auditLogs: 0,
      loginAttempts: 0,
      emailVerifications: 0,
      storageObjects: 0,
      chooserArtifacts: 0,
      stateFiles: 0,
    };
    expect(assertZeroStudentResultEditingResidue(zero)).toBe(zero);
    expect(() => assertZeroStudentResultEditingResidue({ ...zero, storageCleanupIntents: 1 }))
      .toThrow(/residue remains/i);
  });
});

const exclusive = process.env.STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE === "1";
describe.runIf(exclusive)("student result editing Browser acceptance fixture lifecycle", () => {
  let pool: Pool;
  let identity: ReturnType<typeof assertSafeStudentResultEditingAcceptanceDatabase>;

  async function cleanup() {
    return cleanupStudentResultEditingFixture(pool, identity);
  }

  beforeAll(async () => {
    identity = assertSafeStudentResultEditingAcceptanceDatabase(
      process.env.DATABASE_URL,
      process.env.STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE,
      "cleanup",
    );
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await pool.query("DELETE FROM audit_logs WHERE id=$1", [SENTINEL_AUDIT_ID]);
    await rm(assertStudentResultEditingStorageTarget(STORAGE_ROOT, SENTINEL_STORAGE_KEY), { force: true });
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [SENTINEL_AUDIT_ID]);
      await rm(assertStudentResultEditingStorageTarget(STORAGE_ROOT, SENTINEL_STORAGE_KEY), { force: true });
      await pool.end();
    }
  });

  it("refuses and preserves an unrelated audit that collides with a reserved identifier", async () => {
    await pool.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'UNRELATED_RESERVED_COLLISION','unrelated',$3,'{}'::jsonb)`,
      [
        SENTINEL_AUDIT_ID,
        STUDENT_RESULT_EDITING_FIXTURE.adminUserId,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.laboratory,
      ],
    );
    try {
      await expect(prepareStudentResultEditingFixture(pool, identity)).rejects.toThrow(/reserved/i);
      expect((await pool.query("SELECT action FROM audit_logs WHERE id=$1", [SENTINEL_AUDIT_ID])).rows)
        .toEqual([{ action: "UNRELATED_RESERVED_COLLISION" }]);
      expect(await exists(STATE_FILE)).toBe(false);
    } finally {
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [SENTINEL_AUDIT_ID]);
    }
  });

  it("refuses and preserves an unowned file in the reserved state directory", async () => {
    const unrelatedPath = resolve(STATE_DIRECTORY, "unrelated.txt");
    await mkdir(STATE_DIRECTORY, { recursive: true });
    await writeFile(unrelatedPath, "unrelated", "utf8");
    try {
      await expect(prepareStudentResultEditingFixture(pool, identity)).rejects.toThrow(/reserved/i);
      expect(await readFile(unrelatedPath, "utf8")).toBe("unrelated");
      expect(await exists(STATE_FILE)).toBe(false);
    } finally {
      await rm(unrelatedPath, { force: true });
      await rmdir(STATE_DIRECTORY).catch(() => undefined);
    }
  });

  it("resumes a partial prepare without duplicating database rows", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const state = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
      phase: string;
      manifest: {
        chooserArtifacts: Record<string, string>;
        owned: { storageKeys: string[] };
      };
    };
    state.phase = "DATABASE_PREPARED";
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await Promise.all([
      ...state.manifest.owned.storageKeys.map((key) => rm(
        assertStudentResultEditingStorageTarget(STORAGE_ROOT, key),
        { force: true },
      )),
      ...Object.values(state.manifest.chooserArtifacts).map((path) => rm(path, { force: true })),
    ]);

    await prepareStudentResultEditingFixture(pool, identity);
    await prepareStudentResultEditingFixture(pool, identity);
    const status = await getStudentResultEditingFixtureStatus(pool, identity);

    expect(status).toMatchObject({
      phase: "PREPARED",
      residue: {
        students: 1,
        appointments: 2,
        submissions: 2,
        files: 2,
        storageObjects: 2,
        chooserArtifacts: 4,
        stateFiles: 1,
      },
    });
    expect(JSON.stringify(status)).not.toContain("secret-password");
    expect(JSON.stringify(status)).not.toContain(STUDENT_RESULT_EDITING_FIXTURE.login.admin.password);
    expect(JSON.stringify(status)).not.toContain(STUDENT_RESULT_EDITING_FIXTURE.login.student.dateOfBirth);
    expect(JSON.stringify(status)).not.toContain(STUDENT_RESULT_EDITING_FIXTURE.login.student.middleName);
    expect((await pool.query<{ fresh: boolean }>(
      `SELECT last_activity_at > NOW() - INTERVAL '5 minutes' AS fresh
         FROM student_result_submissions
        WHERE id=ANY($1::uuid[])
        ORDER BY id`,
      [Object.values(STUDENT_RESULT_EDITING_FIXTURE.submissionIds)],
    )).rows).toEqual([{ fresh: true }, { fresh: true }]);
  });

  it("reports partial state without recreating missing rows or files", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const missingStorage = assertStudentResultEditingStorageTarget(
      STORAGE_ROOT,
      STUDENT_RESULT_EDITING_FIXTURE.initialStorageKeys.laboratory,
    );
    const missingArtifact = STUDENT_RESULT_EDITING_FIXTURE.chooserArtifacts.png;
    await pool.query("DELETE FROM student_result_files WHERE id=$1", [
      STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.laboratory,
    ]);
    await rm(missingStorage, { force: true });
    await rm(missingArtifact, { force: true });

    const status = await getStudentResultEditingFixtureStatus(pool, identity);

    expect(status).toMatchObject({
      phase: "PREPARED",
      residue: { submissions: 2, files: 1, storageObjects: 1, chooserArtifacts: 3, stateFiles: 1 },
    });
    expect(await exists(missingStorage)).toBe(false);
    expect(await exists(missingArtifact)).toBe(false);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM student_result_files WHERE id=$1", [
      STUDENT_RESULT_EDITING_FIXTURE.initialFileIds.laboratory,
    ])).rows[0].count).toBe(0);
  });

  it("resumes cleanup after a simulated storage-delete failure", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    let failed = false;

    await expect(cleanupStudentResultEditingFixture(pool, identity, {
      removeStorageObject: async (target) => {
        if (!failed) {
          failed = true;
          throw new Error("simulated storage delete failure");
        }
        await rm(target, { force: true });
      },
    })).rejects.toThrow("simulated storage delete failure");

    const partial = await getStudentResultEditingFixtureStatus(pool, identity);
    expect(partial).toMatchObject({
      phase: "DATABASE_DELETED",
      residue: {
        students: 0,
        appointments: 0,
        submissions: 0,
        files: 0,
        storageObjects: expect.any(Number),
        stateFiles: 1,
      },
    });
    expect(partial.residue.storageObjects).toBeGreaterThan(0);

    await expect(cleanup()).resolves.toEqual(expect.objectContaining({
      students: 0,
      appointments: 0,
      submissions: 0,
      files: 0,
      storageObjects: 0,
      chooserArtifacts: 0,
      stateFiles: 0,
    }));
  });

  it("discovers an orphan cleanup intent under a manifest-owned submission directory", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const orphanStorageKey = `${STUDENT_RESULT_EDITING_FIXTURE.submissionIds.laboratoryDraft}/orphaned-edit-copy.copy`;
    const orphanPath = assertStudentResultEditingStorageTarget(STORAGE_ROOT, orphanStorageKey);
    await mkdir(dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, "%PDF-1.7\norphaned edit copy", "utf8");
    await pool.query(
      `INSERT INTO student_result_storage_cleanup_intents (storage_key,not_before)
       VALUES ($1,NOW() + INTERVAL '1 day')`,
      [orphanStorageKey],
    );

    try {
      await cleanup();
      expect((await pool.query(
        "SELECT COUNT(*)::int AS count FROM student_result_storage_cleanup_intents WHERE storage_key=$1",
        [orphanStorageKey],
      )).rows[0].count).toBe(0);
      expect(await exists(orphanPath)).toBe(false);
    } finally {
      await pool.query(
        "DELETE FROM student_result_storage_cleanup_intents WHERE storage_key=$1",
        [orphanStorageKey],
      );
      await rm(orphanPath, { force: true });
    }
  });

  it("deletes only manifest-addressed data and proves final status has zero residue", async () => {
    const sentinelPath = assertStudentResultEditingStorageTarget(STORAGE_ROOT, SENTINEL_STORAGE_KEY);
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, "%PDF-1.7\nunrelated sentinel", "utf8");
    await pool.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'UNRELATED_BROWSER_SENTINEL','acceptance_fixture','unrelated','{}'::jsonb)`,
      [SENTINEL_AUDIT_ID, STUDENT_RESULT_EDITING_FIXTURE.adminUserId],
    );
    await prepareStudentResultEditingFixture(pool, identity);

    const cleanupProof = await cleanup();
    const status = await getStudentResultEditingFixtureStatus(pool, identity);

    expect(cleanupProof).toEqual(status.residue);
    expect(status).toMatchObject({ phase: "ABSENT", residue: cleanupProof });
    expect(assertZeroStudentResultEditingResidue(status.residue)).toBe(status.residue);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=$1", [
      SENTINEL_AUDIT_ID,
    ])).rows[0].count).toBe(1);
    expect(await exists(sentinelPath)).toBe(true);
  });
});
