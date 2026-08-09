// @vitest-environment node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Pool } from "pg";
import sharp from "sharp";
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
const SUBSTRING_AUDIT_ID = "be180000-0000-4000-8000-000000000902";
const TAMPERED_AUDIT_ID = "be180000-0000-4000-8000-000000000903";
const STRUCTURED_AUDIT_ID = "be180000-0000-4000-8000-000000000904";
const CRASH_WINDOW_AUDIT_ID = "be180000-0000-4000-8000-000000000907";
const SENTINEL_STORAGE_KEY = "browser-student-result-editing-unrelated/sentinel.pdf";
const TAMPERED_STORAGE_KEY = "be180000-0000-4000-8000-000000000101/tampered-unrelated.pdf";
const POST_DATABASE_TAMPER_STORAGE_KEY = "be180000-0000-4000-8000-000000000906/unrelated-after-db.pdf";
const REPARSE_TARGET = resolve(".data/browser-student-result-editing-reparse-target");

async function createDirectoryLink(target: string, path: string) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

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
    await pool.query("DELETE FROM audit_logs WHERE id=ANY($1::uuid[])", [[
      SENTINEL_AUDIT_ID,
      SUBSTRING_AUDIT_ID,
      TAMPERED_AUDIT_ID,
      STRUCTURED_AUDIT_ID,
      CRASH_WINDOW_AUDIT_ID,
    ]]);
    await Promise.all([
      SENTINEL_STORAGE_KEY,
      TAMPERED_STORAGE_KEY,
      POST_DATABASE_TAMPER_STORAGE_KEY,
    ].map((key) => rm(assertStudentResultEditingStorageTarget(STORAGE_ROOT, key), { force: true })));
    await rm(REPARSE_TARGET, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.query("DELETE FROM audit_logs WHERE id=ANY($1::uuid[])", [[
        SENTINEL_AUDIT_ID,
        SUBSTRING_AUDIT_ID,
        TAMPERED_AUDIT_ID,
        STRUCTURED_AUDIT_ID,
        CRASH_WINDOW_AUDIT_ID,
      ]]);
      await Promise.all([
        SENTINEL_STORAGE_KEY,
        TAMPERED_STORAGE_KEY,
        POST_DATABASE_TAMPER_STORAGE_KEY,
      ].map((key) => rm(assertStudentResultEditingStorageTarget(STORAGE_ROOT, key), { force: true })));
      await rm(REPARSE_TARGET, { recursive: true, force: true });
      await pool.end();
    }
  });

  it("rejects tampered manifest additions and preserves unrelated database and storage objects", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const originalState = await readFile(STATE_FILE, "utf8");
    const state = JSON.parse(originalState) as {
      ownershipDigest: string;
      manifest: { owned: { auditLogIds: string[]; storageKeys: string[] } };
    };
    const unrelatedPath = assertStudentResultEditingStorageTarget(STORAGE_ROOT, TAMPERED_STORAGE_KEY);
    await mkdir(dirname(unrelatedPath), { recursive: true });
    await writeFile(unrelatedPath, "unrelated storage object", "utf8");
    await pool.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'UNRELATED_TAMPER_TARGET','unrelated','unrelated','{}'::jsonb)`,
      [TAMPERED_AUDIT_ID, STUDENT_RESULT_EDITING_FIXTURE.adminUserId],
    );
    state.manifest.owned.auditLogIds.push(TAMPERED_AUDIT_ID);
    state.manifest.owned.storageKeys.push(TAMPERED_STORAGE_KEY);
    state.ownershipDigest = createHash("sha256")
      .update(JSON.stringify(state.manifest.owned))
      .digest("hex");
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    try {
      await expect(cleanup()).rejects.toThrow(/ownership|integrity|tamper/i);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1", [
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
      ])).rows[0].count).toBe(1);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=$1", [
        TAMPERED_AUDIT_ID,
      ])).rows[0].count).toBe(1);
      expect(await readFile(unrelatedPath, "utf8")).toBe("unrelated storage object");
    } finally {
      if (await exists(STATE_FILE)) {
        await writeFile(STATE_FILE, originalState, "utf8");
        await cleanup();
      }
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [TAMPERED_AUDIT_ID]);
      await rm(unrelatedPath, { force: true });
    }
  });

  it("preserves unrelated storage from a forged DATABASE_DELETED state with a recomputed digest", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const originalState = await readFile(STATE_FILE, "utf8");
    const state = JSON.parse(originalState) as {
      phase: string;
      ownershipDigest: string;
      manifest: { owned: { submissionIds: string[]; storageKeys: string[] } };
    };
    const unrelatedPath = assertStudentResultEditingStorageTarget(
      STORAGE_ROOT,
      POST_DATABASE_TAMPER_STORAGE_KEY,
    );
    await mkdir(dirname(unrelatedPath), { recursive: true });
    await writeFile(unrelatedPath, "preserve forged post-database target", "utf8");
    state.phase = "DATABASE_DELETED";
    state.manifest.owned.submissionIds.push("be180000-0000-4000-8000-000000000906");
    state.manifest.owned.storageKeys.push(POST_DATABASE_TAMPER_STORAGE_KEY);
    state.ownershipDigest = createHash("sha256")
      .update(JSON.stringify(state.manifest.owned))
      .digest("hex");
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    try {
      await expect(cleanup()).rejects.toThrow(/residue|ownership|database/i);
      expect(await readFile(unrelatedPath, "utf8")).toBe("preserve forged post-database target");
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1", [
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
      ])).rows[0].count).toBe(1);
    } finally {
      if (await exists(STATE_FILE)) {
        await writeFile(STATE_FILE, originalState, "utf8");
        await cleanup();
      }
      await rm(unrelatedPath, { force: true });
    }
  });

  it("preserves an unrelated audit whose metadata merely contains the fixture student number", async () => {
    await pool.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'UNRELATED_SUBSTRING_COLLISION','unrelated','unrelated',
               jsonb_build_object('note',$3::text))`,
      [
        SUBSTRING_AUDIT_ID,
        STUDENT_RESULT_EDITING_FIXTURE.adminUserId,
        `prefix ${STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber} suffix`,
      ],
    );
    try {
      await prepareStudentResultEditingFixture(pool, identity);
      await pool.query(
        `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
         VALUES ($1,NULL,'STUDENT_RESULT_EDIT_CANCELLED','student_result_submission',$2,
                 jsonb_build_object('appointmentId',$3::text,'basedOnSubmissionId',$4::text))`,
        [
          STRUCTURED_AUDIT_ID,
          "be180000-0000-4000-8000-000000000905",
          STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
          STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
        ],
      );
      await cleanup();
      expect((await pool.query("SELECT action FROM audit_logs WHERE id=$1", [SUBSTRING_AUDIT_ID])).rows)
        .toEqual([{ action: "UNRELATED_SUBSTRING_COLLISION" }]);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE id=$1", [
        STRUCTURED_AUDIT_ID,
      ])).rows[0].count).toBe(0);
    } finally {
      if (await exists(STATE_FILE)) await cleanup();
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [SUBSTRING_AUDIT_ID]);
    }
  });

  it("refuses a junction or symbolic-link escape while preparing private storage", async () => {
    const submissionDirectory = dirname(assertStudentResultEditingStorageTarget(
      STORAGE_ROOT,
      STUDENT_RESULT_EDITING_FIXTURE.initialStorageKeys.laboratory,
    ));
    await rm(submissionDirectory, { recursive: true, force: true });
    await mkdir(dirname(submissionDirectory), { recursive: true });
    await mkdir(REPARSE_TARGET, { recursive: true });
    await createDirectoryLink(REPARSE_TARGET, submissionDirectory);
    try {
      await expect(prepareStudentResultEditingFixture(pool, identity))
        .rejects.toThrow(/junction|symbolic|reparse|redirect/i);
      expect(await exists(resolve(REPARSE_TARGET, "be180000-0000-4000-8000-000000000201.pdf")))
        .toBe(false);
    } finally {
      if (await exists(STATE_FILE)) await cleanup();
      await rmdir(submissionDirectory).catch(() => undefined);
      await rm(REPARSE_TARGET, { recursive: true, force: true });
    }
  });

  it("refuses a newly introduced junction or symbolic link before cleanup deletes database rows", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const submissionDirectory = dirname(assertStudentResultEditingStorageTarget(
      STORAGE_ROOT,
      STUDENT_RESULT_EDITING_FIXTURE.initialStorageKeys.laboratory,
    ));
    await rm(submissionDirectory, { recursive: true, force: true });
    await mkdir(REPARSE_TARGET, { recursive: true });
    const outsideSentinel = resolve(REPARSE_TARGET, "outside-sentinel.txt");
    await writeFile(outsideSentinel, "preserve me", "utf8");
    await createDirectoryLink(REPARSE_TARGET, submissionDirectory);
    try {
      await expect(cleanup()).rejects.toThrow(/junction|symbolic|reparse|redirect/i);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE student_number=$1", [
        STUDENT_RESULT_EDITING_FIXTURE.student.studentNumber,
      ])).rows[0].count).toBe(1);
      expect(await readFile(outsideSentinel, "utf8")).toBe("preserve me");
    } finally {
      await rmdir(submissionDirectory).catch(() => undefined);
      await rm(REPARSE_TARGET, { recursive: true, force: true });
      if (await exists(STATE_FILE)) await cleanup();
    }
  });

  it("creates PDF, PNG, and JPEG chooser artifacts accepted by real parsers and decoders", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const pdfBytes = await readFile(STUDENT_RESULT_EDITING_FIXTURE.chooserArtifacts.pdf);
    const document = await getDocument({
      data: new Uint8Array(pdfBytes),
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    try {
      expect(document.numPages).toBe(1);
    } finally {
      await document.destroy();
    }
    await expect(sharp(STUDENT_RESULT_EDITING_FIXTURE.chooserArtifacts.png).metadata())
      .resolves.toMatchObject({ format: "png", width: 1, height: 1 });
    await expect(sharp(STUDENT_RESULT_EDITING_FIXTURE.chooserArtifacts.jpeg).metadata())
      .resolves.toMatchObject({ format: "jpeg", width: 1, height: 1 });
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
      phase: "MANIFESTED",
      residue: {
        students: 1,
        appointments: 2,
        submissions: 2,
        files: 2,
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

  it("reports a STORAGE_DELETED crash window after database deletion removed dynamic ownership", async () => {
    await prepareStudentResultEditingFixture(pool, identity);
    const state = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
      phase: string;
      ownershipDigest: string;
      manifest: {
        chooserArtifacts: Record<string, string>;
        owned: { auditLogIds: string[] };
      };
    };
    const artifacts = await Promise.all(Object.values(state.manifest.chooserArtifacts).map(
      async (path) => ({ path, bytes: await readFile(path) }),
    ));
    await pool.query(
      `INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'STUDENT_RESULT_SUBMISSION_INVALIDATED','student_result_submission',$3,
               jsonb_build_object('appointmentId',$4::text))`,
      [
        CRASH_WINDOW_AUDIT_ID,
        STUDENT_RESULT_EDITING_FIXTURE.adminUserId,
        STUDENT_RESULT_EDITING_FIXTURE.submissionIds.physicalExamOfficial,
        STUDENT_RESULT_EDITING_FIXTURE.appointmentIds.physicalExam,
      ],
    );
    await cleanup();

    state.phase = "STORAGE_DELETED";
    state.manifest.owned.auditLogIds.push(CRASH_WINDOW_AUDIT_ID);
    state.ownershipDigest = createHash("sha256")
      .update(JSON.stringify(state.manifest.owned))
      .digest("hex");
    await mkdir(STATE_DIRECTORY, { recursive: true });
    for (const artifact of artifacts) {
      await mkdir(dirname(artifact.path), { recursive: true });
      await writeFile(artifact.path, artifact.bytes);
    }
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    try {
      const status = await getStudentResultEditingFixtureStatus(pool, identity);
      expect(status).toMatchObject({
        phase: "STORAGE_DELETED",
        residue: {
          students: 0,
          appointments: 0,
          submissions: 0,
          files: 0,
          auditLogs: 0,
          storageObjects: 0,
          chooserArtifacts: 4,
          stateFiles: 1,
        },
      });
    } finally {
      if (await exists(STATE_FILE)) await cleanup();
      await pool.query("DELETE FROM audit_logs WHERE id=$1", [CRASH_WINDOW_AUDIT_ID]);
    }
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
